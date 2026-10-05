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
const multer   = require('multer')
const supabase = require('../supabaseClient')

// Tree photos are single images; keep the limit modest so a mistaken upload
// fails fast rather than tying up memory.
const treePhotoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 1 },
})

// Spreadsheets are small; a 10 MB cap is far above any plausible tree list and
// keeps a malformed upload from tying up memory.
const sheetUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
})

// Business KYC documents (GST certificate, PAN card, …): PDFs or images.
const businessDocUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 5 },
  fileFilter: (req, file, cb) => {
    const ok = /^(application\/pdf|image\/(png|jpe?g|webp))$/.test(file.mimetype)
    cb(ok ? null : new Error('Only PDF, PNG, JPG or WEBP files are allowed'), ok)
  },
})

const { createNotification } = require('./notifications')
const { sendAccountCreatedEmail } = require('../services/emailService')
const { withSignedUrls, signEvidencePath, BUCKET: EVIDENCE_BUCKET } = require('../services/evidenceUrls')
const { parseTreeSheet, templateCsv, MAX_ROWS } = require('../services/treeImport')
const { parseDonorSheet, templateCsv: donorTemplateCsv } = require('../services/donorImport')
const { recordFunding } = require('../services/funding')
const { syncProjectStats } = require('../services/projectStats')
const treeTasks = require('../services/treeTasks')
const { listAllAuthUsers } = require('../services/authUsers')
const {
  generateTempPassword,
  findOrCreateDonorAccount,
  getOrCreateOfflineDonorAccount,
  TEAM_ROLE_TO_PLATFORM_ROLE,
  requirePartner,
  resolveMemberAuthId,
  partnerProfileFor,
  memberInOrg,
  activeAdminCount,
  partnerScope,
  normaliseEvidenceStatus,
  formatFileSize,
  autoCreateVerificationTasks,
  partnerOwnedUserIds,
} = require('../services/partnerHelpers')

// ── POST /api/partner/apply ───────────────────────────────────────────────────
// No requirePartner here on purpose — applicants are not partners yet.
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

    // One profile per account. A second row would break every lookup below,
    // which all use maybeSingle()/single() and error on duplicates.
    const { data: existing } = await supabase
      .from('partner_profiles')
      .select('id, status')
      .eq('user_id', userId)
      .maybeSingle()

    if (existing) {
      return res.status(409).json({
        error: existing.status === 'rejected'
          ? 'Your previous application was declined. Contact support to reapply.'
          : 'You have already applied — check your application status in Settings.',
      })
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
// ── GET /api/partner/profile — this partner's own org profile (for Settings) ──
router.get('/profile', requirePartner, async (req, res) => {
  try {
    const userId = req.userId
    const { data, error } = await supabase
      .from('partner_profiles')
      .select('id, org_name, org_type, website, contact_name, contact_email, contact_phone, address, description, status')
      .eq('user_id', userId)
      .maybeSingle()

    if (error) throw error
    if (!data) return res.status(404).json({ error: 'No partner profile found for this account' })

    res.json({
      profile: {
        orgName:      data.org_name,
        orgType:      data.org_type,
        website:      data.website,
        contactName:  data.contact_name,
        contactEmail: data.contact_email,
        contactPhone: data.contact_phone,
        address:      data.address,
        description:  data.description,
        status:       data.status,
      }
    })
  } catch (err) {
    console.error('[partner/profile GET]', err)
    res.status(500).json({ error: 'Failed to load profile' })
  }
})

// ── PATCH /api/partner/profile — update self-editable org fields ──────────────
router.patch('/profile', requirePartner, async (req, res) => {
  try {
    const userId = req.userId
    const { orgName, orgType, website, contactName, contactEmail, contactPhone, address, description } = req.body

    const updates = {}
    if (orgName      !== undefined) updates.org_name      = orgName
    if (orgType      !== undefined) updates.org_type      = orgType
    if (website       !== undefined) updates.website       = website
    if (contactName  !== undefined) updates.contact_name  = contactName
    if (contactEmail !== undefined) updates.contact_email = contactEmail
    if (contactPhone !== undefined) updates.contact_phone = contactPhone
    if (address       !== undefined) updates.address       = address
    if (description   !== undefined) updates.description   = description

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No fields to update' })
    }

    const { data, error } = await supabase
      .from('partner_profiles')
      .update(updates)
      .eq('user_id', userId)
      .select('id')
      .maybeSingle()

    if (error) throw error
    if (!data) return res.status(404).json({ error: 'No partner profile found for this account' })

    res.json({ success: true })
  } catch (err) {
    console.error('[partner/profile PATCH]', err)
    res.status(500).json({ error: 'Failed to save profile' })
  }
})

router.get('/dashboard', requirePartner, async (req, res) => {
  try {
    const userId = req.userId

    const { data: profile } = await supabase
      .from('partner_profiles')
      .select('id, org_name, status')
      .eq('user_id', userId)
      .maybeSingle()

    if (!profile) {
      return res.json({ stats: {}, alerts: [], activeProjects: [], recentSubmissions: [], recentEvidence: [], fieldActivity: [] })
    }

    const { submissions, submissionIds, projectIds } = await partnerScope(userId)

    // Evidence belongs to submissions, not to the partner profile.
    const [evidenceRes, projectsRes, fundingsRes, deliveredRes, treesRes] = await Promise.all([
      submissionIds.length
        ? supabase
            .from('evidence_files')
            .select('id, file_name, status, submission_id, uploaded_at')
            .in('submission_id', submissionIds)
            .order('uploaded_at', { ascending: false })
        : Promise.resolve({ data: [] }),
      projectIds.length
        ? supabase
            .from('projects')
            .select('id, name, element, location, total_trees, funded_trees, tco2e, funders_count, evidence_count, last_evidence_date')
            .in('id', projectIds)
        : Promise.resolve({ data: [] }),
      // Funded quantity — what funders have paid for.
      projectIds.length
        ? supabase.from('individual_fundings').select('project_id, trees_funded').in('project_id', projectIds)
        : Promise.resolve({ data: [] }),
      // Delivered quantity — approved evidence only (P2-03, PG-05).
      projectIds.length
        ? supabase.from('ledger_entries').select('project_id, trees_verified').in('project_id', projectIds).is('superseded_by', null)
        : Promise.resolve({ data: [] }),
      // Field activity feed — who captured what, most recent first.
      projectIds.length
        ? supabase
            .from('tree_records')
            .select('id, user_id, project_id, species, quantity, event_type, submitted_at')
            .in('project_id', projectIds)
            .order('submitted_at', { ascending: false })
            .limit(8)
        : Promise.resolve({ data: [] }),
    ])

    const evidence = evidenceRes.data || []
    const projects = projectsRes.data || []
    const fundings = fundingsRes.data || []
    const delivered = deliveredRes.data || []
    const trees = treesRes.data || []

    // Per-project funded vs delivered, so a project card can show its own gap.
    const fundedByProject = {}
    for (const f of fundings) {
      fundedByProject[f.project_id] = (fundedByProject[f.project_id] || 0) + (f.trees_funded || 0)
    }
    const deliveredByProject = {}
    for (const d of delivered) {
      deliveredByProject[d.project_id] = (deliveredByProject[d.project_id] || 0) + (d.trees_verified || 0)
    }

    const fundedTotal = Object.values(fundedByProject).reduce((a, b) => a + b, 0)
    const deliveredTotal = Object.values(deliveredByProject).reduce((a, b) => a + b, 0)

    const stats = {
      projectsActive:   submissions.filter(s => s.status === 'approved').length,
      evidencePending:  evidence.filter(f => normaliseEvidenceStatus(f.status) === 'pending').length,
      submissionsTotal: submissions.length,
      treesFunded:      fundedTotal,
      tco2eVerified:    projects.reduce((sum, p) => sum + Number(p.tco2e || 0), 0).toFixed(2),
      fundersCount:     projects.reduce((sum, p) => sum + (p.funders_count || 0), 0),
      // The Partner's core obligation — always visible (P2-01).
      unitsDelivered:   deliveredTotal,
      unitsOwed:        Math.max(0, fundedTotal - deliveredTotal),
    }

    // Every alert links to where it is resolved — none are informational (P2-02).
    const alerts = []
    const rejected = submissions.filter(s => s.status === 'rejected')
    if (rejected.length > 0) {
      alerts.push({
        id: 'rejected',
        tone: 'warn',
        message: `${rejected.length} submission${rejected.length > 1 ? 's were' : ' was'} rejected and need${rejected.length > 1 ? '' : 's'} your attention.`,
        actionLabel: 'Review rejections',
        href: '/partner/submissions',
      })
    }
    const awaiting = submissions.filter(s => s.status === 'pending_review' || s.status === 'in_review')
    if (awaiting.length > 0) {
      alerts.push({
        id: 'awaiting',
        tone: 'info',
        message: `${awaiting.length} project${awaiting.length > 1 ? 's are' : ' is'} awaiting Super Admin approval.`,
        actionLabel: 'Track submissions',
        href: '/partner/submissions',
      })
    }
    if (stats.unitsOwed > 0) {
      alerts.push({
        id: 'owed',
        tone: 'warn',
        message: `${stats.unitsOwed.toLocaleString('en-IN')} funded units are not yet delivered.`,
        actionLabel: 'See funders',
        href: '/partner/funders',
      })
    }

    const activeProjects = projects.map(p => {
      const funded = fundedByProject[p.id] || 0
      const done = deliveredByProject[p.id] || 0
      const target = p.total_trees || 0
      return {
        id:            p.id,
        name:          p.name,
        element:       p.element,
        location:      p.location,
        target,
        delivered:     done,
        funded,
        owed:          Math.max(0, funded - done),
        progressPct:   target > 0 ? Math.min(100, Math.round((done / target) * 100)) : 0,
        fundersCount:  p.funders_count || 0,
        lastCapture:   p.last_evidence_date || null,
      }
    })

    const recentSubmissions = [...submissions]
      .sort((a, b) => new Date(b.submitted_at) - new Date(a.submitted_at))
      .slice(0, 5)
      .map(s => ({
        id:        s.id,
        title:     s.title,
        status:    s.status,
        updatedAt: s.submitted_at ? new Date(s.submitted_at).toLocaleDateString('en-IN') : '—',
      }))

    const subTitles = Object.fromEntries(submissions.map(s => [s.id, s.title]))
    const recentEvidence = evidence.slice(0, 5).map(f => ({
      id:         f.id,
      fileName:   f.file_name,
      project:    subTitles[f.submission_id] || 'Unknown',
      uploadedAt: f.uploaded_at ? new Date(f.uploaded_at).toLocaleDateString('en-IN') : '—',
    }))

    // Name the people behind the captures — evidence is always attributable (P9-04).
    const capturerIds = [...new Set(trees.map(t => t.user_id).filter(Boolean))]
    let nameMap = {}
    if (capturerIds.length > 0) {
      const { data: people } = await supabase
        .from('profiles')
        .select('auth_id, display_name')
        .in('auth_id', capturerIds)
      nameMap = Object.fromEntries((people || []).map(p => [p.auth_id, p.display_name]))
    }
    const projectNames = Object.fromEntries(projects.map(p => [p.id, p.name]))

    const fieldActivity = trees.map(t => ({
      id:        t.id,
      capturedBy: nameMap[t.user_id] || 'Field team',
      project:   projectNames[t.project_id] || t.project_id,
      species:   t.species,
      quantity:  t.quantity || 1,
      eventType: t.event_type || 'Capture',
      capturedAt: t.submitted_at ? new Date(t.submitted_at).toLocaleDateString('en-IN') : '—',
    }))

    res.json({ stats, alerts, activeProjects, recentSubmissions, recentEvidence, fieldActivity })
  } catch (err) {
    console.error('[partner/dashboard]', err)
    res.status(500).json({ error: 'Failed to load dashboard' })
  }
})

