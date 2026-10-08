/**
 * auditSchedule.js — the four audits every tree goes through.
 *
 *   Planting → Audit 1 → (+3 months) → Audit 2 → (+3 months) → Audit 3 → (+3 months) → Audit 4
 *
 * Audit 1 opens when the planting is approved (services/treeTasks.js). From then on:
 *   • approving Audit n writes a row to audit_schedule for Audit n+1, due 3 months
 *     after that approval (onAuditApproved) — unless the tree was found dead/missing,
 *     in which case the cycle stops and the tree shows on the "Dead & missing" list;
 *   • runDue turns every schedule row whose date has come into a normal audit task
 *     (audit_round, due_date, assigned to the partner as a placeholder — the partner
 *     hands it to a field operator, exactly like Audit 1).
 * Nothing here touches the mobile app: the next audit is just another task row.
 *
 * Needs the audit_schedule table (backend/sql/audit_schedule.sql). Until it exists
 * every function is a harmless no-op.
 */
const supabase = require('../supabaseClient')
const treeTasks = require('./treeTasks')
const { isMissingSchema } = require('./treeHistory')

const MAX_ROUND = 4
const INTERVAL_MONTHS = Number(process.env.AUDIT_INTERVAL_MONTHS) > 0 ? Number(process.env.AUDIT_INTERVAL_MONTHS) : 3
// Testing only: set AUDIT_INTERVAL_MINUTES to wait minutes instead of months.
const INTERVAL_MINUTES = Number(process.env.AUDIT_INTERVAL_MINUTES) > 0 ? Number(process.env.AUDIT_INTERVAL_MINUTES) : 0

/** Calendar-safe month add: 31 Jan + 1 month = 28/29 Feb, not 3 Mar. */
function addMonths(date, months) {
  const d = new Date(date.getTime())
  const day = d.getUTCDate()
  d.setUTCDate(1)
  d.setUTCMonth(d.getUTCMonth() + months)
  const daysInTarget = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()
  d.setUTCDate(Math.min(day, daysInTarget))
  return d
}

/** When the audit after an approval made at `from` is due. */
const nextDue = from => INTERVAL_MINUTES ? new Date(from.getTime() + INTERVAL_MINUTES * 60000) : addMonths(from, INTERVAL_MONTHS)

const isAudit = t => treeTasks.typeOf(t) === treeTasks.AUDIT
const isGone = s => s === 'dead' || s === 'missing'

/** Every row of a query, 1000 at a time (one request returns at most 1000). `make` builds the query fresh per page. */
async function allRows(make) {
  const out = []
  for (let f = 0; ; f += 1000) {
    const { data, error } = await make().order('id').range(f, f + 999)
    if (error) return { data: out, error }
    out.push(...(data || []))
    if (!data || data.length < 1000) return { data: out }
  }
}

// ── Reading a tree's audits ──────────────────────────────────────────────────

/** Audit rounds saved by the app for a tree (on it or on its field captures), oldest round first. */
async function monitoringFor(treeId, captureIds = []) {
  const ids = [...new Set([treeId, ...captureIds].filter(Boolean))]
  const { data, error } = await supabase.from('tree_monitoring_records').select('*').in('tree_record_id', ids)
  if (error) { if (!isMissingSchema(error)) console.error('[auditSchedule] monitoring:', error.message); return [] }
  return (data || []).sort((a, b) => (Number(a.monitoring_round) || 0) - (Number(b.monitoring_round) || 0)
    || String(a.submitted_at).localeCompare(String(b.submitted_at)))
}

/** Is the tree dead/missing as of audit `round`? Looks at that round's record, else the latest one. */
async function survivalOf(treeId, captureIds, round) {
  const rows = await monitoringFor(treeId, captureIds)
  const record = [...rows].reverse().find(r => Number(r.monitoring_round) === round) || rows[rows.length - 1]
  if (record?.survival_status) return String(record.survival_status).toLowerCase()
  const { data: tree } = await supabase.from('tree_records').select('tree_condition, health_status').eq('id', treeId).maybeSingle()
  if (String(tree?.tree_condition || '').toLowerCase() === 'dead' || String(tree?.health_status || '').toLowerCase() === 'dead') return 'dead'
  return null
}

