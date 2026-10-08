/**
 * activityReport.js — what the field app has been doing, as one newest-first list.
 *
 * Trees added, tasks (created / completed / approved / rejected), audit rounds, the land
 * fence and the audit schedule, for the given projects and dates. Used by the partner's
 * Activity page (their own projects) and the admin's (all projects).
 */
const supabase = require('../supabaseClient')
const treeTasks = require('./treeTasks')
const { MAX_ROUND } = require('./auditSchedule')

const ACTIVITY_CAP = 5000
const missingSchema = e => !!e && (['PGRST205', 'PGRST204', '42P01', '42703'].includes(e.code) || /does not exist|schema cache/i.test(e.message || ''))

/** fromRaw / toRaw: YYYY-MM-DD (inclusive); default the last 30 days. */
async function activityFor({ projectIds, from: fromRaw, to: toRaw }) {
  if (!projectIds || projectIds.length === 0) return { events: [], truncated: false }

  const day = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null
  const to = day(toRaw) || new Date().toISOString().slice(0, 10)
  const from = day(fromRaw) || new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10)
  const startMs = new Date(`${from}T00:00:00`).getTime()
  const endMs = new Date(`${to}T23:59:59.999`).getTime()
  const inRange = iso => { const t = iso ? new Date(iso).getTime() : NaN; return Number.isFinite(t) && t >= startMs && t <= endMs }

  const captures = await treeTasks.captureTreeIds()

  // Every tree of these projects (needed to name trees on task and audit events).
  const trees = []
  for (let f = 0; ; f += 1000) {
    const { data, error } = await supabase
      .from('tree_records')
      .select('id, tree_id, species, quantity, event_type, user_id, project_id, submitted_at')
      .in('project_id', projectIds)
      .order('id')
      .range(f, f + 999)
    if (error) throw error
    trees.push(...(data || []))
    if (!data || data.length < 1000) break
  }
  const treeById = Object.fromEntries(trees.map(t => [t.id, t]))
  const codeOf = t => t ? (t.tree_id || `TREE-${String(t.id).slice(0, 8).toUpperCase()}`) : null

  // Tasks (all types) for these projects.
  const tasks = []
  for (let f = 0; ; f += 1000) {
    const { data, error } = await supabase.from('tasks').select('*').in('project_id', projectIds).order('id').range(f, f + 999)
    if (error) { console.warn('[partner/activity] tasks:', error.message); break }
    tasks.push(...(data || []))
    if (!data || data.length < 1000) break
  }
  const capToTree = {}
  const capToTask = {}
  for (const t of tasks) if (t.capture_tree_id && t.tree_id) { capToTree[t.capture_tree_id] = t.tree_id; capToTask[t.capture_tree_id] = t.task_code || null }

  // Audit rounds saved by the app, within the dates.
  const monitorIds = [...new Set([...trees.map(t => t.id), ...Object.keys(capToTree)])]
  // Same instants as inRange (server time), so the database and the filter below agree on the day edges.
  const startIso = new Date(startMs).toISOString()
  const endIso = new Date(endMs).toISOString()
  const rounds = []
  chunks: for (let i = 0; i < monitorIds.length; i += 300) {
    // 300 trees can hold more than one 1000-row page of audit rounds.
    for (let f = 0; ; f += 1000) {
      const { data, error } = await supabase
        .from('tree_monitoring_records').select('*')
        .in('tree_record_id', monitorIds.slice(i, i + 300))
        .gte('submitted_at', startIso).lte('submitted_at', endIso)
        .order('id').range(f, f + 999)
      if (error) { if (!missingSchema(error)) console.warn('[partner/activity] audits:', error.message); break chunks }
      rounds.push(...(data || []))
      if (!data || data.length < 1000) break
    }
  }

  // Land fence and unlock requests.
  const [fenceRes, reqRes] = await Promise.all([
    supabase.from('project_geofences').select('project_id, project_name, area_sq_m, locked, locked_at, locked_by_name').in('project_id', projectIds),
    supabase.from('geofence_change_requests').select('*').in('project_id', projectIds),
  ])
  const fences = fenceRes.error ? [] : fenceRes.data || []
  const fenceReqs = reqRes.error ? [] : reqRes.data || []

  const { data: projRows } = await supabase.from('projects').select('id, name').in('id', projectIds)
  const projectName = Object.fromEntries((projRows || []).map(p => [p.id, p.name]))

  // Audits planned (or stopped) by the audit schedule.
  // Only rows planned within the dates — the table holds up to three per tree.
  const schedule = []
  for (let f = 0; ; f += 1000) {
    const { data, error } = await supabase.from('audit_schedule').select('*').in('project_id', projectIds)
      .gte('created_at', startIso).lte('created_at', endIso).order('id').range(f, f + 999)
    if (error) break
    schedule.push(...(data || []))
    if (!data || data.length < 1000) break
  }

  const personIds = [...new Set([
    ...trees.map(t => t.user_id), ...tasks.flatMap(t => [t.assignee_id, t.created_by, t.reviewed_by]),
    ...rounds.map(r => r.user_id), ...fenceReqs.flatMap(r => [r.requested_by, r.reviewed_by]),
  ].filter(Boolean))]
  const names = {}
  for (let i = 0; i < personIds.length; i += 300) {
    const { data } = await supabase.from('profiles').select('auth_id, display_name').in('auth_id', personIds.slice(i, i + 300))
    for (const p of data || []) names[p.auth_id] = p.display_name
  }
  const who = id => (id && names[id]) || null

  const events = []
  const push = (at, type, label, projectId, personId, person, extra = {}) => {
    if (!inRange(at)) return
    events.push({ at, type, label, projectId, project: projectName[projectId] || projectId, personId: personId || null, person: person || '—', treeCode: null, species: null, taskCode: null, detail: null, status: null, ...extra })
  }
  const treeBits = tr => tr ? { treeCode: codeOf(tr), species: tr.species || null } : {}

  for (const t of trees) {
    if (captures.has(t.id)) continue
    push(t.submitted_at, 'tree_added', 'Tree added', t.project_id, t.user_id, who(t.user_id),
      { ...treeBits(t), detail: `${t.event_type || 'Capture'} · ${t.quantity || 1} tree${(t.quantity || 1) === 1 ? '' : 's'}` })
  }

  for (const k of tasks) {
    const tr = treeById[k.tree_id]
    const kind = treeTasks.typeOf(k) === 'planting' ? 'Planting' : 'Audit'
    const base = { ...treeBits(tr), taskCode: k.task_code || null, detail: `${kind} task` }
    push(k.created_at, 'task_created', 'Task created', k.project_id, k.assignee_id, who(k.assignee_id), { ...base, status: 'assigned' })
    if (k.completed_at) push(k.completed_at, 'task_completed', 'Task completed', k.project_id, k.assignee_id, who(k.assignee_id), { ...base, status: 'completed' })
    if (k.reviewed_at && (k.status === 'approved' || k.status === 'rejected')) {
      const note = k.review_notes && k.review_notes !== 'edited' ? ` — ${k.review_notes}` : ''
      push(k.reviewed_at, k.status === 'approved' ? 'task_approved' : 'task_rejected',
        k.status === 'approved' ? 'Task approved' : 'Task rejected', k.project_id, k.reviewed_by, who(k.reviewed_by),
        { ...base, detail: `${base.detail}${note}`, status: k.status })
    }
  }

  for (const r of rounds) {
    const tr = treeById[r.tree_record_id] || treeById[capToTree[r.tree_record_id]]
    if (!tr) continue
    push(r.submitted_at, 'audit_round', 'Audit round', tr.project_id, r.user_id, who(r.user_id) || r.surveyor || null,
      { ...treeBits(tr), taskCode: capToTask[r.tree_record_id] || null, detail: `Round ${r.monitoring_round || 1}${r.tree_condition ? ` · ${r.tree_condition}` : ''}`, status: r.survival_status || null })
  }

  for (const g of fences) {
    if (g.locked && g.locked_at) {
      const area = Number(g.area_sq_m) ? ` · ${Math.round(Number(g.area_sq_m)).toLocaleString('en-IN')} m²` : ''
      push(g.locked_at, 'fence_locked', 'Land fence locked', g.project_id, null, g.locked_by_name || null, { detail: `Boundary locked${area}`, status: 'locked' })
    }
  }
  for (const r of fenceReqs) {
    push(r.created_at, 'fence_request', 'Fence change requested', r.project_id, r.requested_by, r.requested_by_name || who(r.requested_by),
      { detail: r.reason || null, status: 'pending' })
    if (r.reviewed_at && (r.status === 'approved' || r.status === 'rejected')) {
      push(r.reviewed_at, 'fence_decided', r.status === 'approved' ? 'Fence change approved' : 'Fence change rejected', r.project_id, r.reviewed_by, r.reviewed_by_name || who(r.reviewed_by),
        { detail: r.review_notes || null, status: r.status })
    }
  }

  for (const a of schedule) {
    const tr = treeById[a.tree_id]
    const due = new Date(a.due_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
    if (a.status === 'cancelled') {
      push(a.created_at, 'audit_stopped', 'Audit cycle stopped', a.project_id || tr?.project_id, null, null,
        { ...treeBits(tr), detail: `Tree found ${a.cancel_reason || 'dead'} — Audit ${a.round} not scheduled`, status: 'stopped' })
    } else {
      push(a.created_at, 'audit_scheduled', 'Audit scheduled', a.project_id || tr?.project_id, null, null,
        { ...treeBits(tr), detail: `Audit ${a.round} of ${MAX_ROUND} · due ${due}`, status: a.status })
    }
  }

  events.sort((a, b) => String(b.at).localeCompare(String(a.at)))
  const truncated = events.length > ACTIVITY_CAP
  return { from, to, truncated, events: truncated ? events.slice(0, ACTIVITY_CAP) : events }
}

module.exports = { activityFor, ACTIVITY_CAP }
