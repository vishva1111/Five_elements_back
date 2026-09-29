/**
 * adminHelpers.js — the business logic behind the admin routes, kept apart
 * from route registration so admin.js reads as "here is every admin
 * endpoint" rather than a mix of routing and domain logic. Moved here
 * verbatim from admin.js; nothing about how any of it behaves has changed.
 */
const supabase = require('../supabaseClient')
const crypto   = require('crypto')

/**
 * Grant a role on the profiles row without dropping the ones already there.
 * profiles.role is the active role; profiles.roles is the full set. Approving a
 * partner has to touch both, or the account still fails every partner guard.
 */
async function grantRole(authUserId, role) {
  if (!authUserId) return { ok: false, error: 'no auth user id' }

  const { data: profile } = await supabase
    .from('profiles')
    .select('id, role, roles')
    .eq('auth_id', authUserId)
    .maybeSingle()

  if (!profile) return { ok: false, error: 'no profile for this account' }

  const roles = Array.isArray(profile.roles) ? profile.roles : []
  const nextRoles = roles.includes(role) ? roles : [...roles, role]

  const { error } = await supabase
    .from('profiles')
    .update({ role, roles: nextRoles })
    .eq('id', profile.id)

  return error ? { ok: false, error: error.message } : { ok: true }
}

/**
 * Put the founding contact on their own team as the first partner_admin.
 *
 * FRD #3 P1-04: "The primary contact on an approved application becomes the
 * first partner_admin." Without this the owner is invisible in their own Team
 * screen, and the last-admin rule (P9-03) miscounts — an org with one invited
 * admin would deadlock, unable to demote or remove the only admin it can see.
 *
 * Idempotent, and tolerant of migration 003 not having run yet.
 */
async function ensureFounderIsAdminMember({ partnerId, authUserId, name, email }) {
  if (!partnerId || !email) return { ok: false, reason: 'missing partner or email' }

  const { data: existing } = await supabase
    .from('partner_team_members')
    .select('id')
    .eq('partner_id', partnerId)
    .eq('email', String(email).toLowerCase())
    .maybeSingle()

  if (existing) return { ok: true, reason: 'already a member', id: existing.id }

  const row = {
    partner_id: partnerId,
    name:       name || String(email).split('@')[0],
    email:      String(email).toLowerCase(),
    role:       'admin',
    status:     'active',
    joined_at:  new Date().toISOString(),
  }

  let { data, error } = await supabase
    .from('partner_team_members')
    .insert({ ...row, user_id: authUserId })
    .select('id')
    .single()

  if (error && /user_id/.test(String(error.message || ''))) {
    ({ data, error } = await supabase
      .from('partner_team_members')
      .insert(row)
      .select('id')
      .single())
  }

  if (error) {
    console.error('[ensureFounderIsAdminMember]', error.message)
    return { ok: false, reason: error.message }
  }
  return { ok: true, id: data.id }
}

/** URL-safe slug; projects.id and projects.slug are both this text key. */
function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'project'
}

/** Slug that isn't taken yet — projects.id is the primary key. */
async function uniqueProjectSlug(base) {
  const root = slugify(base)
  for (let i = 0; i < 50; i++) {
    const candidate = i === 0 ? root : `${root}-${i + 1}`
    const { data } = await supabase.from('projects').select('id').eq('id', candidate).maybeSingle()
    if (!data) return candidate
  }
  return `${root}-${Date.now().toString(36)}`
}

/**
 * Placeholder sequestration rate. Real figures depend on species, age, DBH and
 * region — tree_records already carries dbh_cm / height_m / wood_density for a
 * proper allometric model. Until that model exists this single constant keeps
 * the ledger arithmetic in one visible place instead of scattered magic numbers.
 */
const DEFAULT_TCO2E_PER_TREE = 0.02

/**
 * Publish an approved field capture to the ledger.
 *
 * tree_records used to be a dead end: a field user's capture was approved and
 * then went nowhere — no ledger entry, no evidence trail, no movement in the
 * project counters that funders and the marketplace read. This is the bridge.
 *
 * Idempotent: public_hash carries `tree:<tree_id>`, so re-approving the same
 * task (or approving two tasks for one tree) never double-counts.
 */