/** 1..4: the task's own audit_round, otherwise its place among the tree's audit tasks. */
async function roundOfTask(task) {
  const r = Number(task.audit_round)
  if (r > 0) return r
  const { data } = await supabase.from('tasks').select('id, created_at, task_type').eq('tree_id', task.tree_id)
  const audits = (data || []).filter(isAudit).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
  const i = audits.findIndex(t => t.id === task.id)
  return i >= 0 ? i + 1 : 1
}

async function captureIdsOf(treeId) {
  const { data } = await supabase.from('tasks').select('capture_tree_id').eq('tree_id', treeId).not('capture_tree_id', 'is', null)
  return (data || []).map(r => r.capture_tree_id)
}

// ── Approval → schedule the next audit ───────────────────────────────────────

/**
 * An audit task was approved. Plans Audit n+1 for 3 months from now, or stops the
 * cycle (4th audit done / tree dead or missing). Safe to call twice for one approval.
 */
async function onAuditApproved(task, { approvedAt = new Date() } = {}) {
  if (!task?.tree_id || !isAudit(task)) return { skipped: 'not an audit' }
  const round = await roundOfTask(task)
  if (!(Number(task.audit_round) > 0)) {
    await supabase.from('tasks').update({ audit_round: round }).eq('id', task.id)   // label the legacy task
  }
  if (round >= MAX_ROUND) return { complete: true, round }

  const next = round + 1
  const gone = await survivalOf(task.tree_id, await captureIdsOf(task.tree_id), round)
  // The schedule page lists by project, so a task without one borrows its tree's.
  let projectId = task.project_id || null
  if (!projectId) {
    const { data: tree } = await supabase.from('tree_records').select('project_id').eq('id', task.tree_id).maybeSingle()
    projectId = tree?.project_id || null
  }
  const base = {
    tree_id: task.tree_id, project_id: projectId, round: next,
    source_task_id: String(task.id), partner_user_id: task.created_by || null,
  }
  const row = isGone(gone)
    ? { ...base, status: 'cancelled', cancel_reason: gone, due_at: nextDue(approvedAt).toISOString() }
    : { ...base, status: 'pending', cancel_reason: null, due_at: nextDue(approvedAt).toISOString() }

  const { data: existing, error } = await supabase.from('audit_schedule').select('id, status').eq('tree_id', task.tree_id).eq('round', next).maybeSingle()
  if (error) {
    if (isMissingSchema(error)) return { skipped: 'audit_schedule table not created yet', ...(isGone(gone) ? { stopped: gone, round } : {}) }
    throw error
  }
  if (existing?.status === 'created') return { exists: true, next, ...(isGone(gone) ? { stopped: gone, round } : {}) }
  const res = existing
    ? await supabase.from('audit_schedule').update(row).eq('id', existing.id)
    : await supabase.from('audit_schedule').insert(row)
  if (res.error) throw res.error
  return isGone(gone) ? { stopped: gone, round } : { scheduled: next, dueAt: row.due_at }
}

// ── Due date reached → create the audit task ─────────────────────────────────

async function projectOwner(projectId) {
  if (!projectId) return null
  const { data } = await supabase.from('project_submissions').select('submitted_by').eq('project_id', projectId).eq('status', 'approved').limit(1).maybeSingle()
  return data?.submitted_by || null
}

