const express = require('express')
const router = express.Router()
const supabase = require('../supabaseClient')

/**
 * GET /api/team
 * Returns all team members for the organisation.
 */
router.get('/', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('team_members')
      .select('id, name, email, role, created_at')
      .order('created_at', { ascending: true })

    if (error) throw error

    res.json({ members: data || [] })
  } catch (err) {
    console.error('[GET /api/team]', err.message)
    res.status(500).json({ error: 'Failed to fetch team members', detail: err.message })
  }
})

/**
 * POST /api/team
 * Invite a new team member.
 */
router.post('/', async (req, res) => {
  try {
    const { name, email, role } = req.body
    if (!email || !role) return res.status(400).json({ error: 'email and role are required' })

    const { data, error } = await supabase
      .from('team_members')
      .insert([{ name: name || email.split('@')[0], email, role }])
      .select()
      .single()

    if (error) throw error

    res.status(201).json({ member: data })
  } catch (err) {
    console.error('[POST /api/team]', err.message)
    res.status(500).json({ error: 'Failed to invite team member', detail: err.message })
  }
})

/**
 * DELETE /api/team/:id
 * Remove a team member.
 */
router.delete('/:id', async (req, res) => {
  try {
    const { error } = await supabase
      .from('team_members')
      .delete()
      .eq('id', req.params.id)

    if (error) throw error

    res.json({ success: true })
  } catch (err) {
    console.error('[DELETE /api/team/:id]', err.message)
    res.status(500).json({ error: 'Failed to remove team member', detail: err.message })
  }
})

module.exports = router