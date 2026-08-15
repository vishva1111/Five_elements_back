/**
 * partner.js — /api/partner/* routes
 *
 * All routes are protected (requireAuth applied in index.js).
 * req.userId / req.role set by auth middleware.
 *
 * Routes:
 *   POST /api/partner/apply          — P1 onboarding application
 *   GET  /api/partner/dashboard      — P2 dashboard stats + recent items
 *   POST /api/partner/projects       — P3 register a new project
 *   GET  /api/partner/evidence       — P6 evidence vault list
 *   GET  /api/partner/submissions    — P7 submission tracker list
 *   GET  /api/partner/funders        — P8 funders view
 *   GET  /api/partner/team           — P9 team members
 *   POST /api/partner/team/invite    — P9 invite team member
 */

const express  = require('express')
const router   = express.Router()
const supabase = require('../supabaseClient')

// ── POST /api/partner/apply ───────────────────────────────────────────────────
router.post('/apply', async (req, res) => {
  try {
    const userId = req.userId
    const {
      orgName, orgType, regNumber, website,
      contactName, contactEmail, contactPhone, address,
      yearsActive, treeCount, references, description,
    } = req.body

    if (!orgName || !contactName || !contactEmail) {
      return res.status(400).json({ error: 'orgName, contactName, and contactEmail are required' })
    }

    const { data, error } = await supabase
      .from('partner_profiles')
      .insert({
        user_id:        userId,
        org_name:       orgName,
        org_type:       orgType || null,
        reg_number:     regNumber || null,
        website:        website || null,
        contact_name:   contactName,
        contact_email:  contactEmail,
        contact_phone:  contactPhone || null,
        address:        address || null,
        years_active:   yearsActive ? parseInt(yearsActive, 10) : null,
        tree_count_est: treeCount || null,
        ref_contacts:   references || null,
        description:    description || null,
        status:         'pending',
        applied_at:     new Date().toISOString(),
      })
      .select('id')
      .single()

    if (error) throw error
    res.status(201).json({ id: data.id, message: 'Application submitted successfully' })
  } catch (err) {
    console.error('[partner/apply]', err)
    res.status(500).json({ error: 'Failed to submit application' })
  }
})

// ── GET /api/partner/dashboard ────────────────────────────────────────────────
router.get('/dashboard', async (req, res) => {
  try {
    const userId = req.userId

    // Get partner profile
    const { data: profile } = await supabase
      .from('partner_profiles')
      .select('id, org_name, status')
      .eq('user_id', userId)
      .single()

    if (!profile) return res.json({ stats: {}, recentSubmissions: [], recentEvidence: [] })

    const partnerId = profile.id

    // Stats
    const [subRes, evRes] = await Promise.all([
      supabase.from('project_submissions').select('id, status').eq('submitted_by', userId),
      supabase.from('evidence_files').select('id').eq('submission_id', partnerId),
    ])

    const submissions = subRes.data || []
    const stats = {
      projectsActive:   submissions.filter(s => s.status === 'approved').length,
      evidencePending:  submissions.filter(s => s.status === 'pending_review').length,
      submissionsTotal: submissions.length,
      treesFunded:      0,
      tco2eVerified:    '0',
      fundersCount:     0,
    }

    // Recent submissions
    const { data: recentSubs } = await supabase
      .from('project_submissions')
      .select('id, title, status, submitted_at')
      .eq('submitted_by', userId)
      .order('submitted_at', { ascending: false })
      .limit(5)

    const recentSubmissions = (recentSubs || []).map(s => ({
      id:        s.id,
      title:     s.title,
      status:    s.status,
      updatedAt: new Date(s.submitted_at).toLocaleDateString('en-IN'),
    }))

    res.json({ stats, recentSubmissions, recentEvidence: [] })
  } catch (err) {
    console.error('[partner/dashboard]', err)
    res.status(500).json({ error: 'Failed to load dashboard' })
  }
})

// ── POST /api/partner/projects ────────────────────────────────────────────────
router.post('/projects', async (req, res) => {
  try {
    const userId = req.userId
    const { element, category, title, description, location, startDate, endDate, targetTrees, targetArea } = req.body

    if (!title || !location || !startDate) {
      return res.status(400).json({ error: 'title, location, and startDate are required' })
    }

    const { data, error } = await supabase
      .from('project_submissions')
      .insert({
        submitted_by:   userId,
        submitter_role: 'partner',
        element:        element || 'earth',
        category:       category || null,
        title,
        description:    description || null,
        location,
        start_date:     startDate,
        end_date:       endDate || null,
        tree_count:     targetTrees ? parseInt(targetTrees, 10) : null,
        partner_type:   'self',
        status:         'pending_review',
        submitted_at:   new Date().toISOString(),
      })
      .select('id')
      .single()

    if (error) throw error
    res.status(201).json({ id: data.id, message: 'Project submitted for admin review' })
  } catch (err) {
    console.error('[partner/projects]', err)
    res.status(500).json({ error: 'Failed to register project' })
  }
})

