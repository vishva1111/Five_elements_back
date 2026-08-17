const express = require('express')
const router  = express.Router()
const supabase = require('../supabaseClient')

// ── POST /api/auth/signup ─────────────────────────────────────────────────────
// Body: { fullName, email, password }
// 1. Creates auth user via Supabase Admin API
// 2. Inserts a profile row with role = 'individual'
router.post('/signup', async (req, res) => {
  const { fullName, email, password } = req.body

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
    // Admin API — can create users without email confirmation
    const result = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: false,
      user_metadata: { display_name: fullName.trim() },
    })
    authData = result.data
    authErr  = result.error
  } else {
    // Anon signUp — sends confirmation email
    const { createClient } = require('@supabase/supabase-js')
    const anonClient = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_ANON_KEY,
      { auth: { autoRefreshToken: false, persistSession: false } }
    )
    const result = await anonClient.auth.signUp({
      email,
      password,
      options: { data: { display_name: fullName.trim() } },
    })
    authData = result.data
    authErr  = result.error
  }

  if (authErr) {
    // Friendly duplicate-email message
    if (authErr.message?.toLowerCase().includes('already registered') ||
        authErr.message?.toLowerCase().includes('already exists')) {
      return res.status(409).json({ error: 'An account with this email already exists.' })
    }
    return res.status(400).json({ error: authErr.message })
  }

  const userId = authData.user.id

  // 2. Insert profile row
  const profileId = `ind-${userId.slice(0, 8)}`
  const { error: profileErr } = await supabase
    .from('profiles')
    .insert({
      id:            profileId,
      auth_id:       userId,
      display_name:  fullName.trim(),
      email,
      role:          'individual',
      is_first_login: true,
    })

  if (profileErr) {
    // Non-fatal — auth user created, profile can be created on first login
    console.warn('[signup] Profile insert failed:', profileErr.message)
  }

  return res.status(201).json({
    message: 'Account created successfully.',
    userId,
    emailConfirmationRequired: !authData.user.email_confirmed_at,
  })
})

// ── POST /api/auth/login ──────────────────────────────────────────────────────
// Body: { email, password }
// Returns: { session, user }
// Note: Login is typically handled client-side via Supabase JS SDK.
// This endpoint is provided for server-side / API clients.
router.post('/login', async (req, res) => {
  const { email, password } = req.body

  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required.' })
  }

  // Use anon-key client for signInWithPassword (service role key cannot sign in as user)
  const { createClient } = require('@supabase/supabase-js')
  const anonClient = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )

  const { data, error } = await anonClient.auth.signInWithPassword({ email, password })

  if (error) {
    return res.status(401).json({ error: error.message })
  }

  return res.json({
    session: data.session,
    user:    data.user,
  })
})

module.exports = router