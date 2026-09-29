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

const { createRemoteJWKSet, jwtVerify } = require('jose')
const supabase = require('../supabaseClient')

// Verifies the JWT's signature locally against Supabase's public signing key,
// instead of a network round trip to Supabase Auth on every single request
// (auth.getUser() calls /auth/v1/user remotely — ~250ms, paid by every route
// on top of the profiles lookup below). This project signs with ES256
// (asymmetric), so the key here is a PUBLIC verification key, not a secret —
// jose fetches it once from Supabase's JWKS endpoint and caches it for the
// life of the process, so only the very first request pays the network cost.
// Trade-off: a token stays valid until it expires even if the session were
// somehow revoked server-side in that window — the same as before, since
// Supabase doesn't blacklist access tokens on sign-out either way.
const JWKS = createRemoteJWKSet(new URL(`${process.env.SUPABASE_URL}/auth/v1/.well-known/jwks.json`))

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

  let payload
  try {
    ;({ payload } = await jwtVerify(token, JWKS))
  } catch (error) {
    console.error('[requireAuth] JWT verify error:', error?.message, '| token prefix:', token?.slice(0, 20))
    return res.status(401).json({ error: 'Invalid or expired token', detail: error?.message })
  }

  const userId = payload.sub

  // Fetch role from profiles table using auth_id (UUID) column.
  // profiles.id is a text slug; auth_id links to auth.users.id (UUID).
  // Falls back to querying by id in case the profile was created with UUID as id (test users).
  let profile = null
  const { data: profileByAuthId } = await supabase
    .from('profiles')
    .select('role, id')
    .eq('auth_id', userId)
    .maybeSingle()

  if (profileByAuthId) {
    profile = profileByAuthId
  } else {
    // Fallback: some profiles (e.g. test users) have UUID stored as id
    const { data: profileById } = await supabase
      .from('profiles')
      .select('role, id')
      .eq('id', userId)
      .maybeSingle()
    profile = profileById
  }

  req.userId    = userId
  req.userEmail = payload.email
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