// ── GET /api/partner/evidence ─────────────────────────────────────────────────
router.get('/evidence', async (req, res) => {
  try {
    const userId = req.userId

    const { data: subs } = await supabase
      .from('project_submissions')
      .select('id, title')
      .eq('submitted_by', userId)

    const subIds = (subs || []).map(s => s.id)
    if (subIds.length === 0) return res.json({ files: [] })

    const { data: files } = await supabase
      .from('evidence_files')
      .select('id, file_name, file_type, file_size, submission_id, uploaded_at')
      .in('submission_id', subIds)
      .order('uploaded_at', { ascending: false })

    const subMap = Object.fromEntries((subs || []).map(s => [s.id, s.title]))

    const result = (files || []).map(f => ({
      id:          f.id,
      fileName:    f.file_name,
      fileType:    f.file_type,
      fileSize:    f.file_size < 1024 * 1024
        ? `${(f.file_size / 1024).toFixed(1)} KB`
        : `${(f.file_size / (1024 * 1024)).toFixed(1)} MB`,
      project:     subMap[f.submission_id] || 'Unknown',
      uploadedAt:  new Date(f.uploaded_at).toLocaleDateString('en-IN'),
      status:      'pending',
      submissionId: f.submission_id,
    }))

    res.json({ files: result })
  } catch (err) {
    console.error('[partner/evidence]', err)
    res.status(500).json({ error: 'Failed to load evidence' })
  }
})

// ── GET /api/partner/submissions ──────────────────────────────────────────────
router.get('/submissions', async (req, res) => {
  try {
    const userId = req.userId

    const { data, error } = await supabase
      .from('project_submissions')
      .select('id, title, element, status, submitted_at, file_count, review_notes')
      .eq('submitted_by', userId)
      .order('submitted_at', { ascending: false })

    if (error) throw error

    const submissions = (data || []).map(s => ({
      id:            s.id,
      title:         s.title,
      element:       s.element,
      status:        s.status,
      submittedAt:   new Date(s.submitted_at).toLocaleDateString('en-IN'),
      updatedAt:     new Date(s.submitted_at).toLocaleDateString('en-IN'),
      evidenceCount: s.file_count || 0,
      reviewNotes:   s.review_notes || null,
    }))

    res.json({ submissions })
  } catch (err) {
    console.error('[partner/submissions]', err)
    res.status(500).json({ error: 'Failed to load submissions' })
  }
})

// ── GET /api/partner/funders ──────────────────────────────────────────────────
router.get('/funders', async (req, res) => {
  try {
    const userId = req.userId

    // Get partner's approved projects (by title match via project_submissions)
    const { data: subs } = await supabase
      .from('project_submissions')
      .select('id, title')
      .eq('submitted_by', userId)
      .eq('status', 'approved')

    if (!subs || subs.length === 0) return res.json({ funders: [] })

    const projectTitles = subs.map(s => s.title)

    // Find matching projects in the projects table
    const { data: projects } = await supabase
      .from('projects')
      .select('id, name, funded_trees, funders_count')
      .in('name', projectTitles)

    if (!projects || projects.length === 0) return res.json({ funders: [] })

    const projectIds = projects.map(p => p.id)
    const projectMap = Object.fromEntries(projects.map(p => [p.id, p.name]))

    // Get ledger entries (fundings) for these projects
    const { data: entries, error } = await supabase
      .from('ledger_entries')
      .select('id, user_id, project_id, trees, amount_paid, funded_at, anonymous, funder_name, funder_type')
      .in('project_id', projectIds)
      .order('funded_at', { ascending: false })

    if (error) throw error

    const funders = (entries || []).map(e => ({
      id:          e.id,
      name:        e.anonymous ? 'Anonymous' : (e.funder_name || 'Unknown'),
      type:        e.funder_type || 'individual',
      project:     projectMap[e.project_id] || 'Unknown',
      treesFunded: e.trees || 0,
      amountPaid:  e.amount_paid ? `£${Number(e.amount_paid).toLocaleString('en-GB', { minimumFractionDigits: 2 })}` : '—',
      fundedAt:    e.funded_at ? new Date(e.funded_at).toLocaleDateString('en-IN') : '—',
      anonymous:   !!e.anonymous,
    }))

    res.json({ funders })
  } catch (err) {
    console.error('[partner/funders]', err)
    res.status(500).json({ error: 'Failed to load funders' })
  }
})

