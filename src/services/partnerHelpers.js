/**
 * partnerHelpers.js — the business logic behind the partner routes, kept apart
 * from route registration so partner.js reads as "here is every partner
 * endpoint" rather than a mix of routing and domain logic. Moved here
 * verbatim from partner.js; nothing about how any of it behaves has changed.
 */
const supabase = require('../supabaseClient')
const crypto   = require('crypto')
const { createNotification } = require('../routes/notifications')
const { listAllAuthUsers } = require('./authUsers')

/** Temporary password for accounts a partner creates on someone's behalf. */
function generateTempPassword() {
  const rand = crypto.randomBytes(9).toString('base64').replace(/[^A-Za-z0-9]/g, '')
  return `Fe${rand}9!`
}

/**
 * Find an auth account by email, or create one — mirrors the pattern already
 * used for admin-created partners and team invites. New here: reused directly
 * by donor import, so a returning donor's second and third donation land on
 * the same account instead of minting a fresh one each time.
 */
async function findOrCreateDonorAccount({ email, displayName, accountType, emailCache }) {
  const normalised = String(email).toLowerCase().trim()
  if (emailCache.has(normalised)) return { authId: emailCache.get(normalised), created: false }

  const { data: created, error } = await supabase.auth.admin.createUser({
    email: normalised,
    password: generateTempPassword(),   // never surfaced anywhere; the donor never needs to log in with it here
    email_confirm: true,
    user_metadata: { display_name: displayName },
  })
  if (error) throw new Error(`Could not create an account for ${email}: ${error.message}`)

  await supabase.from('profiles').insert({
    id:             `${accountType}-${created.user.id.slice(0, 8)}`,
    auth_id:        created.user.id,
    display_name:   displayName,
    name:           displayName,
    type:           'Individual',   // profiles_type_check allows only Individual | Business
    location:       '',
    avatar:         '',
    trees:          0,
    t_co2e:         0,
    role:           accountType,
    roles:          [accountType],
    status:         'active',
    is_first_login: true,
  })

  emailCache.set(normalised, created.user.id)
  return { authId: created.user.id, created: true }
}

/**
 * The account behind donations with no email on the receipt — a real paper
 * donor who will very likely never sign in. individual_fundings.user_id is
 * NOT NULL with a foreign key, so *some* account has to stand behind the row;
 * their actual name still shows correctly, because Funders view reads
 * individual_fundings.funder_name, not this account's profile.
 *
 * One such account per partner org, found by a deterministic synthetic email
 * so re-running an import later reuses the same one rather than multiplying
 * placeholder accounts.
 */
async function getOrCreateOfflineDonorAccount(profile) {
  const email = `offline-donations+${profile.id}@fiveelements.internal`

  const listed = await listAllAuthUsers()
  const existing = (listed?.users || []).find(u => u.email?.toLowerCase() === email)
  if (existing) return existing.id

  const { data: created, error } = await supabase.auth.admin.createUser({
    email,
    password: generateTempPassword(),   // nobody is ever given this; the account never signs in
    email_confirm: true,
    user_metadata: { display_name: `Offline donors — ${profile.org_name || 'Partner'}` },
  })
  if (error) throw new Error(`Could not set up the offline-donor record: ${error.message}`)

  await supabase.from('profiles').insert({
    id:             `offline-${created.user.id.slice(0, 8)}`,
    auth_id:        created.user.id,
    display_name:   `Offline donors — ${profile.org_name || 'Partner'}`,
    name:           `Offline donors — ${profile.org_name || 'Partner'}`,
    type:           'Individual',
    location:       '',
    avatar:         '',
    trees:          0,
    t_co2e:         0,
    role:           'individual',
    roles:          ['individual'],
    status:         'active',
    is_first_login: false,
  })

  return created.user.id
}

/**
 * A partner_team_members.role maps onto a platform identity, because the team
 * row alone grants nothing — the person needs an account that passes the guards.
 *
 * Two groups live here:
 *   • partner-scoped roles (admin, field_officer, viewer) — ways of working
 *     inside the partner org;
 *   • platform account types (business, individual) — full users with their own
 *     dashboards, onboarded by the partner. Their captures still roll up to the
 *     partner, because roll-up follows the project, not the person.
 *
 * profiles.role carries a CHECK constraint allowing only
 * individual | business | partner | admin, so 'field_user' lives in the
 * profiles.roles array instead. Everything that cares (assignable-users, the
 * partner gate) reads [role, ...roles], so the capability is honoured without
 * widening that constraint.
 */
