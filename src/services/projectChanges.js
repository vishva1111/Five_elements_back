/**
 * projectChanges.js — project map colour, fencing and land boundary.
 *
 * A partner can edit a project's plain details directly, but its map colour and
 * its fencing only change after an admin approves the request on the Approval
 * page. Requests live in project_change_requests (see sql/005). The mobile app's
 * own boundary-unlock requests (geofence_change_requests) are reviewed on the
 * same page, so this module reads both.
 */
const supabase = require('../supabaseClient')
const { isMissingSchema } = require('./treeHistory')

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/
const FENCING_STATUSES = ['not_started', 'in_progress', 'completed', 'damaged']
const FENCING_FIELDS = ['status', 'type', 'material', 'length_m', 'height_m', 'gates', 'installed_on', 'contractor', 'notes']

/** Error shown when sql/005 has not been run yet. */
const NEEDS_MIGRATION = 'Project colour and fencing are not set up in the database yet — run backend/sql/005_requirements_fencing_color_audit.sql in the Supabase SQL Editor.'

// ── Geometry (same maths as the mobile app's projectGeofenceService) ─────────
const EARTH_RADIUS = 6378137
const rad = d => (d * Math.PI) / 180

function polygonArea(coords) {
  if (!coords || coords.length < 3) return 0
  let area = 0
  for (let i = 0; i < coords.length; i++) {
    const p1 = coords[i]
    const p2 = coords[(i + 1) % coords.length]
    area += rad(p2.longitude - p1.longitude) * (2 + Math.sin(rad(p1.latitude)) + Math.sin(rad(p2.latitude)))
  }
  return Math.abs((area * EARTH_RADIUS * EARTH_RADIUS) / 2)
}

function distance(a, b) {
  const dLat = rad(b.latitude - a.latitude)
  const dLng = rad(b.longitude - a.longitude)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_RADIUS * Math.asin(Math.sqrt(h))
}

function polygonPerimeter(coords) {
  if (!coords || coords.length < 2) return 0
  let total = 0
  for (let i = 0; i < coords.length; i++) total += distance(coords[i], coords[(i + 1) % coords.length])
  return total
}

/** Keeps only valid { latitude, longitude } points. */
function cleanCoordinates(list) {
  if (!Array.isArray(list)) return []
  return list
    .map(p => ({ latitude: Number(p?.latitude), longitude: Number(p?.longitude) }))
    .filter(p => Number.isFinite(p.latitude) && Number.isFinite(p.longitude)
      && Math.abs(p.latitude) <= 90 && Math.abs(p.longitude) <= 180)
}

/** Fencing details from a request body, with numbers parsed and unknown keys dropped. */
function cleanFencing(input) {
  const f = input && typeof input === 'object' ? input : {}
  const out = {}
  for (const key of FENCING_FIELDS) {
    const v = f[key]
    if (v === undefined || v === null || v === '') continue
    if (['length_m', 'height_m', 'gates'].includes(key)) {
      const n = Number(v)
      if (Number.isFinite(n) && n >= 0) out[key] = n
    } else {
      out[key] = String(v).trim().slice(0, 500)
    }
  }
  if (out.status && !FENCING_STATUSES.includes(out.status)) delete out.status
  return out
}

// ── Reads ─────────────────────────────────────────────────────────────────────

/** Land boundaries by project id. Empty when the table doesn't exist yet. */
async function geofencesFor(projectIds) {
  const ids = [...new Set((projectIds || []).filter(Boolean))]
  if (ids.length === 0) return {}
  const { data, error } = await supabase.from('project_geofences').select('*').in('project_id', ids)
  if (error) return {}
  const out = {}
  for (const g of data || []) {
    const coordinates = cleanCoordinates(Array.isArray(g.coordinates) ? g.coordinates : (() => {
      try { return JSON.parse(g.coordinates) } catch { return [] }
    })())
    out[g.project_id] = {
      coordinates,
      areaSqM:     Number(g.area_sq_m) || polygonArea(coordinates),
      perimeterM:  Number(g.perimeter_m) || polygonPerimeter(coordinates),
      status:      g.status,
      locked:      !!g.locked,
      lockedAt:    g.locked_at,
      lockedBy:    g.locked_by_name || null,
      updatedAt:   g.updated_at,
    }
  }
  return out
}

/** map_color + fencing by project id ({} if the columns don't exist yet). */
async function projectExtras(projectIds) {
  const ids = [...new Set((projectIds || []).filter(Boolean))]
  if (ids.length === 0) return {}
  const { data, error } = await supabase.from('projects').select('id, map_color, fencing').in('id', ids)
  if (error) return {}
  return Object.fromEntries((data || []).map(p => [p.id, { mapColor: p.map_color || null, fencing: p.fencing || null }]))
}

