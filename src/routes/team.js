const express = require('express')
const router = express.Router()
const supabase = require('../supabaseClient')
const { requireRole } = require('../middleware/auth')
const { replyIfMissingSchema, getOrgName } = require('../services/businessOrg')
const { sendTeamInviteEmail } = require('../services/emailService')

// Business Team page only (ProtectedRoute allows 'business'). Every query is
// scoped to owner_id = the signed-in account, so one business can never see or
// change another business's team.
router.use(requireRole('business', 'admin'))

const ROLES = ['Admin', 'Editor', 'Viewer']
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * GET /api/team
 * The signed-in organisation's team members.
 */
router.get('/', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('team_members')
      .select('id, name, email, role, created_at')
      .eq('owner_id', req.userId)
      .order('created_at', { ascending: true })

    if (replyIfMissingSchema(res, error)) return
    if (error) throw error

    res.json({ members: data || [] })
  } catch (err) {
    console.error('[GET /api/team]', err.message)
    res.status(500).json({ error: 'Failed to fetch team members', detail: err.message })
  }
})

/**
 * POST /api/team
 * Add a member to this organisation's team and email them.
 */
router.post('/', async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase()
    const role  = ROLES.find(r => r.toLowerCase() === String(req.body.role || '').toLowerCase())
    const name  = String(req.body.name || '').trim() || email.split('@')[0]

    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email address' })
    if (!role) return res.status(400).json({ error: 'Role must be Admin, Editor or Viewer' })

    const { data: existing, error: exErr } = await supabase
      .from('team_members')
      .select('id')
      .eq('owner_id', req.userId)
      .eq('email', email)          // stored lower-cased on insert
      .maybeSingle()
    if (replyIfMissingSchema(res, exErr)) return
    if (exErr) throw exErr
    if (existing) return res.status(409).json({ error: `${email} is already on your team` })

    const { data, error } = await supabase
      .from('team_members')
      .insert([{ name, email, role, owner_id: req.userId }])
      .select('id, name, email, role, created_at')
      .single()
    if (replyIfMissingSchema(res, error)) return
    // Unique (owner, email) index — a double-click or two tabs racing the check above.
    if (error?.code === '23505') return res.status(409).json({ error: `${email} is already on your team` })
    if (error) throw error

    const [orgName, { data: me }] = await Promise.all([
      getOrgName(req.userId),
      supabase.from('profiles').select('display_name').eq('auth_id', req.userId).maybeSingle(),
    ])
    const emailed = await sendTeamInviteEmail({
      toEmail: email, toName: name, orgName, role,
      inviterName: me?.display_name || orgName,
    })

    res.status(201).json({ member: data, emailed })
  } catch (err) {
    console.error('[POST /api/team]', err.message)
    res.status(500).json({ error: 'Failed to invite team member', detail: err.message })
  }
})

/**
 * DELETE /api/team/:id
 * Remove a member — only from this organisation's own team.
 */
router.delete('/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('team_members')
      .delete()
      .eq('id', req.params.id)
      .eq('owner_id', req.userId)
      .select('id')

    if (replyIfMissingSchema(res, error)) return
    if (error) throw error
    if (!data || data.length === 0) return res.status(404).json({ error: 'Team member not found' })

    res.json({ success: true })
  } catch (err) {
    console.error('[DELETE /api/team/:id]', err.message)
    res.status(500).json({ error: 'Failed to remove team member', detail: err.message })
  }
})

module.exports = router