// ── POST /api/partner/projects ────────────────────────────────────────────────
// ── GET /api/partner/projects ─────────────────────────────────────────────────
// Portfolio view — this partner's own APPROVED projects, with live stats from
// the projects table (tree progress, tCO2e, evidence, funders). Distinct from
// /submissions, which tracks the review pipeline (pending/approved/rejected).
router.get('/projects', requirePartner, async (req, res) => {
  try {
    const userId = req.userId

    const { data: subs, error: subErr } = await supabase
      .from('project_submissions')
      .select('id, title, project_id, submitted_at')
      .eq('submitted_by', userId)
      .eq('status', 'approved')
      .not('project_id', 'is', null)

    if (subErr) throw subErr

    const projectIds = [...new Set((subs || []).map(s => s.project_id))]
    if (projectIds.length === 0) return res.json({ projects: [] })

    const { data: projects, error: projErr } = await supabase
      .from('projects')
      .select(`
        id, name, element, category, location, description,
        total_trees, funded_trees, tco2e, evidence_count, funders_count,
        status, active, cover_image, last_evidence_date
      `)
      .in('id', projectIds)

    if (projErr) throw projErr

    const approvedAtMap = Object.fromEntries((subs || []).map(s => [s.project_id, s.submitted_at]))

    // Trees recorded / planted in each project (one record = one tree; older
    // records may carry a quantity). Paged — PostgREST caps a request at 1000 rows.
    const recorded = {}
    const planted  = {}
    const pids = (projects || []).map(p => p.id)
    const withStage = await hasStageColumn()
    for (let from = 0; pids.length > 0; from += 1000) {
      const { data: rows, error: rowsErr } = await supabase
        .from('tree_records')
        .select('project_id, quantity' + (withStage ? ', stage' : ''))
        .in('project_id', pids)
        .range(from, from + 999)
      if (rowsErr) throw rowsErr
      for (const r of rows || []) {
        const q = Number(r.quantity) || 1
        recorded[r.project_id] = (recorded[r.project_id] || 0) + q
        if (withStage && r.stage && r.stage !== 'Under plantation') planted[r.project_id] = (planted[r.project_id] || 0) + q
      }
      if (!rows || rows.length < 1000) break
    }

    const result = (projects || []).map(p => ({
      id:              p.id,
      name:            p.name,
      element:         p.element,
      category:        p.category,
      location:        p.location,
      description:     p.description,
      totalTrees:      p.total_trees,
      fundedTrees:     p.funded_trees,
      treesRecorded:   recorded[p.id] || 0,
      treesPlanted:    planted[p.id] || 0,
      progressPct:     p.total_trees > 0 ? Math.min(100, Math.round((p.funded_trees / p.total_trees) * 100)) : 0,
      tco2e:           p.tco2e,
      evidenceCount:   p.evidence_count,
      fundersCount:    p.funders_count,
      status:          p.status,
      active:          p.active,
      coverImage:      p.cover_image,
      lastEvidenceDate: p.last_evidence_date,
      approvedAt:      approvedAtMap[p.id] || null,
    }))

    res.json({ projects: result })
  } catch (err) {
    console.error('[partner/projects GET]', err)
    res.status(500).json({ error: 'Failed to load projects' })
  }
})

// ── POST /api/partner/projects ────────────────────────────────────────────────
router.post('/projects', requirePartner, async (req, res) => {
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
router.get('/evidence', requirePartner, async (req, res) => {
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
      .select('id, file_name, file_type, file_size, status, storage_path, submission_id, uploaded_at')
      .in('submission_id', subIds)
      .order('uploaded_at', { ascending: false })

    const subMap = Object.fromEntries((subs || []).map(s => [s.id, s.title]))

    // Signed on read — the evidence bucket is private, so the grid and the
    // detail drawer need a short-lived URL to render thumbnails.
    const signed = await withSignedUrls(files || [])

    const result = signed.map(f => ({
      id:           f.id,
      fileName:     f.file_name,
      fileType:     f.file_type,
      fileSize:     formatFileSize(f.file_size),
      fileUrl:      f.file_url,
      project:      subMap[f.submission_id] || 'Unknown',
      uploadedAt:   f.uploaded_at ? new Date(f.uploaded_at).toLocaleDateString('en-IN') : '—',
      // Real review status — admin approval flows through evidence_files.status.
      status:       normaliseEvidenceStatus(f.status),
      submissionId: f.submission_id,
    }))

    res.json({ files: result })
  } catch (err) {
    console.error('[partner/evidence]', err)
    res.status(500).json({ error: 'Failed to load evidence' })
  }
})

// ── GET /api/partner/submissions ──────────────────────────────────────────────
router.get('/submissions', requirePartner, async (req, res) => {
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

// ── GET /api/partner/submissions/:id ──────────────────────────────────────────
// Full detail for a single submission — used by the "open project" detail modal.
router.get('/submissions/:id', requirePartner, async (req, res) => {
  try {
    const userId = req.userId
    const { id } = req.params

    const { data: sub, error } = await supabase
      .from('project_submissions')
      .select('*')
      .eq('id', id)
      .eq('submitted_by', userId) // partners can only open their own submissions
      .maybeSingle()

    if (error) throw error
    if (!sub) return res.status(404).json({ error: 'Submission not found' })

    const { data: files } = await supabase
      .from('evidence_files')
      .select('id, file_name, file_type, file_size, uploaded_at, status')
      .eq('submission_id', id)
      .order('uploaded_at', { ascending: false })

    res.json({
      submission: {
        id:              sub.id,
        title:           sub.title,
        element:         sub.element,
        category:        sub.category,
        projectType:     sub.project_type,
        description:     sub.description,
        location:        sub.location,
        startDate:       sub.start_date,
        endDate:         sub.end_date,
        treeCount:       sub.tree_count,
        status:          sub.status,
        submittedAt:     sub.submitted_at,
        reviewedAt:      sub.reviewed_at,
        reviewNotes:     sub.review_notes,
        partnerReviewStatus: sub.partner_review_status,
        partnerReviewNotes:  sub.partner_review_notes,
        moreInfoRequest: sub.more_info_request,
      },
      evidenceFiles: (files || []).map(f => ({
        id:         f.id,
        fileName:   f.file_name,
        fileType:   f.file_type,
        fileSize:   f.file_size < 1024 * 1024
          ? `${(f.file_size / 1024).toFixed(1)} KB`
          : `${(f.file_size / (1024 * 1024)).toFixed(1)} MB`,
        uploadedAt: f.uploaded_at,
        status:     f.status || 'pending',
      })),
    })
  } catch (err) {
    console.error('[partner/submissions/:id]', err)
    res.status(500).json({ error: 'Failed to load submission' })
  }
})

// ── GET /api/partner/funders ──────────────────────────────────────────────────
router.get('/funders', requirePartner, async (req, res) => {
  try {
    const userId = req.userId

    // Funding rows live in individual_fundings (written by POST /api/fund),
    // NOT ledger_entries — that table holds verified-delivery records instead.
    // Projects are reached through the submission's project_id, never by
    // matching titles: two partners can name a project the same thing.
    const { projectIds } = await partnerScope(userId)
    if (projectIds.length === 0) return res.json({ funders: [] })

    // Three reads that each key off projectIds alone — none depends on
    // another's result, so they run concurrently.
    const [{ data: projects }, { data: fundings, error }, { data: delivered }] = await Promise.all([
      supabase.from('projects').select('id, name').in('id', projectIds),
      supabase
        .from('individual_fundings')
        .select('id, user_id, project_id, trees_funded, amount_paid, funded_at, public_attribution, funder_name')
        .in('project_id', projectIds)
        .order('funded_at', { ascending: false }),
      // Funded vs delivered vs outstanding — delivered counts approved evidence
      // only, the same rule every other surface uses (P8-02, PG-05).
      supabase.from('ledger_entries').select('trees_verified').in('project_id', projectIds).is('superseded_by', null),
    ])

    if (error) throw error

    const projectMap = Object.fromEntries((projects || []).map(p => [p.id, p.name]))

    // Funder type isn't stored on the funding row — derive it from the profile.
    const funderIds = [...new Set((fundings || []).map(f => f.user_id).filter(Boolean))]
    let roleMap = {}
    if (funderIds.length > 0) {
      const { data: profiles } = await supabase
        .from('profiles')
        .select('auth_id, role')
        .in('auth_id', funderIds)
      roleMap = Object.fromEntries((profiles || []).map(p => [p.auth_id, p.role]))
    }

    const funders = (fundings || []).map(f => {
      const anonymous = f.public_attribution === false
      return {
        id:          f.id,
        name:        anonymous ? 'Anonymous' : (f.funder_name || 'Unknown'),
        rawName:     f.funder_name || '',
        type:        roleMap[f.user_id] === 'business' ? 'business' : 'individual',
        project:     projectMap[f.project_id] || 'Unknown',
        treesFunded: f.trees_funded || 0,
        amountPaid:  f.amount_paid != null
          ? `₹${Number(f.amount_paid).toLocaleString('en-IN')}`
          : '—',
        amountPaidRaw: f.amount_paid || 0,
        fundedAt:    f.funded_at ? new Date(f.funded_at).toLocaleDateString('en-IN') : '—',
        fundedAtRaw: f.funded_at ? f.funded_at.slice(0, 10) : '',
        anonymous,
      }
    })

    const fundedTotal = funders.reduce((sum, f) => sum + (f.treesFunded || 0), 0)
    const deliveredTotal = (delivered || []).reduce((sum, d) => sum + (d.trees_verified || 0), 0)

    res.json({
      funders,
      summary: {
        funded:      fundedTotal,
        delivered:   deliveredTotal,
        outstanding: Math.max(0, fundedTotal - deliveredTotal),
      },
    })
  } catch (err) {
    console.error('[partner/funders]', err)
    res.status(500).json({ error: 'Failed to load funders' })
  }
})

// ── PATCH /api/partner/funders/:id — correct a donation entry ───────────────
// Editable: donor name, tree count, amount, anonymity, date. Changing trees_funded
// moves projects.funded_trees by the delta so the dashboard/marketplace figures
// stay correct — the same counter POST /api/fund and the bulk import both move.
const FUNDING_EDITABLE_FIELDS = ['funder_name', 'trees_funded', 'amount_paid', 'public_attribution', 'funded_at']

router.patch('/funders/:id', requirePartner, async (req, res) => {
  try {
    const { projectIds } = await partnerScope(req.userId)
    const { data: existing } = await supabase
      .from('individual_fundings')
      .select('id, project_id, trees_funded')
      .eq('id', req.params.id)
      .maybeSingle()

    if (!existing || !projectIds.includes(existing.project_id)) {
      return res.status(404).json({ error: 'Donation record not found' })
    }

    const updates = {}
    for (const field of FUNDING_EDITABLE_FIELDS) {
      if (req.body[field] === undefined) continue
      updates[field] = req.body[field]
    }

    if (updates.funder_name !== undefined && !String(updates.funder_name).trim()) {
      return res.status(400).json({ error: 'Donor name cannot be empty' })
    }
    let treeDelta = 0
    if (updates.trees_funded !== undefined) {
      const n = Number(updates.trees_funded)
      if (!Number.isFinite(n) || n < 1) return res.status(400).json({ error: 'Trees funded must be 1 or more' })
      updates.trees_funded = Math.floor(n)
      treeDelta = updates.trees_funded - (existing.trees_funded || 0)
    }
    if (updates.amount_paid !== undefined) {
      const n = Number(updates.amount_paid)
      if (!Number.isFinite(n) || n < 0) return res.status(400).json({ error: 'Amount must be a positive number' })
      updates.amount_paid = Math.round(n)
    }
    if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'Nothing to update' })

    const { error } = await supabase.from('individual_fundings').update(updates).eq('id', existing.id)
    if (error) throw error

    if (treeDelta !== 0) await syncProjectStats([existing.project_id])

    res.json({ success: true })
  } catch (err) {
    console.error('[partner/funders/:id PATCH]', err)
    res.status(500).json({ error: 'Failed to update donation' })
  }
})

// ── DELETE /api/partner/funders/:id — remove a wrongly-entered donation ─────
// projects.funded_trees / funders_count are recomputed afterwards. Deliberately does NOT touch
// the matching ledger_entries row: individual_fundings.ledger_entry_id is a
// uuid column but ledger_entries.id is text ("ORD-..."), so the two were never
// actually linkable at write time — and the ledger is the platform's public,
// append-only record; correcting a partner's own funder list shouldn't reach
// back and edit it. If the ledger entry itself is wrong, that's a Super Admin
// correction via the existing /admin/ledger/:id/supersede path, not this one.
router.delete('/funders/:id', requirePartner, async (req, res) => {
  try {
    const { projectIds } = await partnerScope(req.userId)
    const { data: existing } = await supabase
      .from('individual_fundings')
      .select('id, project_id, trees_funded')
      .eq('id', req.params.id)
      .maybeSingle()

    if (!existing || !projectIds.includes(existing.project_id)) {
      return res.status(404).json({ error: 'Donation record not found' })
    }

    const { error } = await supabase.from('individual_fundings').delete().eq('id', existing.id)
    if (error) throw error

    await syncProjectStats([existing.project_id])

    res.json({ success: true })
  } catch (err) {
    console.error('[partner/funders/:id DELETE]', err)
    res.status(500).json({ error: 'Failed to delete donation' })
  }
})

// ── GET /api/partner/team ─────────────────────────────────────────────────────
router.get('/team', requirePartner, async (req, res) => {
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
      .select('*')
      .eq('partner_id', profile.id)
      .order('joined_at', { ascending: false })

    if (error) throw error

    // Resolve everyone to their auth account in one pass, so the UI can offer
    // "record a tree for this person" without a call per row. Independent of
    // the project-name lookup below, so both run concurrently.
    const needsLookup = (data || []).some(m => !m.user_id && m.email)
    const projectIdsOnMembers = [...new Set((data || []).map(m => m.project_id).filter(Boolean))]

    const [listed, projsRes] = await Promise.all([
      needsLookup ? listAllAuthUsers() : Promise.resolve(null),
      projectIdsOnMembers.length > 0
        ? supabase.from('projects').select('id, name').in('id', projectIdsOnMembers)
        : Promise.resolve({ data: [] }),
    ])

    let byEmail = {}
    if (listed) {
      byEmail = Object.fromEntries(
        (listed?.users || []).map(u => [String(u.email || '').toLowerCase(), u.id])
      )
    }
    const projectNameMap = Object.fromEntries((projsRes.data || []).map(p => [p.id, p.name]))

    const businessEmails = [...new Set((data || []).filter(m => m.role === 'business').map(m => String(m.email || '').toLowerCase()))]
    const businessMap = await businessDetailsFor(profile.id, businessEmails)

    const members = (data || []).map(m => {
      const authId = m.user_id || byEmail[String(m.email || '').toLowerCase()] || null
      return {
        id:           m.id,
        name:         m.name,
        email:        m.email,
        role:         m.role,
        roleLabel:    TEAM_ROLE_TO_PLATFORM_ROLE[m.role]?.label || m.role,
        status:       m.status,
        joinedAt:     m.joined_at ? new Date(m.joined_at).toLocaleDateString('en-IN') : '—',
        authId,
        canRecord:    !!authId,
        projectId:    m.project_id || null,
        projectName:  m.project_id ? (projectNameMap[m.project_id] || m.project_id) : null,
        tempPassword: m.temp_password || null,
        business:     m.role === 'business' ? (businessMap[String(m.email || '').toLowerCase()] || null) : null,
      }
    })

    res.json({ members })
  } catch (err) {
    console.error('[partner/team]', err)
    res.status(500).json({ error: 'Failed to load team' })
  }
})


