/**
 * treeTasks.js — the two field tasks every tree goes through.
 *
 *   1. Planting  — created when the tree is added ("Under plantation").
 *                  Partner assigns a field operator → they plant it and capture
 *                  it in the app → partner approves → tree becomes "Planted".
 *   2. Audit     — created when the tree becomes Planted.
 *                  Partner assigns a field operator → they survey it → partner
 *                  approves → the delivery is published to the ledger.
 *
 * tasks.task_type says which one a task is; tasks.tree_id always points at the
 * partner's tree record, and tasks.capture_tree_id at the field app's capture
 * that completed it. Both columns come from the setup SQL — until they exist
 * every task is treated as an audit (the original behaviour).
 */
const supabase = require('../supabaseClient')

const PLANTING = 'planting'
const AUDIT    = 'audit'

let columnsReady = null
/** True once tasks.task_type / tasks.capture_tree_id exist. Re-checked until they do. */
async function hasTaskTypeColumns() {
  if (columnsReady === true) return true
  const { error } = await supabase.from('tasks').select('task_type, capture_tree_id').limit(1)
  columnsReady = !error
  return columnsReady
}

const typeOf = t => (t && t.task_type) || AUDIT

/**
 * All tasks per tree, split by type (latest of each).
 * Returns { [treeId]: { planting: task|null, audit: task|null, all: task[] } }.
 */
async function tasksForTrees(treeIds, columns = 'id, tree_id, status, assignee_id, created_by, task_code, created_at, location, name') {
  const ids = [...new Set((treeIds || []).filter(Boolean))]
  const out = Object.fromEntries(ids.map(id => [id, { planting: null, audit: null, all: [] }]))
  if (ids.length === 0) return out
  const withType = await hasTaskTypeColumns()
  const chunks = []
  for (let i = 0; i < ids.length; i += 300) chunks.push(ids.slice(i, i + 300))
  // Chunks are independent — fetch them together instead of one after another.
  const results = await Promise.all(chunks.map(part => supabase
    .from('tasks')
    .select(columns + (withType ? ', task_type, capture_tree_id' : ''))
    .in('tree_id', part)
    .order('created_at', { ascending: true })))
  for (const { data, error } of results) {
    if (error) throw error
    for (const t of data || []) {
      const slot = out[t.tree_id]
      if (!slot) continue
      slot.all.push(t)
      slot[typeOf(t)] = t   // ascending order → the latest of each type wins
    }
  }
  return out
}

/** Splits already-loaded tasks (oldest first) into { planting, audit, all } like tasksForTrees. */
function slotFor(tasks) {
  const slot = { planting: null, audit: null, all: [] }
  for (const t of tasks || []) { slot.all.push(t); slot[typeOf(t)] = t }
  return slot
}

/**
 * Tree record ids that are field-app captures completing a task (not trees in their own right).
 * Read by almost every list, so it is kept for a few seconds; the only writer
 * of capture_tree_id on this server is reconcile, which clears it.
 */
const CAPTURE_TTL_MS = 3000
let captureCache = null
async function captureTreeIds() {
  if (captureCache && Date.now() - captureCache.at < CAPTURE_TTL_MS) return captureCache.value
  if (!(await hasTaskTypeColumns())) return new Set()
  const { data } = await supabase.from('tasks').select('capture_tree_id').not('capture_tree_id', 'is', null)
  const value = new Set((data || []).map(r => r.capture_tree_id))
  captureCache = { at: Date.now(), value }
  return value
}
const clearCaptureCache = () => { captureCache = null }

/** Creates the planting or audit task for each tree that doesn't already have one of that type. */
async function createTreeTasks({ trees, projectId, partnerUserId, type }) {
  const { autoCreateVerificationTasks } = require('./partnerHelpers')
  if (!trees || trees.length === 0) return []
  const withType = await hasTaskTypeColumns()
  if (!withType && type === PLANTING) return []          // no way to tell the two apart yet
  const existing = await tasksForTrees(trees.map(t => t.id))
  const todo = trees.filter(t => !existing[t.id]?.[type] && !(type === AUDIT && !withType && existing[t.id]?.all.length))
  if (todo.length === 0) return []
  return autoCreateVerificationTasks({ trees: todo, projectId, partnerUserId, anyOwner: true, taskType: withType ? type : null })
}

async function treeForTask(treeId) {
  const { data } = await supabase
    .from('tree_records')
    .select('id, tree_id, species, latitude, longitude, project_id')
    .eq('id', treeId)
    .maybeSingle()
  return data
}

