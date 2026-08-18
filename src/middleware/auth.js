/**
 * auth.js — Supabase JWT verification middleware
 *
 * Usage:
 *   const { requireAuth, requireRole } = require('../middleware/auth')
 *
 *   router.get('/protected', requireAuth, (req, res) => { ... })
 *   router.get('/admin-only', requireAuth, requireRole('admin'), (req, res) => { ... })
 *
 * On success, attaches to req:
 *   req.userId  — Supabase user UUID
 *   req.userEmail
 *   req.role    — from profiles.role column
 */

const { createClient } = require('@supabase/supabase-js')
const supabase = require('../supabaseClient')

// Use anon key for JWT verification — auth.getUser() works with anon key
const authClient = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
)

/**
 * requireAuth — verifies the Bearer JWT from the Authorization header.
 * Rejects with 401 if missing or invalid.
 */
async function requireAuth(req, res, next) {
  const authHeader = req.headers['authorization'] || ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null

  if (!token) {
    return res.status(401).json({ error: 'Missing auth token' })
  }

  // Verify the JWT with Supabase (use anon key client — works for JWT verification)
  const { data: { user }, error } = await authClient.auth.getUser(token)

  if (error || !user) {
    console.error('[requireAuth] getUser error:', error?.message, '| token prefix:', token?.slice(0, 20))
    return res.status(401).json({ error: 'Invalid or expired token', detail: error?.message })
  }

  // Fetch role from profiles table using auth_id (UUID) column.
  // profiles.id is a text slug; auth_id links to auth.users.id (UUID).
  // Falls back to querying by id in case the profile was created with UUID as id (test users).
  let profile = null
  const { data: profileByAuthId } = await supabase
    .from('profiles')
    .select('role, id')
    .eq('auth_id', user.id)
    .maybeSingle()

  if (profileByAuthId) {
    profile = profileByAuthId
  } else {
    // Fallback: some profiles (e.g. test users) have UUID stored as id
    const { data: profileById } = await supabase
      .from('profiles')
      .select('role, id')
      .eq('id', user.id)
      .maybeSingle()
    profile = profileById
  }

  req.userId    = user.id
  req.userEmail = user.email
  req.role      = profile?.role || 'individual'

  next()
}

/**
 * requireRole(role) — factory that returns a middleware checking req.role.
 * Must be used AFTER requireAuth.
 */
function requireRole(...allowedRoles) {
  return function (req, res, next) {
    if (!allowedRoles.includes(req.role)) {
      return res.status(403).json({
        error: 'Forbidden',
        detail: `This endpoint requires role: ${allowedRoles.join(' or ')}. Your role: ${req.role}`,
      })
    }
    next()
  }
}

module.exports = { requireAuth, requireRole }