// ── Business KYC (GST / PAN / address / documents) ───────────────────────────
// Stored in business_details (migration 007_business_details.sql), keyed by
// partner + email because one Business user can have a team row per project.
const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/
const PAN_RE   = /^[A-Z]{5}[0-9]{4}[A-Z]$/

/** Normalises and validates business details; returns { value } or { error }. */
function parseBusinessDetails(body, { required }) {
  const gst     = String(body.gst_number || '').toUpperCase().replace(/\s+/g, '')
  const pan     = String(body.pan_number || '').toUpperCase().replace(/\s+/g, '')
  const address = String(body.address || '').trim()

  if (required) {
    if (!gst)     return { error: 'GST number is required for a Business user' }
    if (!pan)     return { error: 'PAN number is required for a Business user' }
    if (!address) return { error: 'Address is required for a Business user' }
  }
  if (gst && !GSTIN_RE.test(gst)) return { error: 'GST number must be a valid 15-character GSTIN (e.g. 24ABCDE1234F1Z5)' }
  if (pan && !PAN_RE.test(pan))   return { error: 'PAN number must be 10 characters (e.g. ABCDE1234F)' }
  // A GSTIN embeds the PAN at characters 3–12.
  if (gst && pan && gst.slice(2, 12) !== pan) return { error: 'PAN does not match the PAN inside the GST number' }

  return { value: { gst_number: gst || null, pan_number: pan || null, address: address || null } }
}

async function businessDetailsTableReady() {
  const { error } = await supabase.from('business_details').select('id').limit(1)
  return !error
}

async function businessDetailsFor(partnerId, emails) {
  if (emails.length === 0) return {}
  const { data, error } = await supabase
    .from('business_details')
    .select('email, gst_number, pan_number, address, documents')
    .eq('partner_id', partnerId)
    .in('email', emails)
  if (error) return {}
  const out = {}
  for (const row of data || []) {
    const docs = await Promise.all((row.documents || []).map(async d => ({
      name: d.name, size: d.size, type: d.type, uploadedAt: d.uploadedAt, path: d.path,
      url: await signEvidencePath(d.path),
    })))
    out[String(row.email).toLowerCase()] = {
      gstNumber: row.gst_number, panNumber: row.pan_number, address: row.address, documents: docs,
    }
  }
  return out
}

// ── POST /api/partner/team/invite ─────────────────────────────────────────────
router.post('/team/invite', requirePartner, async (req, res) => {
  try {
    const userId = req.userId
    const { email: rawEmail, role, name, project_id: singleProjectId, project_ids: rawProjectIds, password: chosenPassword } = req.body

    if (!rawEmail || !role) return res.status(400).json({ error: 'email and role are required' })
    if (!TEAM_ROLE_TO_PLATFORM_ROLE[role]) {
      return res.status(400).json({
        error: `role must be one of: ${Object.keys(TEAM_ROLE_TO_PLATFORM_ROLE).join(', ')}`,
      })
    }
    // Same floor as public signup (auth.js) — one password rule everywhere.
    if (chosenPassword !== undefined && chosenPassword !== '' && String(chosenPassword).length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters.' })
    }

    // Users (Business/Individual) are onboarded onto a specific project — the
    // flow is Project Active -> Create Users, not "join the org generally" —
    // so a project is compulsory for them. Org-role members (admin/field
    // officer/viewer) work across the org and don't pick one.
    // project_ids (array) takes precedence over legacy project_id (string).
    const isPlatformUser = ['business', 'individual'].includes(role)
    // Normalise to an array of project IDs
    let projectIds_req = []
    if (Array.isArray(rawProjectIds) && rawProjectIds.length > 0) {
      projectIds_req = rawProjectIds.filter(Boolean)
    } else if (singleProjectId) {
      projectIds_req = [singleProjectId]
    }
    // For backward compat keep a single projectId reference (first in list)
    const projectId = projectIds_req[0] || null

    let project = null
    if (isPlatformUser) {
      if (projectIds_req.length === 0) return res.status(400).json({ error: 'Choose at least one project for this user' })
      const { projectIds: allowedIds } = await partnerScope(userId)
      const forbidden = projectIds_req.filter(id => !allowedIds.includes(id))
      if (forbidden.length > 0) {
        return res.status(403).json({ error: 'One or more projects are not in your approved projects' })
      }
      const { data: proj } = await supabase.from('projects').select('id, name').eq('id', projectId).maybeSingle()
      project = proj
    }

    const email = String(rawEmail).toLowerCase().trim()

    // Business users carry GST / PAN / address — checked before any account is made.
    let business = null
    if (role === 'business') {
      const parsed = parseBusinessDetails(req.body, { required: true })
      if (parsed.error) return res.status(400).json({ error: parsed.error })
      if (!(await businessDetailsTableReady())) {
        return res.status(400).json({ error: 'Business details are not set up in the database yet — run the setup SQL in Supabase, then restart the backend.' })
      }
      business = parsed.value
    }

    const { data: profile } = await supabase
      .from('partner_profiles')
      .select('id, org_name')
      .eq('user_id', userId)
      .maybeSingle()

    if (!profile) return res.status(404).json({ error: 'Partner profile not found' })

    // partner_team_members has no user_id column, so email is the link key.
    const { data: dupe } = await supabase
      .from('partner_team_members')
      .select('id')
      .eq('partner_id', profile.id)
      .eq('email', email)
      .maybeSingle()

    if (dupe) return res.status(409).json({ error: 'That person is already on your team' })

    const displayName = (name && name.trim()) || email.split('@')[0]
    const platform = TEAM_ROLE_TO_PLATFORM_ROLE[role]

    // ── 1. The login account. ────────────────────────────────────────────
    const listed = await listAllAuthUsers()
    let authUser = (listed?.users || []).find(u => u.email?.toLowerCase() === email)
    let tempPassword = null

    if (authUser && isPlatformUser) {
      // A User is meant to be a brand-new account, not a role bolted onto
      // whoever already holds that email elsewhere on the platform — unlike
      // Team invites (admin/field officer/viewer), which do reuse one.
      return res.status(409).json({
        error: 'An account with this email already exists. Users must be new accounts — use a different email, or manage that person from Team if they already work with you.',
      })
    }

    // A partner-chosen password is used as-is; otherwise one is generated —
    // either way `tempPassword` marks this as a freshly-created account
    // (rollback, the "invited" status, and the welcome email all key off it).
    let passwordWasChosen = false
    if (!authUser) {
      if (chosenPassword) {
        tempPassword = String(chosenPassword)
        passwordWasChosen = true
      } else {
        tempPassword = generateTempPassword()
      }
      const { data: created, error: createErr } = await supabase.auth.admin.createUser({
        email,
        password: tempPassword,
        email_confirm: true,
        user_metadata: { display_name: displayName },
      })
      if (createErr) return res.status(400).json({ error: `Could not create account: ${createErr.message}` })
      authUser = created.user
    }

    // ── 2. The platform profile, so the account passes the role guards. ─────
    const { data: existingProfile } = await supabase
      .from('profiles')
      .select('id, role, roles')
      .eq('auth_id', authUser.id)
      .maybeSingle()

    if (!existingProfile) {
      const { error: profErr } = await supabase.from('profiles').insert({
        id:             `${role === 'admin' ? 'partner' : 'field'}-${authUser.id.slice(0, 8)}`,
        auth_id:        authUser.id,
        display_name:   displayName,
        name:           displayName,
        type:           role === 'business' ? 'Business' : 'Individual',   // profiles_type_check allows Individual | Business
        location:       '',
        avatar:         '',
        trees:          0,
        t_co2e:         0,
        role:           platform.role,
        roles:          platform.roles,
        status:         'active',
        is_first_login: true,
      })
      if (profErr) return res.status(500).json({ error: `Profile creation failed: ${profErr.message}` })
    } else {
      // Existing account — add the capabilities without dropping what they have.
      const roles = Array.isArray(existingProfile.roles) ? existingProfile.roles : []
      const merged = [...new Set([...roles, ...platform.roles])]
      const updates = { roles: merged }
      // Only promote the primary role upward (to partner); never demote.
      if (platform.role === 'partner' && existingProfile.role !== 'admin') updates.role = 'partner'
      if (merged.length !== roles.length || updates.role) {
        await supabase.from('profiles').update(updates).eq('id', existingProfile.id)
      }
    }

    // ── 3. The team row(s). ─────────────────────────────────────────────────
    // For platform users with multiple projects, insert one row per project.
    // For org-role members (admin/field officer/viewer), insert a single row.
    const baseRow = {
      partner_id:    profile.id,
      name:          displayName,
      email,
      role,
      status:        tempPassword ? 'invited' : 'active',
      joined_at:     new Date().toISOString(),
      ...(tempPassword ? { temp_password: tempPassword } : {}),
    }

    const rowsToInsert = isPlatformUser && projectIds_req.length > 1
      ? projectIds_req.map(pid => ({ ...baseRow, project_id: pid }))
      : [{ ...baseRow, ...(isPlatformUser ? { project_id: projectId } : {}) }]

    // user_id arrives with migration 003, project_id with migration 004. Try
    // the fully-linked insert first and fall back column-by-column if either
    // is missing, so Team invites keep working on an older DB — but a User
    // needs project_id to mean anything, so its absence has to be a clear
    // error, not a silent drop of a field the whole feature depends on.
    const rowsWithUserId = rowsToInsert.map(r => ({ ...r, user_id: authUser.id }))
    let { data, error } = await supabase
      .from('partner_team_members')
      .insert(rowsWithUserId.length === 1 ? rowsWithUserId[0] : rowsWithUserId)
      .select('id')
      .maybeSingle()

    if (error && /user_id/.test(String(error.message || ''))) {
      ({ data, error } = await supabase
        .from('partner_team_members')
        .insert(rowsToInsert.length === 1 ? rowsToInsert[0] : rowsToInsert)
        .select('id')
        .maybeSingle())
    }

    // The team row is what actually links the auth account to this partner.
    // If it never lands — a missing migration, a constraint, anything — a
    // freshly-minted account (tempPassword set) must not survive as an orphan
    // with no membership and no way for the partner to reach it again.
    async function rollbackFreshAccount() {
      if (!tempPassword) return
      try { await supabase.auth.admin.deleteUser(authUser.id) } catch (e) { console.error('[rollbackFreshAccount] auth delete failed:', e.message) }
      try { await supabase.from('profiles').delete().eq('auth_id', authUser.id) } catch (e) { console.error('[rollbackFreshAccount] profile delete failed:', e.message) }
    }

    if (error && isPlatformUser && /project_id/.test(String(error.message || ''))) {
      await rollbackFreshAccount()
      return res.status(400).json({
        error: `"${platform.label}" accounts need migration 004_partner_team_members_project.sql to be run first.`,
      })
    }

    if (error) {
      // Migration 003 widens the role CHECK and adds user_id. Without it the
      // two platform account types cannot be stored, so say so plainly rather
      // than surfacing a raw Postgres error.
      const msg = String(error.message || '')
      if (msg.includes('partner_team_members_role_check')) {
        await rollbackFreshAccount()
        return res.status(400).json({
          error: `"${platform.label}" accounts need migration 003_partner_can_create_platform_users.sql to be run first.`,
        })
      }
      await rollbackFreshAccount()
      throw error
    }

    // ── 3b. Business KYC details. ───────────────────────────────────────────
    if (business) {
      const { error: bizErr } = await supabase
        .from('business_details')
        .upsert({ partner_id: profile.id, email, ...business, updated_at: new Date().toISOString() }, { onConflict: 'partner_id,email' })
      if (bizErr) console.error('[partner/team/invite] business details not saved:', bizErr.message)
    }

    // ── 4. Tell them. ───────────────────────────────────────────────────────
    if (tempPassword) {
      await sendAccountCreatedEmail({
        toEmail:     email,
        displayName,
        roleLabel:   platform.label,
        tempPassword,
        orgName:     profile.org_name,
      }).catch(e => console.error('[partner/team/invite] email failed:', e.message))
    } else {
      await createNotification({
        userId: authUser.id,
        type:   'team_invite',
        title:  `You've been added to ${profile.org_name || 'a partner team'}`,
        body:   `Your existing account now has ${platform.label} access.`,
        link:   '/login',
      }).catch(() => {})
    }

    res.status(201).json({
      id: data.id,
      message: isPlatformUser ? 'User created' : 'Invite sent',
      // Shown once to the partner so they can pass it on if the email bounces.
      tempPassword,
      passwordWasChosen,
      reusedExistingAccount: !tempPassword,
      roleLabel: platform.label,
      signInAt:  platform.home,
      projectId: project?.id || null,
      projectName: project?.name || null,
    })
  } catch (err) {
    console.error('[partner/team/invite]', err)
    res.status(500).json({ error: 'Failed to send invite' })
  }
})


