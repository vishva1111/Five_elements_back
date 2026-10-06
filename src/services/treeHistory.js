/**
 * treeHistory.js — everything recorded about one tree, in the order it happened.
 *
 * A tree's story is spread over four places:
 *   • tree_records            — the tree itself, holding its latest values
 *   • tasks                   — its planting task and one task per audit round
 *   • tree_records (captures) — the field-app capture that completed a task
 *                               (tasks.capture_tree_id), with its photo and GPS
 *   • tree_monitoring_records — one row per audit round written by the app,
 *                               with all its photos and measurements
 *
 * This pulls them together into: every photo, the planting step, and every
 * audit round with its before/after photos, so the web panel can show the full
 * audit history and highlight the latest audit.
 */
const supabase = require('../supabaseClient')
const { typeOf, PLANTING } = require('./treeTasks')

const CHUNK = 300

/** True when a Supabase error only means the table/column has not been created yet. */
function isMissingSchema(error) {
  if (!error) return false
  return ['PGRST205', 'PGRST204', '42P01', '42703'].includes(error.code)
    || /does not exist|schema cache/i.test(error.message || '')
}

/** photo_urls is text[] on some databases and jsonb (or a JSON string) on others. */
function parsePhotoList(value) {
  if (!value) return []
  if (Array.isArray(value)) return value.filter(v => typeof v === 'string' && v)
  if (typeof value === 'string') {
    const s = value.trim()
    if (s.startsWith('[')) {
      try { return parsePhotoList(JSON.parse(s)) } catch { return [] }
    }
    if (s.startsWith('{') && s.endsWith('}')) {
      // Postgres array literal: {"https://a","https://b"}
      return s.slice(1, -1).split(',').map(x => x.replace(/^"|"$/g, '').trim()).filter(Boolean)
    }
    return [s]
  }
  return []
}

/** Primary photo first, then the rest, without duplicates. */
function photosOf(row) {
  if (!row) return []
  return [...new Set([row.photo_url, ...parsePhotoList(row.photo_urls)].filter(Boolean))]
}

function num(v) {
  const n = Number(v)
  return v === null || v === undefined || v === '' || !Number.isFinite(n) ? null : n
}

