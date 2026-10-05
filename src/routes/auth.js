const express = require('express')
const router  = express.Router()
const { createClient } = require('@supabase/supabase-js')
const supabase = require('../supabaseClient')
const { sendWelcomeEmail, sendRoleAddedEmail } = require('../services/emailService')
const { requireAuth } = require('../middleware/auth')
const { listAllAuthUsers } = require('../services/authUsers')

// Built once at startup and reused — the two call sites below used to build
// this same client fresh on every request (every login, and every signup
// that falls back to anon signUp), which is needless per-request setup for
// a client whose config never changes.
const anonClient = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
)

// ── POST /api/auth/signup ─────────────────────────────────────────────────────
// Body: { fullName, email, password }
// 1. Creates auth user via Supabase Admin API
// 2. Inserts a profile row with role = 'individual'
router.post('/signup', async (req, res) => {
  const { fullName, email, password, role } = req.body
  const requestedRole = (role === 'business') ? 'business' : 'individual'

  if (!fullName || !email || !password) {
    return res.status(400).json({ error: 'fullName, email and password are required.' })
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' })
  }

  // 1. Create auth user
  // Use admin API if service role key is available, otherwise use anon signUp
  const hasServiceRole = process.env.SUPABASE_SERVICE_ROLE_KEY &&
    process.env.SUPABASE_SERVICE_ROLE_KEY !== 'PASTE_YOUR_SERVICE_ROLE_KEY_HERE'

  let authData, authErr
  if (hasServiceRole) {
    // Admin API — auto-confirm email so user can log in immediately
    const result = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { display_name: fullName.trim() },
    })
    authData = result.data
    authErr  = result.error
  } else {
    // Anon signUp — sends confirmation email with redirect back to /welcome
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000'
    const result = await anonClient.auth.signUp({
      email,
      password,
      options: {
        data: { display_name: fullName.trim() },
        emailRedirectTo: `${frontendUrl}/welcome`,
      },
    })
    authData = result.data
    authErr  = result.error
  }

  if (authErr) {
    // If email already registered, try to add the new role to existing profile
    if (authErr.message?.toLowerCase().includes('already registered') ||
        authErr.message?.toLowerCase().includes('already exists')) {
      // Fetch existing profile by email via auth admin (service role required)
      if (hasServiceRole) {
        const listData = await listAllAuthUsers()
        const existingUser = listData?.users?.find(u => u.email?.toLowerCase() === email.toLowerCase())
        if (existingUser) {
          // Add new role to roles array if not already present
          const { data: existingProfile } = await supabase
            .from('profiles')
            .select('roles')
            .eq('auth_id', existingUser.id)
            .maybeSingle()
          const currentRoles = existingProfile?.roles || ['individual']
          if (!currentRoles.includes(requestedRole)) {
            const newRoles = [...currentRoles, requestedRole]
            await supabase
              .from('profiles')
              .update({ roles: newRoles })
              .eq('auth_id', existingUser.id)
            // Send role-added notification email
            await sendRoleAddedEmail({
              toEmail:     email,
              displayName: existingUser.user_metadata?.display_name || fullName.trim(),
              newRole:     requestedRole,
            })
            return res.status(200).json({
                              message: `${requestedRole} access added to your account.`,
                              userId: existingUser.id,
                              emailConfirmationRequired: false,
                              roleAdded: true,
                            })
          } else {
            return res.status(409).json({ error: `You already have ${requestedRole} access with this email.` })
          }
        }
      }
      return res.status(409).json({ error: 'An account with this email already exists. Please log in.' })
    }
    return res.status(400).json({ error: authErr.message })
  }

  const userId = authData.user.id

  // 2. Insert profile row
  const profileId = `ind-${userId.slice(0, 8)}`
  const { error: profileErr } = await supabase
    .from('profiles')
    .insert({
      id:             profileId,
      auth_id:        userId,
      display_name:   fullName.trim(),
      name:           fullName.trim(),
      type:           'Individual',
      location:       '',
      avatar:         '',
      trees:          0,
      t_co2e:         0,
      role:           requestedRole,
      roles:          [requestedRole],
      is_first_login: true,
      status:         'pending',
    })

  if (profileErr) {
    // Non-fatal — auth user created, profile can be created on first login
    console.warn('[signup] Profile insert failed:', profileErr.message)
  }

  // Send welcome email (non-fatal — signup still succeeds if email fails)
  await sendWelcomeEmail({
    toEmail:     email,
    displayName: fullName.trim(),
    role:        requestedRole,
  })

  return res.status(201).json({
    message: 'Account created successfully.',
    userId,
    emailConfirmationRequired: !authData.user.email_confirmed_at,
  })
})