// ── PUT /api/partner/team/:id/business — update GST / PAN / address ──────────
router.put('/team/:id/business', requirePartner, async (req, res) => {
  try {
    const profile = await partnerProfileFor(req.userId)
    if (!profile) return res.status(404).json({ error: 'Partner profile not found' })
    const member = await memberInOrg(profile.id, req.params.id)
    if (!member || member.role !== 'business') return res.status(404).json({ error: 'Business user not found' })

    const parsed = parseBusinessDetails(req.body, { required: true })
    if (parsed.error) return res.status(400).json({ error: parsed.error })

    const { error } = await supabase
      .from('business_details')
      .upsert({ partner_id: profile.id, email: String(member.email).toLowerCase(), ...parsed.value, updated_at: new Date().toISOString() }, { onConflict: 'partner_id,email' })
    if (error) {
      if (error.code === '42P01') return res.status(400).json({ error: 'Business details are not set up in the database yet — run the setup SQL in Supabase, then restart the backend.' })
      throw error
    }
    res.json({ success: true })
  } catch (err) {
    console.error('[partner/team/:id/business PUT]', err)
    res.status(500).json({ error: err.message || 'Failed to save business details' })
  }
})

// ── POST /api/partner/team/:id/documents — optional KYC documents ────────────
router.post('/team/:id/documents', requirePartner, (req, res, next) => {
  businessDocUpload.array('files', 5)(req, res, err => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Each file must be 10 MB or smaller' : err.message })
    next()
  })
}, async (req, res) => {
  try {
    const profile = await partnerProfileFor(req.userId)
    if (!profile) return res.status(404).json({ error: 'Partner profile not found' })
    const member = await memberInOrg(profile.id, req.params.id)
    if (!member || member.role !== 'business') return res.status(404).json({ error: 'Business user not found' })
    if (!req.files?.length) return res.status(400).json({ error: 'Choose at least one file' })

    const email = String(member.email).toLowerCase()
    const { data: existing, error: readErr } = await supabase
      .from('business_details')
      .select('documents')
      .eq('partner_id', profile.id)
      .eq('email', email)
      .maybeSingle()
    if (readErr) {
      if (readErr.code === '42P01') return res.status(400).json({ error: 'Business details are not set up in the database yet — run the setup SQL in Supabase, then restart the backend.' })
      throw readErr
    }

    const uploaded = []
    for (const f of req.files) {
      const safe = f.originalname.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(-80)
      const path = `business-docs/${profile.id}/${email.replace(/[^a-z0-9]+/g, '_')}/${Date.now()}_${safe}`
      const { error: upErr } = await supabase.storage.from(EVIDENCE_BUCKET).upload(path, f.buffer, { contentType: f.mimetype, upsert: false })
      if (upErr) return res.status(500).json({ error: `Upload failed for ${f.originalname}: ${upErr.message}` })
      uploaded.push({ name: f.originalname, path, size: f.size, type: f.mimetype, uploadedAt: new Date().toISOString() })
    }

    const documents = [...(existing?.documents || []), ...uploaded]
    const { error } = await supabase
      .from('business_details')
      .upsert({ partner_id: profile.id, email, documents, updated_at: new Date().toISOString() }, { onConflict: 'partner_id,email' })
    if (error) throw error

    res.status(201).json({ uploaded: uploaded.length })
  } catch (err) {
    console.error('[partner/team/:id/documents POST]', err)
    res.status(500).json({ error: err.message || 'Failed to upload documents' })
  }
})

// ── DELETE /api/partner/team/:id/documents?path=… — remove one document ──────
router.delete('/team/:id/documents', requirePartner, async (req, res) => {
  try {
    const profile = await partnerProfileFor(req.userId)
    if (!profile) return res.status(404).json({ error: 'Partner profile not found' })
    const member = await memberInOrg(profile.id, req.params.id)
    if (!member || member.role !== 'business') return res.status(404).json({ error: 'Business user not found' })

    const email = String(member.email).toLowerCase()
    const target = String(req.query.path || '')
    const { data: existing } = await supabase
      .from('business_details')
      .select('documents')
      .eq('partner_id', profile.id)
      .eq('email', email)
      .maybeSingle()
    const docs = existing?.documents || []
    if (!docs.some(d => d.path === target)) return res.status(404).json({ error: 'Document not found' })

    await supabase.storage.from(EVIDENCE_BUCKET).remove([target])
    const { error } = await supabase
      .from('business_details')
      .update({ documents: docs.filter(d => d.path !== target), updated_at: new Date().toISOString() })
      .eq('partner_id', profile.id)
      .eq('email', email)
    if (error) throw error
    res.json({ success: true })
  } catch (err) {
    console.error('[partner/team/:id/documents DELETE]', err)
    res.status(500).json({ error: err.message || 'Failed to remove document' })
  }
})

// ── PATCH /api/partner/team/:id — change a member's status or role ───────────
// Backs the Deactivate action in P9, which previously only changed local state.
router.patch('/team/:id', requirePartner, async (req, res) => {
  try {
    const { id } = req.params
    const { status, role, name, project_id: projectId, password } = req.body

    if (status === undefined && role === undefined && name === undefined && password === undefined) {
      return res.status(400).json({ error: 'Nothing to update' })
    }
    if (password !== undefined && String(password).length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters.' })
    }
    if (status !== undefined && !['active', 'invited', 'inactive'].includes(status)) {
      return res.status(400).json({ error: 'status must be active, invited or inactive' })
    }
    if (role !== undefined && !TEAM_ROLE_TO_PLATFORM_ROLE[role]) {
      return res.status(400).json({
        error: `role must be one of: ${Object.keys(TEAM_ROLE_TO_PLATFORM_ROLE).join(', ')}`,
      })
    }

    const profile = await partnerProfileFor(req.userId)
    if (!profile) return res.status(404).json({ error: 'Partner profile not found' })

    const member = await memberInOrg(profile.id, id)
    if (!member) return res.status(404).json({ error: 'Team member not found' })

    // Changing someone into a Business/Individual User needs the same
    // compulsory project a fresh User is created with — a project supplied
    // now, or one the member already carries.
    let projectUpdate = null
    if (role !== undefined && ['business', 'individual'].includes(role)) {
      const targetProjectId = projectId || member.project_id
      if (!targetProjectId) {
        return res.status(400).json({ error: 'Choose a project for this account type' })
      }
      if (projectId) {
        const { projectIds } = await partnerScope(req.userId)
        if (!projectIds.includes(projectId)) {
          return res.status(403).json({ error: 'That project is not one of your approved projects' })
        }
        projectUpdate = projectId
      }
    }

    // An org must keep at least one active admin, or nobody can manage it.
    const losingAdmin = member.role === 'admin' && member.status === 'active' &&
      ((status !== undefined && status !== 'active') || (role !== undefined && role !== 'admin'))

    if (losingAdmin && (await activeAdminCount(profile.id)) <= 1) {
      return res.status(409).json({ error: 'This is the last active admin — promote someone else first.' })
    }

    const updates = {}
    if (status !== undefined) updates.status = status
    if (role   !== undefined) updates.role   = role
    if (name   !== undefined) {
      if (!String(name).trim()) return res.status(400).json({ error: 'Name cannot be empty' })
      updates.name = String(name).trim()
    }
    if (projectUpdate) updates.project_id = projectUpdate

    const { error } = await supabase
      .from('partner_team_members')
      .update(updates)
      .eq('id', id)
      .eq('partner_id', profile.id)

    if (error) {
      if (/role_check/.test(String(error.message || ''))) {
        return res.status(400).json({
          error: `"${TEAM_ROLE_TO_PLATFORM_ROLE[role]?.label || role}" needs migration 003_partner_can_create_platform_users.sql to be run first.`,
        })
      }
      throw error
    }

    // A role change must follow through to the account, or the person keeps the
    // access their old role gave them.
    let accessWarning = null
    if (role !== undefined && role !== member.role) {
      const authId = await resolveMemberAuthId(member)
      if (!authId) {
        accessWarning = 'Role updated, but no sign-in account was found for this person.'
      } else {
        const platform = TEAM_ROLE_TO_PLATFORM_ROLE[role]
        const { data: prof } = await supabase
          .from('profiles')
          .select('id, role, roles')
          .eq('auth_id', authId)
          .maybeSingle()

        if (prof) {
          const merged = [...new Set([...(prof.roles || []), ...platform.roles])]
          await supabase
            .from('profiles')
            .update({ role: platform.role, roles: merged })
            .eq('id', prof.id)
        } else {
          accessWarning = 'Role updated, but this person has no profile yet.'
        }
      }
    }

    if (name !== undefined) {
      const authId = await resolveMemberAuthId(member)
      if (authId) {
        await supabase
          .from('profiles')
          .update({ display_name: String(name).trim() })
          .eq('auth_id', authId)
      }
    }

    // Password reset — only possible if the member has a linked auth account.
    if (password !== undefined && String(password).trim()) {
      const authId = await resolveMemberAuthId(member)
      if (!authId) {
        return res.status(400).json({ error: 'No sign-in account found for this member — cannot change password.' })
      }
      const { error: pwErr } = await supabase.auth.admin.updateUserById(authId, {
        password: String(password),
      })
      if (pwErr) {
        return res.status(400).json({ error: `Password update failed: ${pwErr.message}` })
      }
      // Store the new password so the partner can see it in the edit modal next time.
      await supabase
        .from('partner_team_members')
        .update({ temp_password: String(password) })
        .eq('id', id)
        .eq('partner_id', profile.id)
    }

    res.json({ success: true, warning: accessWarning })
  } catch (err) {
    console.error('[partner/team PATCH]', err)
    res.status(500).json({ error: 'Failed to update team member' })
  }
})