/** "21.1702, 72.8311" → { latitude, longitude } */
function parseLocation(text) {
  const m = String(text || '').match(/(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/)
  return m ? { latitude: Number(m[1]), longitude: Number(m[2]) } : null
}

function pointOf(row) {
  const lat = num(row?.latitude), lng = num(row?.longitude)
  return lat !== null && lng !== null && !(lat === 0 && lng === 0) ? { latitude: lat, longitude: lng } : null
}

// ── Reads ─────────────────────────────────────────────────────────────────────

/** Every task linked to these trees (by tree_id, and by tree_record_id where that column exists). */
async function allTasksFor(treeIds) {
  const ids = [...new Set((treeIds || []).filter(Boolean))]
  const byId = new Map()
  for (let i = 0; i < ids.length; i += CHUNK) {
    const part = ids.slice(i, i + CHUNK)
    const { data, error } = await supabase.from('tasks').select('*').in('tree_id', part)
    if (error) throw error
    for (const t of data || []) byId.set(t.id, t)
    // Audit tasks the app created itself may only carry tree_record_id.
    const linked = await supabase.from('tasks').select('*').in('tree_record_id', part)
    if (!linked.error) for (const t of linked.data || []) byId.set(t.id, t)
  }
  const out = Object.fromEntries(ids.map(id => [id, []]))
  for (const t of byId.values()) {
    const key = ids.includes(t.tree_id) ? t.tree_id : t.tree_record_id
    if (out[key]) out[key].push(t)
  }
  for (const list of Object.values(out)) list.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
  return out
}

/** Audit rounds written by the app, keyed by tree id. Empty when the table doesn't exist yet. */
async function monitoringFor(treeIds) {
  const ids = [...new Set((treeIds || []).filter(Boolean))]
  const out = Object.fromEntries(ids.map(id => [id, []]))
  for (let i = 0; i < ids.length; i += CHUNK) {
    const { data, error } = await supabase
      .from('tree_monitoring_records')
      .select('*')
      .in('tree_record_id', ids.slice(i, i + CHUNK))
      .order('monitoring_round', { ascending: true })
    if (error) {
      if (isMissingSchema(error)) return out
      throw error
    }
    for (const r of data || []) out[r.tree_record_id]?.push(r)
  }
  return out
}

/**
 * Audit rounds per tree. The mobile app saves an audit against the capture
 * record it created (tasks.capture_tree_id), not always against the partner's
 * own tree — so a tree's audits are those saved on it OR on its captures.
 */
async function monitoringForTrees(treeIds, tasksByTree) {
  const ids = [...new Set((treeIds || []).filter(Boolean))]
  const owner = new Map()                      // capture id → tree id
  for (const id of ids) {
    for (const t of tasksByTree[id] || []) if (t.capture_tree_id && t.capture_tree_id !== id) owner.set(t.capture_tree_id, id)
  }
  const rows = await monitoringFor([...ids, ...owner.keys()])
  const out = {}
  for (const id of ids) out[id] = [...(rows[id] || [])]
  for (const [captureId, treeId] of owner) out[treeId].push(...(rows[captureId] || []))
  // One row per round: if both exist, the one saved last wins.
  for (const id of ids) {
    const byRound = new Map()
    for (const r of out[id].sort((a, b) => String(a.submitted_at).localeCompare(String(b.submitted_at)))) byRound.set(Number(r.monitoring_round) || 1, r)
    out[id] = [...byRound.values()].sort((a, b) => a.monitoring_round - b.monitoring_round)
  }
  return out
}

async function rowsById(table, ids, columns = '*') {
  const list = [...new Set((ids || []).filter(Boolean))]
  const out = {}
  for (let i = 0; i < list.length; i += CHUNK) {
    const { data } = await supabase.from(table).select(columns).in('id', list.slice(i, i + CHUNK))
    for (const r of data || []) out[r.id] = r
  }
  return out
}

async function namesFor(authIds) {
  const ids = [...new Set((authIds || []).filter(Boolean))]
  if (ids.length === 0) return {}
  const { data } = await supabase.from('profiles').select('auth_id, display_name').in('auth_id', ids)
  return Object.fromEntries((data || []).map(p => [p.auth_id, p.display_name]))
}

// ── Assembly ──────────────────────────────────────────────────────────────────

const HAS_DATA = ['completed', 'approved', 'rejected', 'submitted']

/**
 * Planting step + audit rounds for one tree.
 * tasks: all its tasks; records: its monitoring rows; captures: capture rows by id; names: auth id → name.
 */
function buildTimeline(tree, tasks, records, captures, names = {}) {
  const planting = tasks.filter(t => typeOf(t) === PLANTING)
  const audits   = tasks.filter(t => typeOf(t) !== PLANTING)

  // Round per audit task: its audit_round, otherwise the next free round in creation order.
  const rounds = new Map()
  const taken = new Set(audits.map(t => Number(t.audit_round)).filter(n => n > 0))
  let next = 1
  for (const t of audits) {
    let r = Number(t.audit_round)
    if (!(r > 0)) { while (taken.has(next)) next++; r = next; taken.add(r) }
    rounds.set(r, { round: r, task: t, record: null })
  }
  for (const rec of records) {
    const r = Number(rec.monitoring_round) || 1
    const entry = rounds.get(r) || { round: r, task: null, record: null }
    entry.record = rec
    rounds.set(r, entry)
  }

  const describe = (task, record, label) => {
    const capture = task?.capture_tree_id ? captures[task.capture_tree_id] : null
    const photos  = [...new Set([...photosOf(record), ...photosOf(capture)])]
    const source  = record || capture || {}
    return {
      label,
      status:        task?.status || (record ? 'submitted' : 'pending'),
      taskId:        task?.id || null,
      taskCode:      task?.task_code || null,
      taskName:      task?.name || null,
      assigneeName:  task?.assignee_id ? (names[task.assignee_id] || null) : null,
      assignedAt:    task?.created_at || null,
      completedAt:   task?.completed_at || record?.submitted_at || null,
      reviewedAt:    task?.reviewed_at || null,
      reviewedBy:    task?.reviewed_by ? (names[task.reviewed_by] || null) : null,
      reviewNotes:   task?.review_notes && task.review_notes !== 'edited' ? task.review_notes : null,
      surveyDate:    record?.survey_date || capture?.survey_date || null,
      surveyor:      record?.surveyor || capture?.surveyor || null,
      condition:     source.tree_condition || null,
      health:        source.health_status || null,
      survival:      record?.survival_status || null,
      measurements: {
        dbhCm:          num(source.dbh_cm),
        heightM:        num(source.height_m),
        crownDiameterM: num(source.crown_diameter_m),
        woodDensity:    num(source.wood_density),
        ageYears:       num(source.age_years),
        multiStem:      source.multi_stem ?? null,
      },
      notes:    record?.notes || null,
      location: pointOf(record) || pointOf(capture) || parseLocation(task?.location),
      photos,
    }
  }

  const plantingTask = planting[planting.length - 1] || null
  const plantingStep = plantingTask ? describe(plantingTask, null, 'Planting') : null

  // Before/after: each audit is compared with the photo from the step before it.
  const baseline = plantingStep?.photos[0] || photosOf(tree)[0] || null
  let previous = baseline
    ? { url: baseline, label: plantingStep?.photos[0] ? 'Planting' : 'Tree record' }
    : null

  const auditSteps = [...rounds.values()]
    .sort((a, b) => a.round - b.round)
    .map(({ round, task, record }) => {
      const step = describe(task, record, `Audit ${round}`)
      const after = step.photos[0] ? { url: step.photos[0], label: `Audit ${round}` } : null
      const out = { round, ...step, before: previous, after }
      if (after) previous = after
      return out
    })

  const done = auditSteps.filter(a => HAS_DATA.includes(a.status))
  const latest = done[done.length - 1] || null
  for (const a of auditSteps) a.isLatest = !!latest && a.round === latest.round

  return { planting: plantingStep, audits: auditSteps, latestAudit: latest }
}

/** Every photo of the tree, labelled with where it came from. */
function collectPhotos(tree, timeline) {
  const seen = new Set()
  const out = []
  const add = (url, label, date) => {
    if (!url || seen.has(url)) return
    seen.add(url)
    out.push({ url, label, date: date || null })
  }
  photosOf(tree).forEach(u => add(u, 'Tree record', tree.survey_date || tree.submitted_at))
  timeline.planting?.photos.forEach(u => add(u, 'Planting', timeline.planting.completedAt))
  timeline.audits.forEach(a => a.photos.forEach(u => add(u, a.label, a.surveyDate || a.completedAt)))
  return out
}

/** Full history for one tree record (already loaded with select('*')). */
async function treeHistory(tree) {
  const tasksByTree = await allTasksFor([tree.id])
  const [recordsByTree, project] = await Promise.all([
    monitoringForTrees([tree.id], tasksByTree),
    tree.project_id
      ? supabase.from('projects').select('*').eq('id', tree.project_id).maybeSingle().then(r => r.data)
      : Promise.resolve(null),
  ])
  const tasks = tasksByTree[tree.id] || []
  const records = recordsByTree[tree.id] || []
  const captures = await rowsById('tree_records', tasks.map(t => t.capture_tree_id))
  const names = await namesFor([tree.user_id, ...tasks.flatMap(t => [t.assignee_id, t.reviewed_by])])

  const timeline = buildTimeline(tree, tasks, records, captures, names)
  const photos = collectPhotos(tree, timeline)

  return {
    tree: {
      id:             tree.id,
      treeCode:       tree.tree_id || `TREE-${String(tree.id).slice(0, 8).toUpperCase()}`,
      species:        tree.species,
      scientificName: tree.scientific_name || null,
      stage:          tree.stage || 'Under plantation',
      healthStatus:   tree.health_status || null,
      condition:      tree.tree_condition || null,
      eventType:      tree.event_type || null,
      landType:       tree.land_type || null,
      quantity:       tree.quantity || 1,
      latitude:       num(tree.latitude),
      longitude:      num(tree.longitude),
      projectId:      tree.project_id,
      projectName:    project?.name || tree.project_id,
      projectColor:   project?.map_color || null,
      recordedFor:    tree.assigned_to || names[tree.user_id] || '—',
      surveyor:       tree.surveyor || null,
      surveyDate:     tree.survey_date || null,
      submittedAt:    tree.submitted_at,
      notes:          tree.notes || null,
      measurements: {
        dbhCm:          num(tree.dbh_cm),
        heightM:        num(tree.height_m),
        crownDiameterM: num(tree.crown_diameter_m),
        woodDensity:    num(tree.wood_density),
        ageYears:       num(tree.age_years),
        multiStem:      tree.multi_stem ?? null,
      },
    },
    photos,
    planting:    timeline.planting,
    audits:      timeline.audits,
    latestAudit: timeline.latestAudit,
  }
}

/**
 * Lightweight per-tree summary for lists and cards:
 * { [treeId]: { photoUrls, photoCount, auditCount, latestAudit } }.
 */
async function treeSummaries(trees) {
  const list = (trees || []).filter(t => t && t.id)
  if (list.length === 0) return {}
  const ids = list.map(t => t.id)
  // List queries pick their columns; photo_urls may not be one of them (or may not exist).
  const tasksByTree = await allTasksFor(ids)
  const [recordsByTree, extraPhotos] = await Promise.all([
    monitoringForTrees(ids, tasksByTree),
    list.some(t => !('photo_urls' in t)) ? rowsById('tree_records', ids, 'id, photo_urls') : Promise.resolve({}),
  ])
  const captures = await rowsById(
    'tree_records',
    Object.values(tasksByTree).flat().map(t => t.capture_tree_id),
    'id, photo_url, photo_urls, tree_condition, health_status, survey_date, latitude, longitude',
  )

  const out = {}
  for (const row of list) {
    const tree = 'photo_urls' in row ? row : { ...row, photo_urls: extraPhotos[row.id]?.photo_urls || null }
    const timeline = buildTimeline(tree, tasksByTree[tree.id] || [], recordsByTree[tree.id] || [], captures)
    const photos = collectPhotos(tree, timeline)
    const latest = timeline.latestAudit
    out[tree.id] = {
      photoUrls:  photos.slice(0, 12).map(p => p.url),
      photoCount: photos.length,
      auditCount: timeline.audits.filter(a => HAS_DATA.includes(a.status)).length,
      latestAudit: latest ? {
        round:     latest.round,
        status:    latest.status,
        date:      latest.surveyDate || latest.completedAt,
        condition: latest.condition,
        health:    latest.health,
        survival:  latest.survival,
        photo:     latest.photos[0] || null,
      } : null,
    }
  }
  return out
}

module.exports = { treeHistory, treeSummaries, buildTimeline, parsePhotoList, photosOf, isMissingSchema }