function normaliseProjectRequest(r) {
  return {
    id:              r.id,
    source:          'project',
    type:            r.type,
    projectId:       r.project_id,
    projectName:     r.project_name || r.project_id,
    proposed:        r.proposed || {},
    current:         r.current || {},
    reason:          r.reason || null,
    status:          r.status,
    requestedBy:     r.requested_by,
    requestedByName: r.requested_by_name || null,
    reviewedByName:  r.reviewed_by_name || null,
    reviewedAt:      r.reviewed_at || null,
    reviewNotes:     r.review_notes || null,
    createdAt:       r.created_at,
  }
}

function normaliseGeofenceRequest(r) {
  return {
    id:              r.id,
    source:          'geofence',
    type:            'boundary',
    projectId:       r.project_id,
    projectName:     r.project_name || r.project_id,
    proposed:        {},
    current:         {},
    reason:          r.reason || null,
    status:          r.status,
    requestedBy:     r.requested_by,
    requestedByName: r.requested_by_name || null,
    reviewedByName:  r.reviewed_by_name || null,
    reviewedAt:      r.reviewed_at || null,
    reviewNotes:     r.review_notes || null,
    createdAt:       r.created_at,
  }
}

/**
 * Change requests from both tables, newest first.
 * opts: { status?: 'pending'|'approved'|'rejected', projectIds?: string[] }
 */
async function listChangeRequests({ status, projectIds } = {}) {
  if (projectIds && projectIds.length === 0) return []
  const build = (table) => {
    let q = supabase.from(table).select('*').order('created_at', { ascending: false }).limit(200)
    if (status) q = q.eq('status', status)
    if (projectIds) q = q.in('project_id', projectIds)
    return q
  }
  const [mine, app] = await Promise.all([build('project_change_requests'), build('geofence_change_requests')])
  const out = [
    ...(mine.error ? [] : (mine.data || []).map(normaliseProjectRequest)),
    ...(app.error ? [] : (app.data || []).map(normaliseGeofenceRequest)),
  ]
  return out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
}

async function pendingChangeCount() {
  const head = { count: 'exact', head: true }
  const [a, b] = await Promise.all([
    supabase.from('project_change_requests').select('id', head).eq('status', 'pending'),
    supabase.from('geofence_change_requests').select('id', head).eq('status', 'pending'),
  ])
  return (a.error ? 0 : a.count || 0) + (b.error ? 0 : b.count || 0)
}

// ── Writes ────────────────────────────────────────────────────────────────────

/** Saves an approved boundary as the project's locked land boundary (same shape the app writes). */
async function saveBoundary(project, coordinates, reviewer) {
  const now = new Date().toISOString()
  const row = {
    project_id:     project.id,
    project_name:   project.name,
    coordinates,
    area_sq_m:      Math.round(polygonArea(coordinates) * 100) / 100,
    perimeter_m:    Math.round(polygonPerimeter(coordinates) * 100) / 100,
    status:         'locked',
    locked:         true,
    locked_at:      now,
    locked_by:      reviewer.id || null,
    locked_by_name: reviewer.name || 'Admin',
    updated_at:     now,
  }
  const { error } = await supabase.from('project_geofences').upsert(row, { onConflict: 'project_id' })
  if (error) throw error
}

/** Applies an approved request to the project. */
async function applyProjectRequest(request, reviewer) {
  const { data: project } = await supabase.from('projects').select('id, name').eq('id', request.project_id).maybeSingle()
  if (!project) throw new Error('The project for this request no longer exists')
  const p = request.proposed || {}

  if (request.type === 'color') {
    if (!HEX_COLOR.test(p.color || '')) throw new Error('The requested colour is not valid')
    const { error } = await supabase.from('projects').update({ map_color: p.color }).eq('id', project.id)
    if (error) throw error
    return
  }

  if (request.type === 'fencing') {
    if (p.fencing && Object.keys(p.fencing).length > 0) {
      const fencing = { ...cleanFencing(p.fencing), updated_at: new Date().toISOString() }
      const { error } = await supabase.from('projects').update({ fencing }).eq('id', project.id)
      if (error) throw error
    }
    const coords = cleanCoordinates(p.coordinates)
    if (coords.length >= 3) await saveBoundary(project, coords, reviewer)
    return
  }

  throw new Error(`Unknown request type: ${request.type}`)
}

/** An approved app request reopens the boundary so the field team can redraw it in the app. */
async function unlockBoundary(projectId) {
  const { error } = await supabase
    .from('project_geofences')
    .update({ locked: false, status: 'draft', updated_at: new Date().toISOString() })
    .eq('project_id', projectId)
  if (error && !isMissingSchema(error)) throw error
}

module.exports = {
  NEEDS_MIGRATION, HEX_COLOR, FENCING_STATUSES,
  polygonArea, polygonPerimeter, cleanCoordinates, cleanFencing,
  geofencesFor, projectExtras, listChangeRequests, pendingChangeCount,
  applyProjectRequest, unlockBoundary,
}