// ── GET /api/partner/team/:id — one member, with the work recorded for them ──
router.get('/team/:id', requirePartner, async (req, res) => {
  try {
    const { id } = req.params

    const profile = await partnerProfileFor(req.userId)
    if (!profile) return res.status(404).json({ error: 'Partner profile not found' })

    const member = await memberInOrg(profile.id, id)
    if (!member) return res.status(404).json({ error: 'Team member not found' })

    const authId = await resolveMemberAuthId(member)

    // Only work against this partner's own projects is theirs to show.
    const { projectIds } = await partnerScope(req.userId)
    let trees = []
    if (authId && projectIds.length > 0) {
      const { data } = await supabase
        .from('tree_records')
        .select('id, species, quantity, event_type, project_id, submitted_at, photo_url')
        .eq('user_id', authId)
        .in('project_id', projectIds)
        .order('submitted_at', { ascending: false })
        .limit(50)
      trees = data || []
    }

    const { data: projects } = projectIds.length
      ? await supabase.from('projects').select('id, name').in('id', projectIds)
      : { data: [] }
    const projectNames = Object.fromEntries((projects || []).map(p => [p.id, p.name]))

    res.json({
      member: {
        id:        member.id,
        name:      member.name,
        email:     member.email,
        role:      member.role,
        roleLabel: TEAM_ROLE_TO_PLATFORM_ROLE[member.role]?.label || member.role,
        status:    member.status,
        joinedAt:  member.joined_at ? new Date(member.joined_at).toLocaleDateString('en-IN') : '—',
        authId,
        canRecord: !!authId,
        projectId:   member.project_id || null,
        projectName: member.project_id ? (projectNames[member.project_id] || member.project_id) : null,
      },
      trees: trees.map(t => ({
        id:        t.id,
        species:   t.species,
        quantity:  t.quantity || 1,
        eventType: t.event_type || 'Capture',
        project:   projectNames[t.project_id] || t.project_id,
        photoUrl:  t.photo_url || null,
        capturedAt: t.submitted_at ? new Date(t.submitted_at).toLocaleDateString('en-IN') : '—',
      })),
      treeTotal: trees.reduce((sum, t) => sum + (t.quantity || 1), 0),
    })
  } catch (err) {
    console.error('[partner/team GET :id]', err)
    res.status(500).json({ error: 'Failed to load team member' })
  }
})

// ── DELETE /api/partner/team/:id — remove someone from this org ──────────────
// Removes the membership only. The person keeps their Five Elements account and
// every tree recorded for them stays in place: deleting the account would orphan
// evidence the ledger depends on, and the record's integrity is the product.
router.delete('/team/:id', requirePartner, async (req, res) => {
  try {
    const { id } = req.params

    const profile = await partnerProfileFor(req.userId)
    if (!profile) return res.status(404).json({ error: 'Partner profile not found' })

    const member = await memberInOrg(profile.id, id)
    if (!member) return res.status(404).json({ error: 'Team member not found' })

    if (member.role === 'admin' && member.status === 'active' &&
        (await activeAdminCount(profile.id)) <= 1) {
      return res.status(409).json({ error: 'This is the last active admin — promote someone else first.' })
    }

    // Don't let a partner remove themselves and lock the org out.
    const authId = await resolveMemberAuthId(member)
    if (authId && authId === req.userId) {
      return res.status(409).json({ error: "You can't remove your own membership." })
    }

    const { error } = await supabase
      .from('partner_team_members')
      .delete()
      .eq('id', id)
      .eq('partner_id', profile.id)

    if (error) throw error

    res.json({
      success: true,
      message: `${member.name || member.email} removed from your team. Their account and recorded work are untouched.`,
    })
  } catch (err) {
    console.error('[partner/team DELETE]', err)
    res.status(500).json({ error: 'Failed to remove team member' })
  }
})

// autoCreateVerificationTasks is imported above, alongside the other partner helpers.

// ── GET /api/partner/team-users ──────────────────────────────────────────────
// The people a partner may record work against: their own team members, each
// resolved to the auth account that owns the resulting tree_records row.
//
// user_id arrives with migration 003; before that the link is by email, which
// is what the invite flow has always written. Both paths are supported so this
// works either side of the migration.
router.get('/team-users', requirePartner, async (req, res) => {
  try {
    const userId = req.userId

    const { data: profile } = await supabase
      .from('partner_profiles')
      .select('id, org_name')
      .eq('user_id', userId)
      .maybeSingle()

    if (!profile) return res.json({ users: [] })

    const { data: members, error } = await supabase
      .from('partner_team_members')
      .select('*')
      .eq('partner_id', profile.id)
      .neq('status', 'inactive')

    if (error) throw error

    // Resolve the members that have no user_id yet by email.
    const needsEmailLookup = (members || []).filter(m => !m.user_id && m.email)
    let byEmail = {}
    if (needsEmailLookup.length > 0) {
      const listed = await listAllAuthUsers()
      byEmail = Object.fromEntries(
        (listed?.users || []).map(u => [String(u.email || '').toLowerCase(), u.id])
      )
    }

    const users = (members || [])
      .map(m => ({
        teamMemberId: m.id,
        authId:       m.user_id || byEmail[String(m.email || '').toLowerCase()] || null,
        name:         m.name,
        email:        m.email,
        role:         m.role,
        roleLabel:    TEAM_ROLE_TO_PLATFORM_ROLE[m.role]?.label || m.role,
        status:       m.status,
        // If they were created for a specific project, work for them stays
        // there — Add Tree locks the project field once this is set.
        projectId:    m.project_id || null,
      }))
      // Someone with no account cannot own a record; surface them as unusable
      // rather than hiding them, so the partner understands why.
      // If no real auth account exists, we still allow the partner to record
      // work for this member — the tree record will be owned by the partner's
      // own auth ID and the member is identified by a "member:<id>" sentinel.
      .map(u => ({
        ...u,
        canRecord: true,
        effectiveId: u.authId || `member:${u.teamMemberId}`,
      }))

    res.json({ users, orgName: profile.org_name })
  } catch (err) {
    console.error('[partner/team-users]', err)
    res.status(500).json({ error: 'Failed to load team users' })
  }
})

// ── POST /api/partner/trees ──────────────────────────────────────────────────
// A partner records a tree on behalf of one of their users.
//
// The record is owned by that user (tree_records.user_id), because delivery and
// attribution follow the person the work belongs to. Who actually typed it in is
// kept in `surveyor`, so the entry is never silently misattributed.
//
// Accepts multipart (with an optional photo) or plain JSON.
// partnerOwnedUserIds is imported above, alongside the other partner helpers.

// ── Tree species reference (Action listing / Add trees) ─────────────────────
// Served from the tree_species table (migration 006_tree_species.sql). Until
// that table exists, the same built-in list is served so the console still works.
const DEFAULT_TREE_SPECIES = [
  ['Teak', 'Tectona grandis L.', 46], ['Mahogany', 'Swietenia macrophylla', 40],
  ['Khaya', 'Khaya senegalensis', 36], ['Seesam', 'Dalbergia latifolia', 35],
  ['Arjun Sadad', 'Terminalia arjuna', 30], ['Rain Tree', 'Samanea saman', 28.8],
  ['Vad', 'Ficus benghalensis', 28], ['Baheda', 'Terminalia bellirica', 28],
  ['Jackfruit', 'Artocarpus heterophyllus', 25], ['Siras', 'Albizia lebbeck', 22.5],
  ['Aamba', 'Mangifera indica', 22], ['Piplo', 'Ficus religiosa', 21.5],
  ['Amla', 'Phyllanthus emblica', 20], ['Jamun', 'Syzygium cumini', 20],
  ['Acacia', 'Acacia auriculiformis', 20], ['Kigelia (Sausage Tree)', 'Kigelia africana', 20],
  ['Saag', 'Tectona grandis', 19], ['Mahua', 'Madhuca longifolia', 18],
  ['Biyo', 'Pterocarpus marsupium', 17], ['Flame of the Forest', 'Butea monosperma', 15],
  ['Gunda', 'Cordia dichotoma', 15], ['Neem', 'Azadirachta indica', 14.3],
  ['Moringa', 'Moringa oleifera', 12.2], ['Cassia', 'Cassia javanica', 12],
  ['Guava', 'Psidium guajava', 10], ['Sindoor', 'Bixa orellana', 10],
  ['Tecoma', 'Tecoma stans', 6],
].map(([name, scientific, co2PerYear]) => ({ id: null, name, scientific, co2PerYear, isDefault: true }))

const speciesRow = (r) => ({
  id:         r.id,
  name:       r.name,
  scientific: r.scientific_name || '',
  co2PerYear: Number(r.co2_per_year),
  isDefault:  !!r.is_default,
})

// GET /api/partner/species — the full list, highest CO₂ first.
router.get('/species', requirePartner, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('tree_species')
      .select('id, name, scientific_name, co2_per_year, is_default')
      .order('co2_per_year', { ascending: false })
    if (error) {
      console.warn('[partner/species] tree_species missing — run the setup SQL in Supabase:', error.message)
      return res.json({ species: DEFAULT_TREE_SPECIES, persisted: false })
    }
    res.json({ species: (data || []).map(speciesRow), persisted: true })
  } catch (err) {
    console.error('[partner/species GET]', err)
    res.status(500).json({ error: 'Failed to load species' })
  }
})

// POST /api/partner/species — add a species that is not in the list yet.
router.post('/species', requirePartner, async (req, res) => {
  try {
    const name       = String(req.body?.name || '').trim()
    const scientific = String(req.body?.scientific || '').trim()
    const co2        = Number(req.body?.co2PerYear)
    if (!name) return res.status(400).json({ error: 'Common name is required' })
    if (!Number.isFinite(co2) || co2 < 0) return res.status(400).json({ error: 'CO₂ kg/year must be a number' })

    const { data, error } = await supabase
      .from('tree_species')
      .insert({ name, scientific_name: scientific || null, co2_per_year: co2, created_by: req.userId })
      .select('id, name, scientific_name, co2_per_year, is_default')
      .single()
    if (error) {
      if (error.code === '23505') return res.status(409).json({ error: 'This species is already in the list' })
      if (error.code === '42P01') return res.status(503).json({ error: 'Species are not set up in the database yet — run the setup SQL in Supabase, then restart the backend.' })
      throw error
    }
    res.status(201).json({ species: speciesRow(data) })
  } catch (err) {
    console.error('[partner/species POST]', err)
    res.status(500).json({ error: err.message || 'Failed to add species' })
  }
})

// Tree lifecycle stages the partner can set (Assign action form / edit).
const TREE_STAGES = ['Under plantation', 'Planted']

// Flow: tree added (Under plantation) → planting task → field operator plants it
// → partner approves → Planted → audit task → field operator surveys it →
// partner approves (ledger) or rejects (redo). Stages from Planted on need the audit.
const TASK_STAGES = ['Planted']

/** Audit task for a planted tree, unless it already has one (see services/treeTasks.js). */
const ensureVerificationTask = (treeId, partnerUserId) => treeTasks.ensureAuditTask(treeId, partnerUserId)

// `stage`, `team_member_id` and `assigned_to` come from migration 005_tree_stage.sql.
// Until it has been run, keep everything working without them instead of
// failing every request.
const columnChecks = {}
function hasTreeColumn(col) {
  if (!columnChecks[col]) {
    columnChecks[col] = supabase.from('tree_records').select(col).limit(1)
      .then(({ error }) => {
        if (error) {
          console.warn(`[partner/trees] tree_records.${col} missing — run the setup SQL in Supabase`)
          delete columnChecks[col] // look again next time, the migration may have been run since
          return false
        }
        return true
      })
  }
  return columnChecks[col]
}
const hasStageColumn    = () => hasTreeColumn('stage')
const hasAssignedColumn = () => hasTreeColumn('assigned_to')

// Who the tree was recorded for, kept on the row itself (see migration 005).
async function assignmentFields(member) {
  if (!member || !(await hasAssignedColumn())) return {}
  return {
    team_member_id: member.id,
    assigned_to:    member.name || member.email || null,
  }
}

// Human-readable ID, same "TREE-" style the field app uses.
// Several are minted in one request (one per tree), so this is fully random:
// 7 characters from 36 → ~78 billion combinations.
const TREE_CODE_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'
function newTreeCode() {
  const bytes = require('crypto').randomBytes(7)
  let code = ''
  for (const b of bytes) code += TREE_CODE_ALPHABET[b % 36]
  return `TREE-${code}`
}

// One record per physical tree — each gets its own Tree ID and, once planted,
// its own verification task. Capped so a typo can't create a runaway batch.
const MAX_TREES_PER_ENTRY = 500