// ── POST /api/auth/login ──────────────────────────────────────────────────────
// Body: { email, password }
// Returns: { session, user }
router.post('/login', async (req, res) => {
  const { email, password } = req.body
  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required.' })
  }

  try {
    const { data, error } = await anonClient.auth.signInWithPassword({
      email: email.toLowerCase().trim(),
      password,
    })

    if (!error) {
      return res.json({ session: data.session, user: data.user })
    }

    // No fallback that mints a token here: one used to, for any GoTrue error
    // that wasn't a credentials error (rate limits included), without ever
    // checking the password. Its HS256 tokens were also rejected by
    // requireAuth, which verifies Supabase's ES256 key — so it only added risk.
    const msg = error.message?.toLowerCase() || ''
    if (msg.includes('confirm')) {
      return res.status(401).json({ error: 'Please confirm your email before logging in.' })
    }
    if (msg.includes('invalid') || msg.includes('credentials') || msg.includes('wrong password')) {
      return res.status(401).json({ error: 'Invalid email or password' })
    }
    return res.status(400).json({ error: error.message })

  } catch (err) {
    console.error('[login] unexpected error:', err)
    return res.status(500).json({ error: 'Login failed — please try again' })
  }
})

// ── Shared profile shape used by GET /me and after every sign-in ──────────────
async function loadProfile(userId) {
  const { data: byAuthId } = await supabase
    .from('profiles')
    .select('role, roles, display_name, is_first_login, status')
    .eq('auth_id', userId)
    .maybeSingle()

  const row = byAuthId || (await supabase
    .from('profiles')
    .select('role, roles, display_name, is_first_login, status')
    .eq('id', userId)
    .maybeSingle()
  ).data

  if (!row) return null

  const role  = row.role || 'individual'
  const roles = row.roles?.length ? row.roles : [role]
  return {
    role,
    roles,
    displayName:  row.display_name || '',
    isFirstLogin: row.is_first_login ?? false,
    status:       row.status || 'pending',
  }
}

// ── GET /api/auth/me ───────────────────────────────────────────────────────────
// The frontend used to read profiles.role/roles/display_name/... directly from
// Supabase on every page load and auth-state change. This is the one place
// that now does it, behind the same JWT check every other route already goes
// through — a session restore is just "who am I", not a raw table read.
router.get('/me', requireAuth, async (req, res) => {
  try {
    let profile = await loadProfile(req.userId)
    if (!profile) {
      // Same retry the frontend used to do — a profile insert (signup) can
      // lag a beat behind the auth row it's keyed off.
      await new Promise(r => setTimeout(r, 500))
      profile = await loadProfile(req.userId)
    }
    if (!profile) {
      return res.json({
        id: req.userId, email: req.userEmail,
        role: 'individual', roles: ['individual'],
        displayName: req.userEmail || '', isFirstLogin: false, status: 'pending',
      })
    }
    res.json({ id: req.userId, email: req.userEmail, ...profile })
  } catch (err) {
    console.error('[GET /api/auth/me]', err)
    res.status(500).json({ error: 'Failed to load profile' })
  }
})

// ── PATCH /api/auth/role ───────────────────────────────────────────────────────
// Body: { role } — switches the active role for a multi-role account
// (e.g. someone with both individual and business access).
router.patch('/role', requireAuth, async (req, res) => {
  try {
    const { role } = req.body
    if (!role) return res.status(400).json({ error: 'role is required' })

    // Only switch to a role this account already holds — otherwise any user
    // could PATCH { role: 'admin' } and requireAuth would grant admin access.
    const profile = await loadProfile(req.userId)
    if (!profile || !profile.roles.includes(role)) {
      return res.status(403).json({ error: 'You do not have access to this role' })
    }

    const { error } = await supabase
      .from('profiles')
      .update({ role })
      .eq('auth_id', req.userId)

    if (error) throw error
    res.json({ success: true, role })
  } catch (err) {
    console.error('[PATCH /api/auth/role]', err)
    res.status(500).json({ error: 'Failed to switch role' })
  }
})

// ── POST /api/auth/refresh ─────────────────────────────────────────────────────
// Body: { refresh_token } — no Bearer token required here: the whole point is
// that the access token has expired or is about to. Replaces the Supabase SDK's
// built-in auto-refresh, which only exists when the SDK owns the session.
router.post('/refresh', async (req, res) => {
  try {
    const { refresh_token } = req.body
    if (!refresh_token) return res.status(400).json({ error: 'refresh_token is required' })

    const { data, error } = await anonClient.auth.refreshSession({ refresh_token })
    if (error || !data.session) {
      return res.status(401).json({ error: error?.message || 'Could not refresh session' })
    }
    res.json({ session: data.session, user: data.user })
  } catch (err) {
    console.error('[POST /api/auth/refresh]', err)
    res.status(500).json({ error: 'Failed to refresh session' })
  }
})

// ── POST /api/auth/logout ──────────────────────────────────────────────────────
// Best-effort server-side revoke of the refresh token. The frontend clears its
// own stored tokens regardless of what this returns — sign-out must never get
// stuck because of a network blip.
router.post('/logout', async (req, res) => {
  try {
    const authHeader = req.headers['authorization'] || ''
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
    if (token) {
      await supabase.auth.admin.signOut(token)
    }
  } catch (err) {
    console.warn('[POST /api/auth/logout] best-effort revoke failed:', err.message)
  }
  res.json({ success: true })
})

module.exports = router