// ── GET /api/partner/team ─────────────────────────────────────────────────────
router.get('/team', async (req, res) => {
  try {
    const userId = req.userId

    const { data: profile } = await supabase
      .from('partner_profiles')
      .select('id')
      .eq('user_id', userId)
      .single()

    if (!profile) return res.json({ members: [] })

    const { data, error } = await supabase
      .from('partner_team_members')
      .select('id, name, email, role, status, joined_at')
      .eq('partner_id', profile.id)
      .order('joined_at', { ascending: false })

    if (error) throw error

    const members = (data || []).map(m => ({
      id:       m.id,
      name:     m.name,
      email:    m.email,
      role:     m.role,
      status:   m.status,
      joinedAt: new Date(m.joined_at).toLocaleDateString('en-IN'),
    }))

    res.json({ members })
  } catch (err) {
    console.error('[partner/team]', err)
    res.status(500).json({ error: 'Failed to load team' })
  }
})

// ── POST /api/partner/team/invite ─────────────────────────────────────────────
router.post('/team/invite', async (req, res) => {
  try {
    const userId = req.userId
    const { email, role } = req.body

    if (!email || !role) return res.status(400).json({ error: 'email and role are required' })

    const { data: profile } = await supabase
      .from('partner_profiles')
      .select('id')
      .eq('user_id', userId)
      .single()

    if (!profile) return res.status(404).json({ error: 'Partner profile not found' })

    const { data, error } = await supabase
      .from('partner_team_members')
      .insert({
        partner_id: profile.id,
        name:       email.split('@')[0],
        email,
        role,
        status:     'invited',
        joined_at:  new Date().toISOString(),
      })
      .select('id')
      .single()

    if (error) throw error
    res.status(201).json({ id: data.id, message: 'Invite sent' })
  } catch (err) {
    console.error('[partner/team/invite]', err)
    res.status(500).json({ error: 'Failed to send invite' })
  }
})

// ── GET /api/partner/linked-submissions ──────────────────────────────────────
// Partner sees all submissions where they are the linked partner (partner_user_id = me)
router.get('/linked-submissions', async (req, res) => {
  try {
    const userId = req.userId
    if (!userId) return res.status(401).json({ error: 'Unauthorized' })

    const { data, error } = await supabase
      .from('project_submissions')
      .select(`
        id, title, element, category, location, start_date, end_date, tree_count,
        partner_type, partner_name, partner_role,
        partner_review_status, partner_review_notes, partner_reviewed_at,
        status, submitted_by, submitted_at, outcome,
        evidence_files(id, file_name, file_type, file_size, file_url, storage_path)
      `)
      .eq('partner_user_id', userId)
      .order('submitted_at', { ascending: false })
      .limit(50)

    if (error) throw error

    res.json({ submissions: data || [] })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── PATCH /api/partner/linked-submissions/:id/review ─────────────────────────
// Partner approves or rejects a submission linked to them
// Body: { action: 'approve'|'reject', reviewNotes?: string }
router.patch('/linked-submissions/:id/review', async (req, res) => {
  try {
    const userId = req.userId
    const { id } = req.params
    const { action, reviewNotes } = req.body

    if (!userId) return res.status(401).json({ error: 'Unauthorized' })
    if (!['approve', 'reject'].includes(action)) {
      return res.status(400).json({ error: 'action must be approve or reject' })
    }

    // Verify this submission is actually linked to this partner
    const { data: sub, error: fetchErr } = await supabase
      .from('project_submissions')
      .select('id, partner_user_id, submitted_by, title')
      .eq('id', id)
      .single()

    if (fetchErr || !sub) return res.status(404).json({ error: 'Submission not found' })
    if (sub.partner_user_id !== userId) {
      return res.status(403).json({ error: 'Forbidden — this submission is not linked to you' })
    }

    const { error: updateErr } = await supabase
      .from('project_submissions')
      .update({
        partner_review_status: action === 'approve' ? 'approved' : 'rejected',
        partner_review_notes:  reviewNotes || null,
        partner_reviewed_at:   new Date().toISOString(),
      })
      .eq('id', id)

    if (updateErr) throw new Error(updateErr.message)

    // Notify the submitter of the partner's decision
    if (sub.submitted_by) {
      const { createNotification } = require('./notifications')
      await createNotification({
        userId: sub.submitted_by,
        type:   action === 'approve' ? 'partner_corroborated' : 'partner_disputed',
        title:  action === 'approve'
          ? 'Partner has corroborated your submission ✅'
          : 'Partner has raised a concern about your submission',
        body:   reviewNotes || (action === 'approve'
          ? `The partner linked to "${sub.title}" has confirmed the work.`
          : `The partner linked to "${sub.title}" has flagged a concern. The admin will review.`),
        link:   '/submit-project/review',
      })
    }

    res.json({ success: true, partnerReviewStatus: action === 'approve' ? 'approved' : 'rejected' })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

module.exports = router