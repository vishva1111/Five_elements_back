/**
 * submitProject.js — /api/submit-project
 *
 * Routes:
 *   POST   /          — final submit (draft → pending_review)
 *   POST   /draft     — upsert a draft row (create or update)
 *   POST   /upload    — upload evidence files to Supabase Storage + insert evidence_files rows
 *
 * Protected: requireAuth applied in index.js
 * req.userId / req.role set by auth middleware.
 */

const express  = require('express')
const router   = express.Router()
const supabase = require('../supabaseClient')
const multer   = require('multer')

// multer: store files in memory (max 40 MB per file, max 40 files)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 40 * 1024 * 1024, files: 40 },
})

// ── Helper: build submission payload from request body ────────────────────────
function buildPayload(body, userId, role) {
  const {
    element, category, type, title, description, location,
    startDate, endDate, treeCount,
    partnerType, partnerName, partnerContact, partnerRole,
    evidenceNotes, fileCount,
  } = body

  return {
    submitted_by:    userId,
    submitter_role:  role || 'individual',
    element:         element || 'earth',
    category:        category || null,
    project_type:    type || null,
    title:           title || null,
    description:     description || null,
    location:        location || null,
    start_date:      startDate || null,
    end_date:        endDate || null,
    tree_count:      treeCount ? parseInt(treeCount, 10) : null,
    partner_type:    partnerType || 'self',
    partner_name:    partnerName || null,
    partner_contact: partnerContact || null,
    partner_role:    partnerRole || null,
    evidence_notes:  evidenceNotes || null,
    file_count:      fileCount ? parseInt(fileCount, 10) : 0,
  }
}

// ── POST /api/submit-project/draft ────────────────────────────────────────────
// Upserts a draft row. If draftId is provided in the body, updates that row.
// Otherwise creates a new draft and returns the id.
router.post('/draft', async (req, res) => {
  try {
    const userId = req.userId
    const role   = req.role || 'individual'
    const { draftId } = req.body

    const payload = buildPayload(req.body, userId, role)
    payload.status = 'draft'

    let data, error

    if (draftId) {
      // Update existing draft — only if it belongs to this user and is still a draft
      ;({ data, error } = await supabase
        .from('project_submissions')
        .update(payload)
        .eq('id', draftId)
        .eq('submitted_by', userId)
        .eq('status', 'draft')
        .select('id')
        .single())
    } else {
      // Create new draft
      ;({ data, error } = await supabase
        .from('project_submissions')
        .insert({ ...payload, submitted_at: new Date().toISOString() })
        .select('id')
        .single())
    }

    if (error) throw error

    res.status(200).json({ id: data.id, message: 'Draft saved.' })
  } catch (err) {
    console.error('[submit-project/draft]', err)
    res.status(500).json({ error: 'Failed to save draft' })
  }
})

// ── POST /api/submit-project/upload ──────────────────────────────────────────
// Accepts multipart/form-data with:
//   - submissionId (field) — the draft submission id
//   - files[]             — one or more files
// Uploads each file to Supabase Storage bucket 'evidence' and inserts a row
// into evidence_files.
router.post('/upload', upload.array('files', 40), async (req, res) => {
  try {
    const userId       = req.userId
    const submissionId = req.body.submissionId

    if (!submissionId) {
      return res.status(400).json({ error: 'submissionId is required' })
    }
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No files provided' })
    }

    // Verify the submission belongs to this user
    const { data: sub, error: subErr } = await supabase
      .from('project_submissions')
      .select('id')
      .eq('id', submissionId)
      .eq('submitted_by', userId)
      .single()

    if (subErr || !sub) {
      return res.status(403).json({ error: 'Submission not found or access denied' })
    }

    const results = []

    for (const file of req.files) {
      const ext         = file.originalname.split('.').pop()
      const storagePath = `submissions/${submissionId}/${Date.now()}_${file.originalname}`

      // Upload to Supabase Storage
      const { error: uploadErr } = await supabase.storage
        .from('evidence')
        .upload(storagePath, file.buffer, {
          contentType: file.mimetype,
          upsert: false,
        })

      if (uploadErr) {
        console.error('[upload] storage error', uploadErr)
        results.push({ name: file.originalname, ok: false, error: uploadErr.message })
        continue
      }

      // Insert evidence_files row
      const { data: row, error: rowErr } = await supabase
        .from('evidence_files')
        .insert({
          submission_id: submissionId,
          file_name:     file.originalname,
          file_size:     file.size,
          file_type:     file.mimetype,
          storage_path:  storagePath,
          uploaded_at:   new Date().toISOString(),
          status:        'pending_review',
        })
        .select('id')
        .single()

      if (rowErr) {
        console.error('[upload] db error', rowErr)
        results.push({ name: file.originalname, ok: false, error: rowErr.message })
      } else {
        results.push({ name: file.originalname, ok: true, id: row.id, path: storagePath })
      }
    }

    // Update file_count on the submission
    const successCount = results.filter(r => r.ok).length
    await supabase
      .from('project_submissions')
      .update({ file_count: supabase.rpc ? undefined : successCount })
      .eq('id', submissionId)

    res.status(200).json({ uploaded: successCount, total: req.files.length, results })
  } catch (err) {
    console.error('[submit-project/upload]', err)
    res.status(500).json({ error: 'File upload failed' })
  }
})

// ── POST /api/submit-project ──────────────────────────────────────────────────
// Final submit: creates or updates a submission row with status = 'pending_review'.
// If draftId is provided, updates that draft. Otherwise creates a new record.
router.post('/', async (req, res) => {
  try {
    const userId = req.userId
    const role   = req.role || 'individual'
    const { draftId } = req.body

    const { title, location, startDate } = req.body
    if (!title || !location || !startDate) {
      return res.status(400).json({ error: 'title, location, and startDate are required' })
    }

    const payload = buildPayload(req.body, userId, role)
    payload.status       = 'pending_review'
    payload.submitted_at = new Date().toISOString()

    let data, error

    if (draftId) {
      // Promote existing draft to pending_review
      ;({ data, error } = await supabase
        .from('project_submissions')
        .update(payload)
        .eq('id', draftId)
        .eq('submitted_by', userId)
        .select('id')
        .single())
    } else {
      // Create new submission directly
      ;({ data, error } = await supabase
        .from('project_submissions')
        .insert(payload)
        .select('id')
        .single())
    }

    if (error) throw error

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