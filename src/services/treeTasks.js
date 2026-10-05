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
  for (let i = 0; i < ids.length; i += 300) {
    const { data, error } = await supabase
      .from('tasks')
      .select(columns + (withType ? ', task_type, capture_tree_id' : ''))
      .in('tree_id', ids.slice(i, i + 300))
      .order('created_at', { ascending: true })
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

/** Tree record ids that are field-app captures completing a task (not trees in their own right). */
async function captureTreeIds() {
  if (!(await hasTaskTypeColumns())) return new Set()
  const { data } = await supabase.from('tasks').select('capture_tree_id').not('capture_tree_id', 'is', null)
  return new Set((data || []).map(r => r.capture_tree_id))
}

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

module.exports = {
  assignPlantingTask,
  PLANTING, AUDIT, typeOf,
  hasTaskTypeColumns, tasksForTrees, captureTreeIds,
  createTreeTasks, ensureAuditTask, closePlantingTask, onPlantingApproved,
}