/** Audit task for a planted tree, unless it already has one. */
async function ensureAuditTask(treeId, partnerUserId) {
  const tree = await treeForTask(treeId)
  if (!tree) return null
  const created = await createTreeTasks({
    trees: [{ id: tree.id, code: tree.tree_id, species: tree.species, latitude: tree.latitude, longitude: tree.longitude }],
    projectId: tree.project_id, partnerUserId, type: AUDIT,
  })
  return created[0] || null
}

/**
 * The partner marked the tree planted by hand — close its open planting task
 * so it doesn't linger in a field operator's list.
 */
async function closePlantingTask(treeId, reviewerId) {
  if (!(await hasTaskTypeColumns())) return
  await supabase
    .from('tasks')
    .update({
      status: 'approved',
      reviewed_by: reviewerId || null,
      reviewed_at: new Date().toISOString(),
      review_notes: 'Marked as planted by the partner',
    })
    .eq('tree_id', treeId)
    .eq('task_type', PLANTING)
    .neq('status', 'approved')
}

/**
 * A planting task was approved: the tree is now Planted (taking the field
 * capture's GPS / photo where the record has none), and its audit task opens.
 */
async function onPlantingApproved(task, reviewerId) {
  const { data: tree } = await supabase
    .from('tree_records')
    .select('id, latitude, longitude, photo_url, stage')
    .eq('id', task.tree_id)
    .maybeSingle()
  if (!tree) return null

  const updates = {}
  if (!tree.stage || tree.stage === 'Under plantation') updates.stage = 'Planted'
  if (task.capture_tree_id) {
    const { data: cap } = await supabase
      .from('tree_records')
      .select('latitude, longitude, photo_url')
      .eq('id', task.capture_tree_id)
      .maybeSingle()
    if (cap) {
      if (!Number.isFinite(Number(tree.latitude)) || Number(tree.latitude) === 0) updates.latitude = cap.latitude
      if (!Number.isFinite(Number(tree.longitude)) || Number(tree.longitude) === 0) updates.longitude = cap.longitude
      if (!tree.photo_url && cap.photo_url) updates.photo_url = cap.photo_url
    }
  }
  if (Object.keys(updates).length > 0) {
    const { error } = await supabase.from('tree_records').update(updates).eq('id', tree.id)
    if (error) console.error('[treeTasks] planted update failed:', error.message)
  }
  return ensureAuditTask(tree.id, task.created_by || reviewerId)
}

/**
 * Gives a tree's planting task to a field operator — creating the task if the
 * tree doesn't have one (older trees), and reopening it if it was rejected.
 * Returns the task, or null when the tree can't be found.
 */
async function assignPlantingTask(treeId, assigneeId, partnerUserId) {
  const tree = await treeForTask(treeId)
  if (!tree) return null
  let task = (await tasksForTrees([treeId]))[treeId]?.planting
  if (!task) {
    const created = await createTreeTasks({
      trees: [{ id: tree.id, code: tree.tree_id, species: tree.species, latitude: tree.latitude, longitude: tree.longitude }],
      projectId: tree.project_id, partnerUserId, type: PLANTING,
    })
    task = created[0] ? { id: created[0].id, status: 'assigned' } : null
  }
  if (!task) return null
  const updates = { assignee_id: assigneeId }
  // A rejected planting goes back to the field; anything not yet started stays "assigned".
  if (task.status === 'rejected' || task.status === 'assigned') {
    Object.assign(updates, { status: 'assigned', started_at: null, completed_at: null, capture_tree_id: null })
  }
  const { data, error } = await supabase.from('tasks').update(updates).eq('id', task.id).select('id, name, task_code, status').single()
  if (error) throw error
  return data
}

// ── Field-app completions ─────────────────────────────────────────────────────
// When the field app completes a task it overwrites tasks.tree_id with the new
// capture record it just saved, and never sets capture_tree_id. The tree then
// loses its task (no "Review planting" on Assign action) and an approval marks
// the capture Planted instead of the tree. The app isn't changed here, so the
// backend repairs it: every task it creates names its tree's code —
// "Plant — Mahogany (TREE-D2Y5DD2)" — and codes are unique, so the task is
// moved back onto that tree and the capture kept as capture_tree_id.
const TREE_CODE_RE = /\((TREE-[A-Z0-9]+)\)/
const RECONCILE_EVERY_MS = 5000
const FORCED_RECONCILE_MIN_MS = 1500
let lastReconcile = 0
let reconciling = null

