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

const supabase = require('../supabaseClient')

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

  // Verify the JWT with Supabase
  const { data: { user }, error } = await supabase.auth.getUser(token)

  if (error || !user) {
    return res.status(401).json({ error: 'Invalid or expired token' })
  }

  // Fetch role from profiles table
  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single()

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