/** Creates the audit task for every schedule row whose date has come. Returns the tasks created. */
async function runDue({ limit = 100 } = {}) {
  const { autoCreateVerificationTasks } = require('./partnerHelpers')
  const { data: due, error } = await supabase.from('audit_schedule').select('*')
    .eq('status', 'pending').lte('due_at', new Date().toISOString()).order('due_at', { ascending: true }).limit(limit)
  if (error) { if (!isMissingSchema(error)) console.error('[auditSchedule] runDue:', error.message); return [] }

  const made = []
  for (const row of due || []) {
    // Claim the row first so two runs at once cannot both create the task.
    const { data: claimed } = await supabase.from('audit_schedule')
      .update({ status: 'created', created_task_at: new Date().toISOString() }).eq('id', row.id).eq('status', 'pending').select('id')
    if (!claimed?.length) continue
    const release = () => supabase.from('audit_schedule').update({ status: 'pending', created_task_at: null }).eq('id', row.id)
    try {
      const { data: tree } = await supabase.from('tree_records')
        .select('id, tree_id, species, latitude, longitude, project_id, tree_condition, health_status').eq('id', row.tree_id).maybeSingle()
      if (!tree) { await supabase.from('audit_schedule').update({ status: 'cancelled', cancel_reason: 'tree removed' }).eq('id', row.id); continue }
      if (String(tree.tree_condition || '').toLowerCase() === 'dead' || String(tree.health_status || '').toLowerCase() === 'dead') {
        await supabase.from('audit_schedule').update({ status: 'cancelled', cancel_reason: 'dead' }).eq('id', row.id)
        continue
      }
      const { data: already } = await supabase.from('tasks').select('id').eq('tree_id', tree.id).eq('audit_round', row.round).limit(1)
      if (already?.length) { await supabase.from('audit_schedule').update({ created_task_id: String(already[0].id) }).eq('id', row.id); continue }

      const partner = row.partner_user_id || await projectOwner(row.project_id || tree.project_id)
      if (!partner) { console.error('[auditSchedule] no partner for tree', tree.id); await release(); continue }
      const created = await autoCreateVerificationTasks({
        trees: [{ id: tree.id, code: tree.tree_id, species: tree.species, latitude: tree.latitude, longitude: tree.longitude }],
        projectId: tree.project_id, partnerUserId: partner, anyOwner: true, taskType: 'audit',
        auditRound: row.round, dueDate: row.due_at,
      })
      if (!created[0]) { await release(); continue }
      await supabase.from('audit_schedule').update({ created_task_id: String(created[0].id) }).eq('id', row.id)
      made.push({ ...created[0], tree_id: tree.id, round: row.round })
    } catch (e) {
      console.error('[auditSchedule] could not open audit', row.id, e.message)
      await release()
    }
  }
  if (made.length) console.log(`[auditSchedule] opened ${made.length} audit task(s)`)
  return made
}

let lastRun = 0
let running = null
/** runDue for read paths and timers: throttled, never throws, never awaited by a page. */
function runDueQuietly(force = false) {
  if (running) return running
  if (!force && Date.now() - lastRun < 60000) return Promise.resolve([])
  lastRun = Date.now()
  running = runDue().catch(e => { console.error('[auditSchedule]', e.message); return [] }).finally(() => { running = null })
  return running
}

// ── Lists for the web panel ──────────────────────────────────────────────────

/**
 * Audits still to come, soonest first: planned ones that have not opened yet (state "planned"),
 * and Audit 2-4 tasks that are already open but not done (state "open").
 */
async function upcoming(projectIds) {
  const ids = [...new Set((projectIds || []).filter(Boolean))]
  if (!ids.length) return []

  const { data: planned, error } = await allRows(() => supabase.from('audit_schedule').select('*').in('project_id', ids).eq('status', 'pending'))
  if (error && !isMissingSchema(error)) console.error('[auditSchedule] upcoming:', error.message)

  const { data: openTasks, error: taskErr } = await allRows(() => supabase.from('tasks')
    .select('id, task_code, tree_id, project_id, audit_round, task_type, status, due_date, created_at, assignee_id')
    .in('project_id', ids).gte('audit_round', 2).in('status', ['assigned', 'in_progress']))
  if (taskErr) console.error('[auditSchedule] open audits:', taskErr.message)
  const open = (openTasks || []).filter(isAudit)

  const trees = await treesById([...(planned || []).map(r => r.tree_id), ...open.map(t => t.tree_id)])
  const items = [
    ...(planned || []).map(r => ({
      id: r.id, state: 'planned', round: r.round, dueAt: r.due_at, plannedAt: r.created_at, taskCode: null,
      treeId: r.tree_id, projectId: r.project_id,
    })),
    ...open.filter(t => trees[t.tree_id]).map(t => ({
      id: String(t.id), state: 'open', round: Number(t.audit_round), dueAt: t.due_date || t.created_at, plannedAt: t.created_at,
      taskCode: t.task_code || null, taskStatus: t.status, treeId: t.tree_id, projectId: t.project_id || trees[t.tree_id]?.project_id,
    })),
  ]
  return items
    .map(i => ({ ...i, treeCode: codeOf(trees[i.treeId]), species: trees[i.treeId]?.species || null }))
    .sort((x, y) => String(x.dueAt).localeCompare(String(y.dueAt)))
}

async function treesById(ids) {
  const out = {}
  const list = [...new Set((ids || []).filter(Boolean))]
  for (let i = 0; i < list.length; i += 300) {
    const { data } = await supabase.from('tree_records').select('id, tree_id, species, project_id, tree_condition, health_status, latitude, longitude').in('id', list.slice(i, i + 300))
    for (const t of data || []) out[t.id] = t
  }
  return out
}
const codeOf = t => t ? (t.tree_id || `TREE-${String(t.id).slice(0, 8).toUpperCase()}`) : null