// ── GET /api/partner/trees — list, for the partner's own people/projects ────
router.get('/trees', requirePartner, async (req, res) => {
  try {
    const { userIds: ownedIds } = await partnerOwnedUserIds(req.userId)
    // Always include the partner's own auth ID so records they entered directly
    // (e.g. seeded data or records added via the partner account) are visible.
    const userIds = [...new Set([...ownedIds, req.userId])]

    const { projectIds } = await partnerScope(req.userId)
    if (projectIds.length === 0) return res.json({ trees: [] })

    const [withStage, withAssigned] = await Promise.all([hasStageColumn(), hasAssignedColumn()])
    let query = supabase
      .from('tree_records')
      .select('id, tree_id, species, scientific_name, quantity, event_type, health_status, tree_condition, latitude, longitude, photo_url, notes, project_id, user_id, surveyor, submitted_at, survey_date'
        + (withStage ? ', stage' : '')
        + (withAssigned ? ', assigned_to, team_member_id' : ''))
      .in('user_id', userIds)
      .in('project_id', projectIds)
      .order('submitted_at', { ascending: false })
      .limit(500)

    if (req.query.project_id) query = query.eq('project_id', req.query.project_id)
    if (req.query.user_id)    query = query.eq('user_id', req.query.user_id)

    const { data: rawTrees, error } = await query
    if (error) throw error
    // A field-app capture that completed a task is evidence for its tree, not a tree of its own.
    const captures = await treeTasks.captureTreeIds()
    const data = (rawTrees || []).filter(t => !captures.has(t.id))

    const uniqueUserIds = [...new Set((data || []).map(t => t.user_id))]
    const uniqueProjectIds = [...new Set((data || []).map(t => t.project_id))]
    const [namesRes, projectsRes, tasksRes] = await Promise.all([
      uniqueUserIds.length
        ? supabase.from('profiles').select('auth_id, display_name').in('auth_id', uniqueUserIds)
        : Promise.resolve({ data: [] }),
      uniqueProjectIds.length
        ? supabase.from('projects').select('id, name').in('id', uniqueProjectIds)
        : Promise.resolve({ data: [] }),
      // So the list can show "task pending" / "verified" without a second round trip per row.
      treeTasks.tasksForTrees((data || []).map(t => t.id)),
    ])
    const nameMap    = Object.fromEntries((namesRes.data || []).map(p => [p.auth_id, p.display_name]))
    const projectMap = Object.fromEntries((projectsRes.data || []).map(p => [p.id, p.name]))
    // The task that matters right now: planting while under plantation, audit after.
    const taskMap = {}
    for (const t of data || []) {
      const slot = tasksRes[t.id] || {}
      const planted = t.stage && t.stage !== 'Under plantation'
      taskMap[t.id] = planted ? (slot.audit || null) : (slot.planting || (withStage ? null : slot.audit) || null)
    }
    // Names of the field operators on those tasks, and the captures that completed them.
    const currentTasks = Object.values(taskMap).filter(Boolean)
    const assigneeIds = [...new Set(currentTasks.map(t => t.assignee_id).filter(Boolean))]
    const captureIds  = [...new Set(currentTasks.map(t => t.capture_tree_id).filter(Boolean))]
    const [assigneesRes, capturesRes] = await Promise.all([
      assigneeIds.length ? supabase.from('profiles').select('auth_id, display_name').in('auth_id', assigneeIds) : Promise.resolve({ data: [] }),
      captureIds.length  ? supabase.from('tree_records').select('id, photo_url').in('id', captureIds)            : Promise.resolve({ data: [] }),
    ])
    const assigneeNames = Object.fromEntries((assigneesRes.data || []).map(p => [p.auth_id, p.display_name]))
    const capturesById  = Object.fromEntries((capturesRes.data || []).map(c => [c.id, c]))

    res.json({
      trees: (data || []).map(t => ({
        id:              t.id,
        treeCode:        t.tree_id || `TREE-${String(t.id).slice(0, 8).toUpperCase()}`,
        stage:           t.stage || 'Under plantation',
        species:         t.species,
        scientificName:  t.scientific_name,
        quantity:        t.quantity || 1,
        eventType:       t.event_type,
        healthStatus:    t.health_status,
        condition:       t.tree_condition,
        latitude:        t.latitude,
        longitude:       t.longitude,
        photoUrl:        t.photo_url,
        notes:           t.notes,
        projectId:       t.project_id,
        projectName:     projectMap[t.project_id] || t.project_id,
        userId:          t.user_id,
        recordedFor:     t.assigned_to || nameMap[t.user_id] || '—',
        teamMemberId:    t.team_member_id || null,
        // Older records (before assignments were stored) sit on the partner's own
        // account with nobody named — those can still be given their real person.
        canSetAssignee:  withAssigned && !t.assigned_to && t.user_id === req.userId,
        surveyor:        t.surveyor,
        submittedAt:     t.submitted_at,
        surveyDate:      t.survey_date,
        taskStatus:      taskMap[t.id]?.status || null,
        taskId:          taskMap[t.id]?.id || null,
        taskType:        taskMap[t.id] ? treeTasks.typeOf(taskMap[t.id]) : null,
        taskAssigneeId:  taskMap[t.id]?.assignee_id || null,
        taskAssignee:    taskMap[t.id] ? (assigneeNames[taskMap[t.id].assignee_id] || null) : null,
        // The field capture that completed the task: its photo + where it was taken.
        capturePhoto:    taskMap[t.id]?.capture_tree_id ? (capturesById[taskMap[t.id].capture_tree_id]?.photo_url || null) : null,
        captureLocation: taskMap[t.id]?.location || null,
        // Auto-created tasks start on the partner as a placeholder until a Field Operator is picked.
        taskNeedsAssignee: !!taskMap[t.id] && taskMap[t.id].status === 'assigned' && taskMap[t.id].assignee_id === taskMap[t.id].created_by,
      })),
    })
  } catch (err) {
    console.error('[partner/trees GET]', err)
    res.status(500).json({ error: 'Failed to load trees' })
  }
})

// ── GET /api/partner/trees/:id — one record, detail view ────────────────────
router.get('/trees/:id', requirePartner, async (req, res) => {
  try {
    const { userIds } = await partnerOwnedUserIds(req.userId)
    const { data: tree, error } = await supabase
      .from('tree_records')
      .select('*')
      .eq('id', req.params.id)
      .maybeSingle()

    if (error) throw error
    if (!tree || !userIds.includes(tree.user_id)) {
      return res.status(404).json({ error: 'Tree record not found' })
    }

    const [{ data: project }, { data: owner }, taskSlots] = await Promise.all([
      supabase.from('projects').select('id, name').eq('id', tree.project_id).maybeSingle(),
      supabase.from('profiles').select('display_name').eq('auth_id', tree.user_id).maybeSingle(),
      treeTasks.tasksForTrees([tree.id]),
    ])
    const slot = taskSlots[tree.id] || {}
    const task = slot.audit || slot.planting || null

    res.json({
      tree: {
        ...tree,
        projectName: project?.name || tree.project_id,
        recordedFor: owner?.display_name || '—',
      },
      task: task || null,
      plantingTask: slot.planting || null,
      auditTask:    slot.audit || null,
    })
  } catch (err) {
    console.error('[partner/trees/:id GET]', err)
    res.status(500).json({ error: 'Failed to load tree record' })
  }
})

// ── PATCH /api/partner/trees/:id — correct a desk-entry mistake ─────────────
// Deliberately narrow: species, counts and descriptive fields can be fixed,
// but WHO it belongs to, WHICH project, and WHERE it is cannot — those define
// the record's identity. Getting one of those wrong means delete and re-add,
// not edit, the same distinction FRD #3 draws for field-captured evidence
// (P6-04): a correction is a new record, never a silent rewrite of identity.
const TREE_EDITABLE_FIELDS = [
  'species', 'scientific_name', 'quantity', 'event_type', 'health_status',
  'tree_condition', 'land_type', 'dbh_cm', 'height_m', 'notes', 'survey_date',
]

router.patch('/trees/:id', requirePartner, async (req, res) => {
  try {
    const { userIds } = await partnerOwnedUserIds(req.userId)
    const { data: existing } = await supabase
      .from('tree_records')
      .select('id, user_id')
      .eq('id', req.params.id)
      .maybeSingle()

    if (!existing || !userIds.includes(existing.user_id)) {
      return res.status(404).json({ error: 'Tree record not found' })
    }

    // A record already folded into the ledger is done — the platform's public
    // record should not be quietly rewritten after the fact.
    const linkedTask = (await treeTasks.tasksForTrees([existing.id]))[existing.id]?.audit || null
    if (linkedTask?.status === 'approved') {
      return res.status(409).json({ error: 'This record has already been verified and is on the ledger — it can no longer be edited.' })
    }
    // Planting is one-way: once a tree has left "Under plantation" it never goes back.
    if (req.body.stage === 'Under plantation' && (await hasStageColumn())) {
      const { data: current } = await supabase.from('tree_records').select('stage').eq('id', existing.id).maybeSingle()
      if (current?.stage && current.stage !== 'Under plantation') {
        return res.status(409).json({ error: 'This tree is already planted — it cannot go back to "Under plantation".' })
      }
    }

    const updates = {}
    for (const field of TREE_EDITABLE_FIELDS) {
      if (req.body[field] === undefined) continue
      const val = req.body[field]
      updates[field] = (val === '' ? null : val)
    }
    if (req.body.team_member_id) {
      if (!(await hasAssignedColumn())) return res.status(400).json({ error: 'Assignments are not set up in the database yet.' })
      const { data: cur } = await supabase.from('tree_records').select('assigned_to, user_id').eq('id', existing.id).maybeSingle()
      if (cur?.assigned_to || cur?.user_id !== req.userId) {
        return res.status(409).json({ error: 'This tree already belongs to someone — the owner cannot be changed here.' })
      }
      const profile = await partnerProfileFor(req.userId)
      const member = profile ? await memberInOrg(profile.id, req.body.team_member_id) : null
      if (!member) return res.status(400).json({ error: 'That person is not on your team' })
      Object.assign(updates, await assignmentFields(member))
    }
    if (req.body.stage !== undefined) {
      if (!TREE_STAGES.includes(req.body.stage)) return res.status(400).json({ error: 'Unknown stage' })
      if (!(await hasStageColumn())) {
        return res.status(400).json({ error: 'Stages are not set up in the database yet — run the setup SQL in Supabase, then restart the backend.' })
      }
      updates.stage = req.body.stage
      // A tree only becomes Planted when a field operator has planted it and the
      // partner confirmed it (planting task) — not by changing the stage here.
      if (TASK_STAGES.includes(req.body.stage) && (await treeTasks.hasTaskTypeColumns())) {
        const { data: cur } = await supabase.from('tree_records').select('stage').eq('id', existing.id).maybeSingle()
        if (!cur?.stage || cur.stage === 'Under plantation') {
          return res.status(409).json({ error: 'Assign a field operator to plant this tree first — it becomes Planted when you confirm their planting in Tasks.' })
        }
      }
    }
    if (updates.species === null) return res.status(400).json({ error: 'Species cannot be empty' })
    if (updates.quantity !== undefined) {
      const q = Number(updates.quantity)
      if (!Number.isFinite(q) || q < 1) return res.status(400).json({ error: 'Quantity must be 1 or more' })
      updates.quantity = Math.floor(q)
    }
    if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'Nothing to update' })

    const { error } = await supabase.from('tree_records').update(updates).eq('id', existing.id)
    if (error) throw error

    let taskCreated = null
    if (updates.stage && TASK_STAGES.includes(updates.stage)) {
      taskCreated = await ensureVerificationTask(existing.id, req.userId)
    }

    res.json({ success: true, taskCreated })
  } catch (err) {
    console.error('[partner/trees/:id PATCH]', err)
    res.status(500).json({ error: 'Failed to update tree record' })
  }
})