/**
 * Re-points field-app-completed tasks at their own tree. Cheap enough to run
 * on reads (throttled); pass { force: true } right before acting on a task.
 * Returns the number of tasks fixed.
 */
async function reconcileCaptureTasks({ force = false } = {}) {
  if (reconciling) return reconciling
  // Even a forced run is skipped if one finished a moment ago — two page loads
  // at once should not each re-scan every task.
  if (Date.now() - lastReconcile < (force ? FORCED_RECONCILE_MIN_MS : RECONCILE_EVERY_MS)) return 0
  reconciling = (async () => {
    try {
      if (!(await hasTaskTypeColumns())) return 0
      return await runReconcile()
    } finally {
      lastReconcile = Date.now()
      reconciling = null
    }
  })()
  return reconciling
}

async function runReconcile() {
  const { data: tasks, error } = await supabase
    .from('tasks')
    .select('id, name, tree_id, capture_tree_id, task_type, status, created_by, reviewed_by')
    .like('name', '%(TREE-%')
    .not('tree_id', 'is', null)
  if (error) throw error

  const coded = (tasks || [])
    .map(t => ({ ...t, code: (t.name.match(TREE_CODE_RE) || [])[1] }))
    .filter(t => t.code)
  const codes = [...new Set(coded.map(t => t.code))]
  if (codes.length === 0) return 0

  // The field app saves its capture under the SAME code as the partner's tree,
  // so one code can name two records: the partner's tree (older) and the capture.
  const recordsByCode = {}
  for (let i = 0; i < codes.length; i += 300) {
    const { data, error: treeErr } = await supabase
      .from('tree_records')
      .select('id, tree_id, submitted_at')
      .in('tree_id', codes.slice(i, i + 300))
    if (treeErr) throw treeErr
    for (const r of data || []) (recordsByCode[r.tree_id] = recordsByCode[r.tree_id] || []).push(r)
  }
  // The partner's own tree is the oldest record with that code. A task that
  // already points at it is fine; one pointing at a newer record is a capture.
  const treeIdByCode = {}
  for (const [code, list] of Object.entries(recordsByCode)) {
    treeIdByCode[code] = [...list].sort((a, b) => String(a.submitted_at).localeCompare(String(b.submitted_at)))[0].id
  }

  let fixed = 0
  const approvedPlantings = []
  for (const t of coded) {
    const treeId = treeIdByCode[t.code]
    if (!treeId || t.tree_id === treeId) continue
    const captureId = t.capture_tree_id || t.tree_id
    const { error: upErr } = await supabase
      .from('tasks')
      .update({ tree_id: treeId, capture_tree_id: captureId })
      .eq('id', t.id)
      .eq('tree_id', t.tree_id)   // untouched since we read it
    if (upErr) { console.error('[treeTasks] reconcile failed for task', t.id, upErr.message); continue }
    fixed++
    if (typeOf(t) === PLANTING && t.status === 'approved') {
      approvedPlantings.push({ ...t, tree_id: treeId, capture_tree_id: captureId })
    }
  }

  // An approval that ran while the task pointed at the capture planted the
  // capture and opened the audit there. Move that audit to the tree, then
  // apply the approval to the tree itself (idempotent: stage + audit task).
  for (const task of approvedPlantings) {
    await supabase
      .from('tasks')
      .update({ tree_id: task.tree_id })
      .eq('tree_id', task.capture_tree_id)
      .eq('task_type', AUDIT)
    await onPlantingApproved(task, task.reviewed_by || task.created_by)
  }

  if (fixed > 0) {
    clearCaptureCache()
    console.log(`[treeTasks] re-linked ${fixed} field-app task(s) to their trees`)
  }
  return fixed
}

/**
 * reconcileCaptureTasks for read paths — a repair failure must never break the
 * page. Pass { force: true } where a just-completed task must show at once.
 */
async function reconcileQuietly(opts) {
  try { await reconcileCaptureTasks(opts) } catch (e) { console.error('[treeTasks] reconcile:', e.message) }
}

module.exports = {
  reconcileCaptureTasks, reconcileQuietly,
  assignPlantingTask,
  PLANTING, AUDIT, typeOf,
  hasTaskTypeColumns, tasksForTrees, slotFor, captureTreeIds, clearCaptureCache,
  createTreeTasks, ensureAuditTask, closePlantingTask, onPlantingApproved,
}