async function publishCaptureToLedger({ taskId, treeId, projectId, reviewerId, reviewNotes }) {
  if (!treeId || !projectId) return { ok: false, skipped: 'task has no tree or project' }

  const publicHash = `tree:${treeId}`

  const { data: existing } = await supabase
    .from('ledger_entries')
    .select('id')
    .eq('public_hash', publicHash)
    .maybeSingle()

  if (existing) return { ok: true, skipped: 'already in ledger', entryId: existing.id }

  const { data: tree } = await supabase
    .from('tree_records')
    .select('id, species, quantity, event_type, project_id, submitted_at')
    .eq('id', treeId)
    .maybeSingle()

  if (!tree) return { ok: false, skipped: 'tree record not found' }

  const { data: project } = await supabase
    .from('projects')
    .select('id, name, tco2e, evidence_count, funded_trees')
    .eq('id', projectId)
    .maybeSingle()

  if (!project) return { ok: false, skipped: 'project not found' }

  const trees = Number(tree.quantity) > 0 ? Number(tree.quantity) : 1
  const co2e  = Number((trees * DEFAULT_TCO2E_PER_TREE).toFixed(4))

  const { data: entry, error: entryErr } = await supabase
    .from('ledger_entries')
    .insert({
      id:             `le-fc-${String(treeId).slice(0, 8)}-${Date.now().toString(36)}`,
      date:           (tree.submitted_at || new Date().toISOString()).slice(0, 10),
      project_id:     project.id,
      project:        project.name,
      // ledger_entries.funder is NOT NULL. A field capture is delivered work, not
      // a funding event, so it carries a sentinel rather than a funder identity.
      funder:         'field-delivery',
      trees,
      t_co2e:         co2e,
      trees_verified: trees,
      co2e_verified:  co2e,
      verified:       true,
      approved_by:    reviewerId || null,
      approved_at:    new Date().toISOString(),
      public_hash:    publicHash,
      review_notes:   reviewNotes || `Field capture approved (task ${taskId})`,
    })
    .select('id')
    .single()

  if (entryErr) return { ok: false, error: entryErr.message }

  // Roll the project counters forward so the marketplace, partner dashboard and
  // funders view all reflect delivered work.
  const { error: projErr } = await supabase
    .from('projects')
    .update({
      tco2e:              Number((Number(project.tco2e || 0) + co2e).toFixed(2)),
      evidence_count:     Number(project.evidence_count || 0) + 1,
      last_evidence_date: new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }),
      has_ledger_entry:   true,
    })
    .eq('id', project.id)

  if (projErr) console.error('[publishCaptureToLedger] counter update failed:', projErr.message)

  return { ok: true, entryId: entry.id, trees, co2e }
}

/** Temporary password for accounts staff create on someone's behalf. */
function generateTempPassword() {
  // Upper + lower + digit + symbol, so it passes any policy Supabase applies.
  const rand = crypto.randomBytes(9).toString('base64').replace(/[^A-Za-z0-9]/g, '')
  return `Fe${rand}9!`
}

// ─── Auth guards ──────────────────────────────────────────────────────────────
// Both run only behind app.use('/api/admin', requireAuth, adminRouter)
// (index.js) — requireAuth has already verified the JWT and resolved req.role
// via the profiles.auth_id-then-id fallback, so these just check it rather
// than redoing that verification.
async function requireAdmin(req, res, next) {
  if (req.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden — admin only' })
  }
  req.adminId = req.userId
  next()
}

async function requireAdminOrPartner(req, res, next) {
  if (!['admin', 'partner'].includes(req.role)) {
    return res.status(403).json({ error: 'Forbidden — admin or partner only' })
  }
  req.reviewerId = req.userId
  req.reviewerRole = req.role
  next()
}

module.exports = {
  grantRole,
  ensureFounderIsAdminMember,
  slugify,
  uniqueProjectSlug,
  DEFAULT_TCO2E_PER_TREE,
  publishCaptureToLedger,
  generateTempPassword,
  requireAdmin,
  requireAdminOrPartner,
}