/** Trees found dead or missing in an audit (or marked dead) — the cycle stops for these. */
async function deadOrMissing(projectIds) {
  const ids = [...new Set((projectIds || []).filter(Boolean))]
  if (!ids.length) return []
  const captures = await treeTasks.captureTreeIds()
  const trees = []
  for (let f = 0; ; f += 1000) {
    const { data, error } = await supabase.from('tree_records')
      .select('id, tree_id, species, project_id, tree_condition, health_status, survey_date, submitted_at, notes').in('project_id', ids).order('id').range(f, f + 999)
    if (error) throw error
    trees.push(...(data || []))
    if (!data || data.length < 1000) break
  }
  const real = trees.filter(t => !captures.has(t.id))
  const byId = Object.fromEntries(real.map(t => [t.id, t]))

  // The field app saves audits on its own capture of the tree — map those back.
  const capToTree = {}
  for (let f = 0; ; f += 1000) {
    const { data } = await supabase.from('tasks').select('tree_id, capture_tree_id').in('project_id', ids).not('capture_tree_id', 'is', null).order('id').range(f, f + 999)
    for (const t of data || []) if (t.tree_id) capToTree[t.capture_tree_id] = t.tree_id
    if (!data || data.length < 1000) break
  }
  const keys = [...new Set([...real.map(t => t.id), ...Object.keys(capToTree)])]
  const latest = {}                       // tree id → latest audit record
  for (let i = 0; i < keys.length; i += 300) {
    // 300 trees can hold more than 1000 audit rounds.
    const { data, error } = await allRows(() => supabase.from('tree_monitoring_records').select('*').in('tree_record_id', keys.slice(i, i + 300)))
    if (error) { if (!isMissingSchema(error)) console.error('[auditSchedule] dead list:', error.message); break }
    for (const r of data || []) {
      const treeId = byId[r.tree_record_id] ? r.tree_record_id : capToTree[r.tree_record_id]
      if (!treeId || !byId[treeId]) continue
      const cur = latest[treeId]
      const newer = !cur || (Number(r.monitoring_round) || 0) > (Number(cur.monitoring_round) || 0)
        || ((Number(r.monitoring_round) || 0) === (Number(cur.monitoring_round) || 0) && String(r.submitted_at) > String(cur.submitted_at))
      if (newer) latest[treeId] = r
    }
  }

  const names = {}
  const personIds = [...new Set(Object.values(latest).map(r => r.user_id).filter(Boolean))]
  if (personIds.length) {
    const { data } = await supabase.from('profiles').select('auth_id, display_name').in('auth_id', personIds)
    for (const p of data || []) names[p.auth_id] = p.display_name
  }
  const { data: projRows } = await supabase.from('projects').select('id, name').in('id', ids)
  const projectName = Object.fromEntries((projRows || []).map(p => [p.id, p.name]))

  const out = []
  for (const t of real) {
    const r = latest[t.id]
    let status = r?.survival_status ? String(r.survival_status).toLowerCase() : null
    if (!isGone(status)) {
      // No audit says dead/missing: fall back on how the tree itself is marked.
      if (r) continue                                   // the latest audit says it is alive
      if (String(t.tree_condition || '').toLowerCase() === 'dead' || String(t.health_status || '').toLowerCase() === 'dead') status = 'dead'
      else continue
    }
    out.push({
      treeId: t.id, treeCode: codeOf(t), species: t.species || null,
      projectId: t.project_id, project: projectName[t.project_id] || t.project_id,
      status, round: r ? Number(r.monitoring_round) || 1 : null,
      foundAt: r?.survey_date || r?.submitted_at || t.survey_date || t.submitted_at || null,
      foundBy: (r && (names[r.user_id] || r.surveyor)) || null,
      notes: r?.notes || t.notes || null,
    })
  }
  return out.sort((a, b) => String(b.foundAt).localeCompare(String(a.foundAt)))
}

// ── One-time catch-up for trees that were audited before this existed ────────

/**
 * Labels existing audit tasks (audit_round) and plans the next audit for trees whose
 * audit is already approved (openNow = open that next audit today instead of in 3 months). dry=true only reports. Trees with more than one audit task
 * are listed for a human to look at and are not touched.
 */