const TEAM_ROLE_TO_PLATFORM_ROLE = {
  admin:         { role: 'partner',    roles: ['partner'],                   label: 'Partner Admin', home: '/partner/dashboard' },
  field_officer: { role: 'individual', roles: ['individual', 'field_user'],  label: 'Field Officer', home: '/app/tasks' },
  viewer:        { role: 'individual', roles: ['individual'],                label: 'Viewer',        home: '/impact' },
  business:      { role: 'business',   roles: ['business'],                  label: 'Business',      home: '/business' },
  individual:    { role: 'individual', roles: ['individual'],                label: 'Individual',    home: '/impact' },
}

/**
 * requirePartner — partner-or-admin gate.
 *
 * requireAuth (applied in index.js) only proves the caller is signed in; without
 * this, any individual or business account could register projects as a partner
 * or invite people into a partner org. Applied to every route except /apply,
 * which is what an applicant calls *before* they are a partner.
 *
 * profiles.role holds the primary role, but an account can carry several in
 * profiles.roles — check both. Admins pass (same hierarchy the frontend uses).
 */
async function requirePartner(req, res, next) {
  try {
    if (['partner', 'admin'].includes(req.role)) return next()

    const { data } = await supabase
      .from('profiles')
      .select('roles')
      .eq('auth_id', req.userId)
      .maybeSingle()

    const roles = data?.roles || []
    if (roles.includes('partner') || roles.includes('admin')) return next()

    return res.status(403).json({ error: 'Forbidden — partner access required' })
  } catch (err) {
    console.error('[requirePartner]', err)
    return res.status(500).json({ error: 'Failed to verify access' })
  }
}

/**
 * The auth account behind a team member.
 *
 * user_id arrives with migration 003; rows created before it only carry an
 * email, which is what the invite flow has always written. Both are supported
 * so every path works either side of the migration.
 */
async function resolveMemberAuthId(member) {
  if (!member) return null
  if (member.user_id) return member.user_id
  if (!member.email) return null

  const listed = await listAllAuthUsers()
  const match = (listed?.users || []).find(
    u => String(u.email || '').toLowerCase() === String(member.email).toLowerCase()
  )
  return match?.id || null
}

/** The partner profile owning the caller, or null. */
async function partnerProfileFor(userId) {
  const { data } = await supabase
    .from('partner_profiles')
    .select('id, org_name')
    .eq('user_id', userId)
    .maybeSingle()
  return data || null
}

/**
 * A team member, scoped to the caller's own org so one partner can never read
 * or edit another's people.
 */
async function memberInOrg(partnerId, memberId) {
  const { data } = await supabase
    .from('partner_team_members')
    .select('*')
    .eq('id', memberId)
    .eq('partner_id', partnerId)
    .maybeSingle()
  return data || null
}

/** Count of active admins, used to protect the last one (P9-03). */
async function activeAdminCount(partnerId) {
  const { count } = await supabase
    .from('partner_team_members')
    .select('id', { count: 'exact', head: true })
    .eq('partner_id', partnerId)
    .eq('role', 'admin')
    .eq('status', 'active')
  return count || 0
}

/** Partner's own submission ids, plus the project ids those map to. */
async function partnerScope(userId) {
  const { data: subs } = await supabase
    .from('project_submissions')
    .select('id, title, status, project_id, submitted_at')
    .eq('submitted_by', userId)

  const all = subs || []
  return {
    submissions: all,
    submissionIds: all.map(s => s.id),
    projectIds: [...new Set(all.filter(s => s.status === 'approved' && s.project_id).map(s => s.project_id))],
  }
}

/** evidence_files.status uses pending_review/in_review/approved/rejected. */
function normaliseEvidenceStatus(raw) {
  if (raw === 'approved' || raw === 'rejected' || raw === 'in_review') return raw
  return 'pending'
}

