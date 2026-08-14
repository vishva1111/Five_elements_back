const express  = require('express')
const router   = express.Router()
const supabase = require('../supabaseClient')

// ─── Helper: create a notification (used internally by other routes) ──────────
async function createNotification({ userId, type, title, body, link }) {
  try {
    await supabase.from('notifications').insert({ user_id: userId, type, title, body: body || '', link: link || null })
  } catch (err) {
    console.error('[notifications] Failed to create notification:', err.message)
  }
}

// ─── GET /api/notifications — fetch current user's notifications ──────────────
router.get('/', async (req, res) => {
  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '')
    if (!token) return res.status(401).json({ error: 'Unauthorized' })

    const { data: { user }, error: authErr } = await supabase.auth.getUser(token)
    if (authErr || !user) return res.status(401).json({ error: 'Unauthorized' })

    const { data, error } = await supabase
      .from('notifications')
      .select('id, type, title, body, link, read, created_at')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(50)

    if (error) throw error

    res.json({
      notifications: data || [],
      unreadCount:   (data || []).filter(n => !n.read).length,
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ─── PATCH /api/notifications/:id/read — mark one as read ────────────────────
router.patch('/:id/read', async (req, res) => {
  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '')
    const { data: { user } } = await supabase.auth.getUser(token)
    if (!user) return res.status(401).json({ error: 'Unauthorized' })

    await supabase
      .from('notifications')
      .update({ read: true })
      .eq('id', req.params.id)
      .eq('user_id', user.id)

    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ─── PATCH /api/notifications/read-all — mark all as read ────────────────────
router.patch('/read-all', async (req, res) => {
  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '')
    const { data: { user } } = await supabase.auth.getUser(token)
    if (!user) return res.status(401).json({ error: 'Unauthorized' })

    await supabase
      .from('notifications')
      .update({ read: true })
      .eq('user_id', user.id)
      .eq('read', false)

    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

module.exports = router
module.exports.createNotification = createNotification