async function backfill({ dry = true, openNow = false } = {}) {
  await treeTasks.reconcileCaptureTasks({ force: true })
  const all = []
  for (let f = 0; ; f += 1000) {
    const { data, error } = await supabase.from('tasks').select('*').not('tree_id', 'is', null).order('id').range(f, f + 999)
    if (error) throw error
    all.push(...(data || []))
    if (!data || data.length < 1000) break
  }
  const byTree = {}
  for (const t of all.filter(isAudit)) (byTree[t.tree_id] ||= []).push(t)
  const trees = await treesById(Object.keys(byTree))

  const { data: sched, error: schedErr } = await allRows(() => supabase.from('audit_schedule').select('id, tree_id, round'))
  const schedMissing = !!schedErr && isMissingSchema(schedErr)
  if (schedErr && !schedMissing) throw schedErr
  const planned = new Set((sched || []).map(r => `${r.tree_id}:${r.round}`))

  const report = { dry, schedulingTableReady: !schedMissing, label: [], schedule: [], stop: [], complete: [], needsReview: [], noTree: 0 }
  for (const [treeId, list] of Object.entries(byTree)) {
    list.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
    // Hand-made or test tasks whose tree record no longer exists: nothing to audit.
    if (!trees[treeId]) { report.noTree += list.length; continue }
    const code = codeOf(trees[treeId])
    if (list.length > 1) {
      report.needsReview.push({ treeId, treeCode: code, tasks: list.map(t => ({ id: t.id, status: t.status, createdAt: t.created_at, auditRound: t.audit_round })) })
      continue
    }
    const t = list[0]
    const round = Number(t.audit_round) > 0 ? Number(t.audit_round) : 1
    if (!(Number(t.audit_round) > 0)) report.label.push({ taskId: t.id, treeCode: code, round })
    if (t.status !== 'approved') continue
    if (round >= MAX_ROUND) { report.complete.push({ treeCode: code }); continue }

    const gone = await survivalOf(treeId, await captureIdsOf(treeId), round)
    const next = round + 1
    if (planned.has(`${treeId}:${next}`)) continue
    const approvedAt = new Date(t.reviewed_at || t.completed_at || t.created_at)
    // openNow: the audit that is already approved moves straight on to the next round instead of waiting 3 months.
    const dueAt = openNow ? new Date() : nextDue(approvedAt)
    const item = { treeId, treeCode: code, projectId: t.project_id || trees[treeId].project_id || null, nextRound: next, approvedAt: approvedAt.toISOString(), dueAt: dueAt.toISOString(), alreadyDue: dueAt <= new Date() }
    if (isGone(gone)) { report.stop.push({ ...item, reason: gone }); continue }
    report.schedule.push(item)

    if (!dry && !schedMissing) {
      const { error } = await supabase.from('audit_schedule').insert({
        tree_id: treeId, project_id: item.projectId, round: next, due_at: item.dueAt,
        source_task_id: String(t.id), partner_user_id: t.created_by || null, status: 'pending',
      })
      if (error) console.error('[auditSchedule] backfill insert:', error.message)
    }
  }
  if (!dry) {
    for (const l of report.label) await supabase.from('tasks').update({ audit_round: l.round }).eq('id', l.taskId)
    if (!schedMissing) for (const s of report.stop) {
      await supabase.from('audit_schedule').insert({
        tree_id: s.treeId, project_id: s.projectId || null, round: s.nextRound, due_at: s.dueAt, status: 'cancelled', cancel_reason: s.reason,
      })
    }
    if (!schedMissing) report.opened = (await runDue({ limit: 500 })).length
  }
  return report
}

/** Everything the Audit schedule page shows, for the given projects. */
async function overview(projectIds) {
  const ids = [...new Set((projectIds || []).filter(Boolean))]
  const [up, gone, projRes] = await Promise.all([
    upcoming(ids),
    deadOrMissing(ids),
    ids.length ? supabase.from('projects').select('id, name').in('id', ids) : Promise.resolve({ data: [] }),
  ])
  const name = Object.fromEntries((projRes.data || []).map(p => [p.id, p.name]))
  return {
    total: MAX_ROUND,
    intervalMonths: INTERVAL_MONTHS,
    upcoming: up.map(u => ({ ...u, project: name[u.projectId] || u.projectId })),
    deadOrMissing: gone,
  }
}

module.exports = {
  MAX_ROUND, INTERVAL_MONTHS, INTERVAL_MINUTES, addMonths, nextDue,
  onAuditApproved, runDue, runDueQuietly, upcoming, deadOrMissing, overview, backfill,
}