function formatFileSize(bytes) {
  const n = Number(bytes)
  if (!Number.isFinite(n) || n <= 0) return '—'
  return n < 1024 * 1024
    ? `${(n / 1024).toFixed(1)} KB`
    : `${(n / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Automatic task creation — the missing link in Super Admin → Partner →
 * Project → Business/Individual User → [Tree Data] → Task → Field Operator.
 *
 * When a partner records tree data on behalf of a Business or Individual
 * user (Add Tree, or the bulk spreadsheet import), that data is a claim, not
 * yet field-verified — nobody has physically confirmed it. This creates one
 * "Tree Survey" task per tree, exactly the shape POST /api/admin/tasks and
 * the bulk-generate endpoint already create, so it shows up in Task
 * Management, the Field Operator's TreeApp task list and the approval flow
 * without any of that code needing to know where the task came from.
 *
 * Deliberately does NOT fire for a field_officer/field_user-owned tree: that
 * person already IS the field operator — spinning up a second task asking
 * someone to go re-verify what they just captured themselves would be
 * circular busywork, not the verification loop this exists to close.
 *
 * The task is assigned to the partner themselves at creation time (a task
 * always needs a valid assignee) — "Implementation Partner —Assign Task→
 * Field Operator" in the flow is the partner then handing it off via the
 * existing Task Management reassignment, not a new endpoint.
 *
 * Best-effort: failing to create a task must never fail the tree write that
 * triggered it. Returns the tasks actually created.
 */
async function autoCreateVerificationTasks({ trees, projectId, partnerUserId, ownerRole }) {
  if (!['business', 'individual'].includes(ownerRole)) return []
  if (!trees || trees.length === 0) return []

  const created = []

  for (const tree of trees) {
    try {
      const { data: codeRow } = await supabase.rpc('generate_task_code', { p_tree_id: tree.id })

      const location = Number.isFinite(tree.latitude) && Number.isFinite(tree.longitude)
        ? `${tree.latitude.toFixed(6)}, ${tree.longitude.toFixed(6)}`
        : null

      const { data: task, error } = await supabase
        .from('tasks')
        .insert({
          name:         `Tree Survey — ${tree.species || 'Unknown species'} (${tree.id.slice(0, 8).toUpperCase()})`,
          project_id:   projectId,
          assignee_id:  partnerUserId,   // placeholder until reassigned to a Field Operator
          tree_id:      tree.id,
          task_code:    codeRow || null,
          target_count: 1,
          location,
          priority:     'medium',
          status:       'assigned',
          captured:     0,
          created_by:   partnerUserId,
        })
        .select('id, task_code, name')
        .single()

      if (error) {
        console.error('[autoCreateVerificationTasks] insert failed:', error.message)
        continue
      }
      created.push(task)
    } catch (e) {
      console.error('[autoCreateVerificationTasks]', e.message)
    }
  }

  if (created.length > 0) {
    await createNotification({
      userId: partnerUserId,
      type:   'task_assigned',
      title:  `${created.length} verification task${created.length > 1 ? 's' : ''} created`,
      body:   `Field verification ${created.length > 1 ? 'tasks were' : 'task was'} auto-created for the tree data you just recorded. Assign ${created.length > 1 ? 'them' : 'it'} to a Field Operator from Team.`,
      link:   '/partner/tasks',
    }).catch(() => {})
  }

  return created
}

/**
 * The team-member ownership set a partner can read/edit/delete tree records
 * for. Deliberately the SAME check POST /trees writes under: tree_records can
 * hold anyone's field capture (any individual can plant against any active
 * project via the mobile app), so scoping only by project_id would let a
 * partner edit strangers' evidence just because it landed on one of their
 * projects. Restricting to their own team keeps this to "people my
 * organisation is responsible for."
 */
async function partnerOwnedUserIds(partnerUserId) {
  const profile = await partnerProfileFor(partnerUserId)
  if (!profile) return { profile: null, userIds: [] }

  const { data: members } = await supabase
    .from('partner_team_members')
    .select('user_id, email')
    .eq('partner_id', profile.id)

  let userIds = (members || []).map(m => m.user_id).filter(Boolean)

  // Legacy rows (pre-migration 003) have no user_id — resolve by email once.
  const needsLookup = (members || []).some(m => !m.user_id && m.email)
  if (needsLookup) {
    const listed = await listAllAuthUsers()
    const byEmail = Object.fromEntries((listed?.users || []).map(u => [String(u.email || '').toLowerCase(), u.id]))
    const resolved = (members || [])
      .filter(m => !m.user_id && m.email)
      .map(m => byEmail[String(m.email).toLowerCase()])
      .filter(Boolean)
    userIds = [...new Set([...userIds, ...resolved])]
  }

  return { profile, userIds }
}

module.exports = {
  generateTempPassword,
  findOrCreateDonorAccount,
  getOrCreateOfflineDonorAccount,
  TEAM_ROLE_TO_PLATFORM_ROLE,
  requirePartner,
  resolveMemberAuthId,
  partnerProfileFor,
  memberInOrg,
  activeAdminCount,
  partnerScope,
  normaliseEvidenceStatus,
  formatFileSize,
  autoCreateVerificationTasks,
  partnerOwnedUserIds,
}