// ── DELETE /api/partner/trees/:id — remove a mistaken entry ─────────────────
// Cascades to the auto-created verification task (see autoCreateVerificationTasks)
// only while it's still unapproved — the task exists to verify THIS record, so
// once the record is gone there's nothing left to verify. An approved task means
// the record already reached the ledger, so both stay: undoing them here would
// silently corrupt the public record the ledger promises to be trustworthy.
// ── POST /api/partner/trees/assign-planting — send trees to a field operator ─
// Body: { tree_ids: string[], assignee_id }. Each tree's planting task (created
// if missing) goes to that field operator; the tree stays "Under plantation"
// until the partner confirms the planting in Tasks.
router.post('/trees/assign-planting', requirePartner, async (req, res) => {
  try {
    const treeIds = Array.isArray(req.body?.tree_ids) ? req.body.tree_ids.filter(Boolean) : []
    const assigneeId = req.body?.assignee_id
    if (treeIds.length === 0) return res.status(400).json({ error: 'Choose at least one tree' })
    if (!assigneeId) return res.status(400).json({ error: 'Choose a field operator' })
    if (!(await treeTasks.hasTaskTypeColumns())) {
      return res.status(400).json({ error: 'Planting tasks are not set up in the database yet — run the setup SQL in Supabase.' })
    }

    const { data: person } = await supabase.from('profiles').select('auth_id, display_name').eq('auth_id', assigneeId).maybeSingle()
    if (!person) return res.status(400).json({ error: 'That field operator does not exist' })

    const { userIds } = await partnerOwnedUserIds(req.userId)
    const { data: trees } = await supabase.from('tree_records').select('id, user_id, tree_id, stage').in('id', treeIds)
    const mine = (trees || []).filter(t => userIds.includes(t.user_id))
    if (mine.length === 0) return res.status(404).json({ error: 'Tree record not found' })
    const planted = mine.filter(t => t.stage && t.stage !== 'Under plantation')
    if (planted.length > 0) {
      return res.status(409).json({ error: `${planted.map(t => t.tree_id || t.id.slice(0, 8)).join(', ')} ${planted.length === 1 ? 'is' : 'are'} already planted.` })
    }

    const assigned = []
    for (const t of mine) {
      const task = await treeTasks.assignPlantingTask(t.id, assigneeId, req.userId)
      if (task) assigned.push(task)
    }

    if (assigned.length > 0) {
      await createNotification({
        userId: assigneeId,
        type:   'task_assigned',
        title:  assigned.length === 1 ? `Planting task assigned: ${assigned[0].name}` : `${assigned.length} planting tasks assigned to you`,
        body:   'Plant the tree, then capture it in the app to complete the task.',
        link:   '/app/tasks',
      }).catch(() => {})
    }

    res.json({ assigned: assigned.length, assignee: person.display_name, tasks: assigned })
  } catch (err) {
    console.error('[partner/trees/assign-planting]', err)
    res.status(500).json({ error: err.message || 'Failed to assign planting' })
  }
})

router.delete('/trees/:id', requirePartner, async (req, res) => {
  try {
    const { userIds } = await partnerOwnedUserIds(req.userId)
    const { data: existing } = await supabase
      .from('tree_records')
      .select('id, user_id')
      .eq('id', req.params.id)
      .maybeSingle()

    if (!existing || !userIds.includes(existing.user_id)) {
      return res.status(404).json({ error: 'Tree record not found' })
    }

    const slot = (await treeTasks.tasksForTrees([existing.id]))[existing.id] || { all: [] }
    if (slot.audit?.status === 'approved') {
      return res.status(409).json({ error: 'This record has already been verified and is on the ledger — it can no longer be deleted.' })
    }

    const linkedTask = slot.all.length > 0
    if (linkedTask) {
      await supabase.from('tasks').delete().in('id', slot.all.map(t => t.id))
    }

    const { error } = await supabase.from('tree_records').delete().eq('id', existing.id)
    if (error) throw error

    res.json({ success: true, taskRemoved: !!linkedTask })
  } catch (err) {
    console.error('[partner/trees/:id DELETE]', err)
    res.status(500).json({ error: 'Failed to delete tree record' })
  }
})

router.post('/trees', requirePartner, treePhotoUpload.single('photo'), async (req, res) => {
  try {
    const partnerUserId = req.userId
    const b = req.body || {}

    const onBehalfOf = b.user_id
    const projectId  = b.project_id
    const species    = (b.species || '').trim()
    // Optional — the partner console files work from a desk and often has no
    // GPS for the tree; TreeApp's own field capture (always on-site) is the
    // geotagged path. Only validate range when a coordinate was actually sent.
    const coord = (v) => {
      const n = Number(v)
      return Number.isFinite(n) ? n : null
    }
    const latitude  = b.latitude  !== undefined && b.latitude  !== '' ? coord(b.latitude)  : null
    const longitude = b.longitude !== undefined && b.longitude !== '' ? coord(b.longitude) : null

    if (!onBehalfOf) return res.status(400).json({ error: 'Choose which user this tree belongs to' })
    if (!projectId)  return res.status(400).json({ error: 'Choose a project' })
    if (!species)    return res.status(400).json({ error: 'Species is required' })
    if ((b.latitude !== undefined && b.latitude !== '' && latitude === null) ||
        (b.longitude !== undefined && b.longitude !== '' && longitude === null)) {
      return res.status(400).json({ error: 'Coordinates must be numbers' })
    }
    if (latitude !== null && (latitude < -90 || latitude > 90)) {
      return res.status(400).json({ error: 'Latitude must be between -90 and 90' })
    }
    if (longitude !== null && (longitude < -180 || longitude > 180)) {
      return res.status(400).json({ error: 'Longitude must be between -180 and 180' })
    }

    const { data: profile } = await supabase
      .from('partner_profiles')
      .select('id, org_name')
      .eq('user_id', partnerUserId)
      .maybeSingle()

    if (!profile) return res.status(404).json({ error: 'Partner profile not found' })

    // The user must be on this partner's team — a partner cannot file work
    // against an account that has nothing to do with them.
    const { data: members } = await supabase
      .from('partner_team_members')
      .select('*')
      .eq('partner_id', profile.id)
      .neq('status', 'inactive')

    // Support "member:<teamMemberId>" sentinel for members without auth accounts.
    let resolvedUserId = onBehalfOf
    let member
    if (String(onBehalfOf).startsWith('member:')) {
      const memberId = String(onBehalfOf).replace('member:', '')
      member = (members || []).find(m => String(m.id) === memberId)
      if (!member) return res.status(403).json({ error: 'That user is not on your team' })
      // Record is owned by the partner themselves when the member has no auth account.
      resolvedUserId = partnerUserId
    } else {
      member = (members || []).find(m => m.user_id === onBehalfOf)
      if (!member) {
        const listed = await listAllAuthUsers()
        const authUser = (listed?.users || []).find(u => u.id === onBehalfOf)
        const email = String(authUser?.email || '').toLowerCase()
        member = (members || []).find(m => String(m.email || '').toLowerCase() === email)
      }
      if (!member) return res.status(403).json({ error: 'That user is not on your team' })
    }

    // The project must be one of this partner's approved projects.
    const { projectIds } = await partnerScope(partnerUserId)
    if (!projectIds.includes(projectId)) {
      return res.status(403).json({ error: 'That project is not one of your approved projects' })
    }

    // Optional photo.
    let photoUrl = null
    if (req.file) {
      const ext  = (req.file.originalname.split('.').pop() || 'jpg').toLowerCase()
      const path = `${resolvedUserId}/${Date.now()}.${ext}`
      const { error: upErr } = await supabase.storage
        .from('tree-photos')
        .upload(path, req.file.buffer, { contentType: req.file.mimetype, upsert: false })

      if (upErr) return res.status(500).json({ error: `Photo upload failed: ${upErr.message}` })

      const { data: pub } = supabase.storage.from('tree-photos').getPublicUrl(path)
      photoUrl = pub?.publicUrl || null
    }

    const { data: partnerProfileRow } = await supabase
      .from('profiles')
      .select('display_name')
      .eq('auth_id', partnerUserId)
      .maybeSingle()

    const num = (v) => {
      const n = Number(v)
      return Number.isFinite(n) && n > 0 ? n : null
    }

    const record = {
      user_id:      resolvedUserId,
      project_id:   projectId,
      latitude,
      longitude,
      species,
      tree_id:      newTreeCode(),
      photo_url:    photoUrl,
      health_status: b.health_status || 'healthy',
      event_type:   b.event_type || 'Planting',
      quantity:     1,
      notes:        b.notes ? String(b.notes).trim() : null,
      scientific_name: b.scientific_name ? String(b.scientific_name).trim() : null,
      dbh_cm:       num(b.dbh_cm),
      height_m:     num(b.height_m),
      land_type:    b.land_type || null,
      tree_condition: b.tree_condition || null,
      // Who entered it, as distinct from who it belongs to.
      surveyor:     partnerProfileRow?.display_name || profile.org_name || 'Partner',
      survey_date:  b.survey_date || new Date().toISOString().slice(0, 10),
      submitted_at: new Date().toISOString(),
      synced:       true,
    }

    // Several tree_records columns are NOT NULL with a default (photo_url among
    // them), so an explicit null is rejected where omitting the key is fine.
    // Send only what we actually have and let the defaults do their job.
    const payload = Object.fromEntries(
      Object.entries(record).filter(([, v]) => v !== null && v !== undefined && v !== '')
    )
    if (await hasStageColumn()) {
      payload.stage = TREE_STAGES.includes(b.stage) ? b.stage : 'Under plantation'
    }
    Object.assign(payload, await assignmentFields(member))

    // "Quantity 5" means five trees: five records, five Tree IDs.
    const count = Math.max(1, Math.floor(Number(b.quantity) || 1))
    if (count > MAX_TREES_PER_ENTRY) {
      return res.status(400).json({ error: `Add at most ${MAX_TREES_PER_ENTRY} trees at a time — use the spreadsheet import for more.` })
    }
    const rows = Array.from({ length: count }, () => ({ ...payload, tree_id: newTreeCode() }))

    const { data: inserted, error } = await supabase
      .from('tree_records')
      .insert(rows)
      .select('id, tree_id, species, quantity, project_id, user_id')

    if (error) throw error
    const data = inserted[0]

    // Bridges Tree Data -> Automatic Task Creation -> Field Operator in the
    // Super Admin / Partner / Business-Individual-User flow.
    // With stages, the verification task appears once the tree is planted —
    // not while it is still under plantation. Without the stage column, keep
    // the original rule (Business/Individual owners get a task straight away).
    const treesForTasks = inserted.map(t => ({ id: t.id, code: t.tree_id, species: t.species, latitude, longitude }))
    // Under plantation → a planting task each; already planted → an audit task each.
    // Without the stage column, keep the original rule.
    const tasksCreated = payload.stage !== undefined
      ? await treeTasks.createTreeTasks({
          trees: treesForTasks, projectId, partnerUserId,
          type: TASK_STAGES.includes(payload.stage) ? treeTasks.AUDIT : treeTasks.PLANTING,
        })
      : await autoCreateVerificationTasks({ trees: treesForTasks, projectId, partnerUserId, ownerRole: member.role })

    const who = member.name || member.email
    const codes = inserted.map(t => t.tree_id)
    res.status(201).json({
      tree: data,
      trees: inserted,
      treeCodes: codes,
      count: inserted.length,
      recordedFor: who,
      message: inserted.length === 1
        ? `Tree ${codes[0]} recorded for ${who}.`
        : `${inserted.length} trees recorded for ${who} (${codes[0]} … ${codes[codes.length - 1]}).`,
      tasksCreated: tasksCreated.length,
      task: tasksCreated[0] || null,
    })
  } catch (err) {
    console.error('[partner/trees POST]', err)
    res.status(500).json({ error: err.message || 'Failed to record tree' })
  }
})

// ── GET /api/partner/trees/import/template ───────────────────────────────────
// A starter file, so the partner never has to guess the column names.
router.get('/trees/import/template', requirePartner, (req, res) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', 'attachment; filename="tree-import-template.csv"')
  res.send(templateCsv())
})

