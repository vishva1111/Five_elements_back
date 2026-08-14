/**
 * submitProject.js — POST /api/submit-project
 *
 * Creates a project_submission record and returns the submission ID.
 * File uploads are handled separately (direct-to-storage or a follow-up
 * multipart endpoint); this route records the metadata.
 *
 * Protected: requireAuth applied in index.js
 * req.userId / req.role set by auth middleware.
 */

const express  = require('express')
const router   = express.Router()
const supabase = require('../supabaseClient')

router.post('/', async (req, res) => {
  try {
    const userId = req.userId
    const role   = req.role || 'individual'

    const {
      element,
      category,
      type,
      title,
      description,
      location,
      startDate,
      endDate,
      treeCount,
      partnerType,
      partnerName,
      partnerContact,
      partnerRole,
      evidenceNotes,
      fileCount,
    } = req.body

    // Basic validation
    if (!title || !location || !startDate) {
      return res.status(400).json({ error: 'title, location, and startDate are required' })
    }

    // Insert submission record
    const { data, error } = await supabase
      .from('project_submissions')
      .insert({
        submitted_by:    userId,
        submitter_role:  role,
        element:         element || 'earth',
        category:        category || null,
        project_type:    type || null,
        title,
        description:     description || null,
        location,
        start_date:      startDate,
        end_date:        endDate || null,
        tree_count:      treeCount ? parseInt(treeCount, 10) : null,
        partner_type:    partnerType || 'self',
        partner_name:    partnerName || null,
        partner_contact: partnerContact || null,
        partner_role:    partnerRole || null,
        evidence_notes:  evidenceNotes || null,
        file_count:      fileCount || 0,
        status:          'pending_review',
        submitted_at:    new Date().toISOString(),
      })
      .select('id')
      .single()

    if (error) throw error

    // Determine redirect based on role
    const redirectTo = role === 'business' ? '/business/portfolio' : '/impact'

    res.status(201).json({
      id:         data.id,
      redirectTo,
      message:    'Submission received — our team will review it shortly.',
    })
  } catch (err) {
    console.error('[submit-project]', err)
    res.status(500).json({ error: 'Failed to submit project' })
  }
})

module.exports = router