// ── POST /api/partner/trees/import ───────────────────────────────────────────
// Bulk-record trees from a spreadsheet, for one user and one project.
//
// Send dryRun=true first: the file is parsed and validated and nothing is
// written, so the partner can see exactly what will land. The import itself
// refuses to write anything unless every row is valid — a half-imported file
// leaves no way to tell what made it in.
router.post('/trees/import', requirePartner, sheetUpload.single('file'), async (req, res) => {
  try {
    const partnerUserId = req.userId
    const b = req.body || {}
    const onBehalfOf = b.user_id
    const projectId  = b.project_id
    const dryRun     = String(b.dryRun) === 'true'

    if (!req.file)   return res.status(400).json({ error: 'Choose a .xlsx or .csv file' })
    if (!onBehalfOf) return res.status(400).json({ error: 'Choose which user these trees belong to' })
    if (!projectId)  return res.status(400).json({ error: 'Choose a project' })

    const name = req.file.originalname || ''
    if (!/\.(xlsx|csv)$/i.test(name)) {
      return res.status(400).json({ error: 'Only .xlsx and .csv files are supported' })
    }

    // ── same ownership rules as recording one tree ─────────────────────────
    const profile = await partnerProfileFor(partnerUserId)
    if (!profile) return res.status(404).json({ error: 'Partner profile not found' })

    const { data: members } = await supabase
      .from('partner_team_members')
      .select('*')
      .eq('partner_id', profile.id)
      .neq('status', 'inactive')

    // Support "member:<teamMemberId>" sentinel for members without auth accounts.
    let resolvedImportUserId = onBehalfOf
    let member
    if (String(onBehalfOf).startsWith('member:')) {
      const memberId = String(onBehalfOf).replace('member:', '')
      member = (members || []).find(m => String(m.id) === memberId)
      if (!member) return res.status(403).json({ error: 'That user is not on your team' })
      resolvedImportUserId = partnerUserId
    } else {
      member = (members || []).find(m => m.user_id === onBehalfOf)
      if (!member) {
        const listed = await listAllAuthUsers()
        const authUser = (listed?.users || []).find(u => u.id === onBehalfOf)
        const email = String(authUser?.email || '').toLowerCase()
        member = (members || []).find(m => String(m.email || '').toLowerCase() === email)
      }
      if (!member) return res.status(403).json({ error: 'That user is not on your team' })
    }

    const { projectIds } = await partnerScope(partnerUserId)
    if (!projectIds.includes(projectId)) {
      return res.status(403).json({ error: 'That project is not one of your approved projects' })
    }

    // ── parse ──────────────────────────────────────────────────────────────
    let parsed
    try {
      parsed = await parseTreeSheet(req.file.buffer, name)
    } catch (e) {
      // A bad header row or an unreadable file is the partner's to fix, not a
      // server fault — say what's wrong rather than returning a 500.
      return res.status(400).json({ error: e.message })
    }

    const summary = {
      fileName:   name,
      totalRows:  parsed.totalRows,
      validRows:  parsed.rows.length,
      errorRows:  parsed.errors.length,
      columns:    parsed.columns,
      totalTrees: parsed.rows.reduce((sum, r) => sum + r.quantity, 0),
      recordedFor: member.name || member.email,
      // Enough to eyeball before committing.
      preview:    parsed.rows.slice(0, 5),
      errors:     parsed.errors.slice(0, 50),
    }

    if (parsed.totalRows === 0) {
      return res.status(400).json({ error: 'That file has a header row but no data rows.', summary })
    }

    // Every tree becomes its own record — keep one import to a sane size.
    const MAX_TREES_PER_IMPORT = 5000
    if (summary.totalTrees > MAX_TREES_PER_IMPORT) {
      return res.status(400).json({ error: `This file adds ${summary.totalTrees.toLocaleString('en-IN')} trees — import at most ${MAX_TREES_PER_IMPORT.toLocaleString('en-IN')} at a time.`, summary })
    }

    if (dryRun) {
      return res.json({ dryRun: true, ok: parsed.errors.length === 0, summary })
    }

    if (parsed.errors.length > 0) {
      return res.status(400).json({
        error: `${parsed.errors.length} row(s) need fixing — nothing was imported.`,
        summary,
      })
    }

    // ── write ──────────────────────────────────────────────────────────────
    const { data: partnerProfileRow } = await supabase
      .from('profiles')
      .select('display_name')
      .eq('auth_id', partnerUserId)
      .maybeSingle()

    const surveyor = partnerProfileRow?.display_name || profile.org_name || 'Partner'
    const now      = new Date().toISOString()
    const today    = now.slice(0, 10)

    const assignment = await assignmentFields(member)
    // A row with quantity 5 becomes five records, each with its own Tree ID.
    const expanded = parsed.rows.flatMap(r => Array.from({ length: Math.max(1, Math.floor(Number(r.quantity) || 1)) }, () => r))
    const payload = expanded.map(r => {
      const record = {
        user_id:        resolvedImportUserId,
        project_id:     projectId,
        latitude:       r.latitude,
        longitude:      r.longitude,
        species:        r.species,
        scientific_name: r.scientific_name,
        health_status:  r.health_status,
        tree_condition: r.tree_condition,
        event_type:     r.event_type,
        quantity:       1,
        land_type:      r.land_type,
        dbh_cm:         r.dbh_cm,
        height_m:       r.height_m,
        notes:          r.notes,
        surveyor,
        survey_date:    today,
        submitted_at:   now,
        synced:         true,
        tree_id:        newTreeCode(),
        ...assignment,
      }
      // Several columns are NOT NULL with a default, so an explicit null is
      // rejected where omitting the key is fine.
      return Object.fromEntries(
        Object.entries(record).filter(([, v]) => v !== null && v !== undefined && v !== '')
      )
    })

    const { data, error } = await supabase
      .from('tree_records')
      .insert(payload)
      .select('id, tree_id')

    if (error) throw error

    // One task per imported tree, same rule and shape as the single-entry path.
    // Postgres preserves row order for a multi-row INSERT ... RETURNING, and
    // parsed.rows/payload/data are all built from the same ordered array, so
    // pairing by index is safe here.
    // Imported rows start as "Under plantation" once stages exist, so their
    // tasks appear when each tree is marked Planted.
    const tasksCreated = (await hasStageColumn())
      ? await treeTasks.createTreeTasks({
          trees: data.map((row, i) => ({ id: row.id, code: row.tree_id, species: expanded[i].species, latitude: expanded[i].latitude, longitude: expanded[i].longitude })),
          projectId, partnerUserId, type: treeTasks.PLANTING,
        })
      : await autoCreateVerificationTasks({
      trees: data.map((row, i) => ({
        id:        row.id,
        species:   expanded[i].species,
        latitude:  expanded[i].latitude,
        longitude: expanded[i].longitude,
      })),
      projectId,
      partnerUserId,
      ownerRole: member.role,
    })

    res.status(201).json({
      imported:   data.length,
      totalTrees: summary.totalTrees,
      recordedFor: summary.recordedFor,
      message: `${data.length} tree${data.length === 1 ? '' : 's'} imported for ${summary.recordedFor}, each with its own Tree ID.`,
      tasksCreated: tasksCreated.length,
    })
  } catch (err) {
    console.error('[partner/trees/import]', err)
    if (err && err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'That file is larger than 10 MB.' })
    }
    res.status(500).json({ error: err.message || 'Import failed' })
  }
})

// ── GET /api/partner/funders/import/template ─────────────────────────────────
router.get('/funders/import/template', requirePartner, (req, res) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', 'attachment; filename="donor-import-template.csv"')
  res.send(donorTemplateCsv())
})

// ── POST /api/partner/funders/import ──────────────────────────────────────────
// Bulk-record past donations from a spreadsheet, into one project.
//
// This is the funding side, not field capture: it writes individual_fundings
// (+ a ledger entry + project counters), never tree_records. A row with an
// email gets its own real account (reused if one already exists); a row with
// no email is attributed by name only, behind one shared placeholder account
// per partner — individual_fundings.user_id is required and FK'd, but the
// name that actually shows in Funders view is funder_name, not that account.
//
// Send dryRun=true first: the file is parsed and validated and nothing is
// written — no accounts, no rows — so the partner can check it before
// committing. Like the tree import, nothing is written unless every row in
// the file is valid.
router.post('/funders/import', requirePartner, sheetUpload.single('file'), async (req, res) => {
  try {
    const partnerUserId = req.userId
    const b = req.body || {}
    const projectId = b.project_id
    const dryRun     = String(b.dryRun) === 'true'

    if (!req.file)  return res.status(400).json({ error: 'Choose a .xlsx or .csv file' })
    if (!projectId) return res.status(400).json({ error: 'Choose a project' })

    const name = req.file.originalname || ''
    if (!/\.(xlsx|csv)$/i.test(name)) {
      return res.status(400).json({ error: 'Only .xlsx and .csv files are supported' })
    }

    const { projectIds } = await partnerScope(partnerUserId)
    if (!projectIds.includes(projectId)) {
      return res.status(403).json({ error: 'That project is not one of your approved projects' })
    }

    const { data: project } = await supabase
      .from('projects')
      .select('id, name, status, price_per_tree, funded_trees, funders_count, tco2e, total_trees')
      .eq('id', projectId)
      .maybeSingle()
    if (!project) return res.status(404).json({ error: 'Project not found' })

    let parsed
    try {
      parsed = await parseDonorSheet(req.file.buffer, name, project)
    } catch (e) {
      return res.status(400).json({ error: e.message })
    }

    // Read-only account lookup — safe to do even on a dry run, so the preview
    // can say whether a row reuses an existing account or would create one.
    const listed = await listAllAuthUsers()
    const emailToAuthId = new Map(
      (listed?.users || []).map(u => [String(u.email || '').toLowerCase(), u.id])
    )

    const summary = {
      fileName:    name,
      totalRows:   parsed.totalRows,
      validRows:   parsed.rows.length,
      errorRows:   parsed.errors.length,
      totalTrees:  parsed.rows.reduce((sum, r) => sum + r.trees, 0),
      totalAmount: parsed.rows.reduce((sum, r) => sum + r.amount, 0),
      preview: parsed.rows.slice(0, 5).map(r => ({
        line: r.line,
        donor_name: r.donor_name,
        trees: r.trees,
        amount: r.amount,
        anonymous: r.anonymous,
        accountStatus: !r.email
          ? 'offline donor (no login)'
          : emailToAuthId.has(r.email.toLowerCase())
            ? 'existing account'
            : 'new account will be created',
      })),
      errors: parsed.errors.slice(0, 50),
    }

    if (parsed.totalRows === 0) {
      return res.status(400).json({ error: 'That file has a header row but no data rows.', summary })
    }
    if (dryRun) {
      return res.json({ dryRun: true, ok: parsed.errors.length === 0, summary })
    }
    if (parsed.errors.length > 0) {
      return res.status(400).json({
        error: `${parsed.errors.length} row(s) need fixing — nothing was imported.`,
        summary,
      })
    }

    // ── write ──────────────────────────────────────────────────────────────
    const profile = await partnerProfileFor(partnerUserId)
    if (!profile) return res.status(404).json({ error: 'Partner profile not found' })

    let offlineDonorAuthId = null   // created at most once, shared by every no-email row here
    const results = []

    for (const row of parsed.rows) {
      let userId
      if (row.email) {
        const account = await findOrCreateDonorAccount({
          email: row.email,
          displayName: row.donor_name,
          accountType: row.account_type,
          emailCache: emailToAuthId,
        })
        userId = account.authId
      } else {
        if (!offlineDonorAuthId) {
          offlineDonorAuthId = await getOrCreateOfflineDonorAccount(profile)
        }
        userId = offlineDonorAuthId
      }

      const funding = await recordFunding({
        project,
        trees: row.trees,
        funderName: row.donor_name,
        publicAttribution: !row.anonymous,
        userId,
        fundedAt: row.date,
        verificationStatus: 'verified',   // a physical receipt is already in hand
        amountPaid: row.amount,           // never the online-checkout fee markup
      })
      results.push({ line: row.line, donor_name: row.donor_name, orderId: funding.orderId })

      // Keep the in-memory project figures in step, so later rows in the same
      // file compute against up-to-date totals if anything downstream needs them.
      project.funded_trees  = (project.funded_trees || 0) + row.trees
      project.funders_count = (project.funders_count || 0) + 1
    }

    res.status(201).json({
      imported:    results.length,
      totalTrees:  summary.totalTrees,
      totalAmount: summary.totalAmount,
      message:     `${results.length} donation(s) recorded for ${project.name}.`,
    })
  } catch (err) {
    console.error('[partner/funders/import]', err)
    if (err && err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'That file is larger than 10 MB.' })
    }
    res.status(500).json({ error: err.message || 'Import failed' })
  }
})

// ── GET /api/partner/linked-submissions ──────────────────────────────────────
// Partner sees all submissions where they are the linked partner (partner_user_id = me)
router.get('/linked-submissions', requirePartner, async (req, res) => {
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
        evidence_files(id, file_name, file_type, file_size, storage_path)
      `)
      .eq('partner_user_id', userId)
      .order('submitted_at', { ascending: false })
      .limit(50)

    if (error) throw error

    // evidence_files has no file_url column — sign each stored path on read.
    const submissions = await Promise.all((data || []).map(async sub => ({
      ...sub,
      evidence_files: await withSignedUrls(sub.evidence_files || []),
    })))

    res.json({ submissions })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── PATCH /api/partner/linked-submissions/:id/review ─────────────────────────
// Partner approves or rejects a submission linked to them
// Body: { action: 'approve'|'reject', reviewNotes?: string }
router.patch('/linked-submissions/:id/review', requirePartner, async (req, res) => {
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