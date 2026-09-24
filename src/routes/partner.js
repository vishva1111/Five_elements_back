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

const { createNotification } = require('./notifications')
const { sendAccountCreatedEmail } = require('../services/emailService')
const { withSignedUrls } = require('../services/evidenceUrls')
const { parseTreeSheet, templateCsv, MAX_ROWS } = require('../services/treeImport')
const { parseDonorSheet, templateCsv: donorTemplateCsv } = require('../services/donorImport')
const { recordFunding } = require('../services/funding')
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
        ? supabase.from('ledger_entries').select('project_id, trees_verified').in('project_id', projectIds)
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

    const result = (projects || []).map(p => ({
      id:              p.id,
      name:            p.name,
      element:         p.element,
      category:        p.category,
      location:        p.location,
      description:     p.description,
      totalTrees:      p.total_trees,
      fundedTrees:     p.funded_trees,
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

    const { data: projects } = await supabase
      .from('projects')
      .select('id, name')
      .in('id', projectIds)

    const projectMap = Object.fromEntries((projects || []).map(p => [p.id, p.name]))

    const { data: fundings, error } = await supabase
      .from('individual_fundings')
      .select('id, user_id, project_id, trees_funded, amount_paid, funded_at, public_attribution, funder_name')
      .in('project_id', projectIds)
      .order('funded_at', { ascending: false })

    if (error) throw error

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

    // Funded vs delivered vs outstanding — delivered counts approved evidence
    // only, the same rule every other surface uses (P8-02, PG-05).
    const { data: delivered } = await supabase
      .from('ledger_entries')
      .select('trees_verified')
      .in('project_id', projectIds)

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

    if (treeDelta !== 0) {
      const { data: project } = await supabase.from('projects').select('funded_trees').eq('id', existing.project_id).maybeSingle()
      await supabase.from('projects')
        .update({ funded_trees: Math.max(0, (project?.funded_trees || 0) + treeDelta), updated_at: new Date().toISOString() })
        .eq('id', existing.project_id)
    }

    res.json({ success: true })
  } catch (err) {
    console.error('[partner/funders/:id PATCH]', err)
    res.status(500).json({ error: 'Failed to update donation' })
  }
})

// ── DELETE /api/partner/funders/:id — remove a wrongly-entered donation ─────
// Reverses projects.funded_trees / funders_count. Deliberately does NOT touch
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

    const { data: project } = await supabase.from('projects').select('funded_trees, funders_count').eq('id', existing.project_id).maybeSingle()
    if (project) {
      await supabase.from('projects').update({
        funded_trees:  Math.max(0, (project.funded_trees || 0) - (existing.trees_funded || 0)),
        funders_count: Math.max(0, (project.funders_count || 0) - 1),
        updated_at:    new Date().toISOString(),
      }).eq('id', existing.project_id)
    }

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
    // "record a tree for this person" without a call per row.
    const needsLookup = (data || []).some(m => !m.user_id && m.email)
    let byEmail = {}
    if (needsLookup) {
      const listed = await listAllAuthUsers()
      byEmail = Object.fromEntries(
        (listed?.users || []).map(u => [String(u.email || '').toLowerCase(), u.id])
      )
    }

    const projectIdsOnMembers = [...new Set((data || []).map(m => m.project_id).filter(Boolean))]
    let projectNameMap = {}
    if (projectIdsOnMembers.length > 0) {
      const { data: projs } = await supabase.from('projects').select('id, name').in('id', projectIdsOnMembers)
      projectNameMap = Object.fromEntries((projs || []).map(p => [p.id, p.name]))
    }

    const members = (data || []).map(m => {
      const authId = m.user_id || byEmail[String(m.email || '').toLowerCase()] || null
      return {
        id:        m.id,
        name:      m.name,
        email:     m.email,
        role:      m.role,
        roleLabel: TEAM_ROLE_TO_PLATFORM_ROLE[m.role]?.label || m.role,
        status:    m.status,
        joinedAt:  m.joined_at ? new Date(m.joined_at).toLocaleDateString('en-IN') : '—',
        authId,
        canRecord: !!authId,
        projectId:   m.project_id || null,
        projectName: m.project_id ? (projectNameMap[m.project_id] || m.project_id) : null,
      }
    })

    res.json({ members })
  } catch (err) {
    console.error('[partner/team]', err)
    res.status(500).json({ error: 'Failed to load team' })
  }
})

// ── POST /api/partner/team/invite ─────────────────────────────────────────────
router.post('/team/invite', requirePartner, async (req, res) => {
  try {
    const userId = req.userId
    const { email: rawEmail, role, name, project_id: projectId, password: chosenPassword } = req.body

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
    const isPlatformUser = ['business', 'individual'].includes(role)
    let project = null
    if (isPlatformUser) {
      if (!projectId) return res.status(400).json({ error: 'Choose a project for this user' })
      const { projectIds } = await partnerScope(userId)
      if (!projectIds.includes(projectId)) {
        return res.status(403).json({ error: 'That project is not one of your approved projects' })
      }
      const { data: proj } = await supabase.from('projects').select('id, name').eq('id', projectId).maybeSingle()
      project = proj
    }

    const email = String(rawEmail).toLowerCase().trim()

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
        type:           'Individual',   // profiles_type_check allows Individual | Business
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

    // ── 3. The team row. ────────────────────────────────────────────────────
    const memberRow = {
      partner_id: profile.id,
      name:       displayName,
      email,
      role,
      status:     tempPassword ? 'invited' : 'active',
      joined_at:  new Date().toISOString(),
      ...(isPlatformUser ? { project_id: projectId } : {}),
    }

    // user_id arrives with migration 003, project_id with migration 004. Try
    // the fully-linked insert first and fall back column-by-column if either
    // is missing, so Team invites keep working on an older DB — but a User
    // needs project_id to mean anything, so its absence has to be a clear
    // error, not a silent drop of a field the whole feature depends on.
    let { data, error } = await supabase
      .from('partner_team_members')
      .insert({ ...memberRow, user_id: authUser.id })
      .select('id')
      .single()

    if (error && /user_id/.test(String(error.message || ''))) {
      ({ data, error } = await supabase
        .from('partner_team_members')
        .insert(memberRow)
        .select('id')
        .single())
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

// ── PATCH /api/partner/team/:id — change a member's status or role ───────────
// Backs the Deactivate action in P9, which previously only changed local state.
router.patch('/team/:id', requirePartner, async (req, res) => {
  try {
    const { id } = req.params
    const { status, role, name, project_id: projectId } = req.body

    if (status === undefined && role === undefined && name === undefined) {
      return res.status(400).json({ error: 'Nothing to update' })
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
      .map(u => ({ ...u, canRecord: !!u.authId }))

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

// ── GET /api/partner/trees — list, for the partner's own people/projects ────
router.get('/trees', requirePartner, async (req, res) => {
  try {
    const { userIds } = await partnerOwnedUserIds(req.userId)
    if (userIds.length === 0) return res.json({ trees: [] })

    const { projectIds } = await partnerScope(req.userId)
    if (projectIds.length === 0) return res.json({ trees: [] })

    let query = supabase
      .from('tree_records')
      .select('id, species, scientific_name, quantity, event_type, health_status, tree_condition, latitude, longitude, photo_url, notes, project_id, user_id, surveyor, submitted_at')
      .in('user_id', userIds)
      .in('project_id', projectIds)
      .order('submitted_at', { ascending: false })
      .limit(500)

    if (req.query.project_id) query = query.eq('project_id', req.query.project_id)
    if (req.query.user_id)    query = query.eq('user_id', req.query.user_id)

    const { data, error } = await query
    if (error) throw error

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
      supabase.from('tasks').select('id, tree_id, status').in('tree_id', (data || []).map(t => t.id)),
    ])
    const nameMap    = Object.fromEntries((namesRes.data || []).map(p => [p.auth_id, p.display_name]))
    const projectMap = Object.fromEntries((projectsRes.data || []).map(p => [p.id, p.name]))
    const taskMap     = Object.fromEntries((tasksRes.data || []).map(t => [t.tree_id, t]))

    res.json({
      trees: (data || []).map(t => ({
        id:              t.id,
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
        recordedFor:     nameMap[t.user_id] || '—',
        surveyor:        t.surveyor,
        submittedAt:     t.submitted_at,
        taskStatus:      taskMap[t.id]?.status || null,
        taskId:          taskMap[t.id]?.id || null,
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

    const [{ data: project }, { data: owner }, { data: task }] = await Promise.all([
      supabase.from('projects').select('id, name').eq('id', tree.project_id).maybeSingle(),
      supabase.from('profiles').select('display_name').eq('auth_id', tree.user_id).maybeSingle(),
      supabase.from('tasks').select('id, task_code, status, assignee_id').eq('tree_id', tree.id).maybeSingle(),
    ])

    res.json({
      tree: {
        ...tree,
        projectName: project?.name || tree.project_id,
        recordedFor: owner?.display_name || '—',
      },
      task: task || null,
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
  'tree_condition', 'land_type', 'dbh_cm', 'height_m', 'notes',
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
    const { data: linkedTask } = await supabase
      .from('tasks')
      .select('status')
      .eq('tree_id', existing.id)
      .maybeSingle()
    if (linkedTask?.status === 'approved') {
      return res.status(409).json({ error: 'This record has already been verified and is on the ledger — it can no longer be edited.' })
    }

    const updates = {}
    for (const field of TREE_EDITABLE_FIELDS) {
      if (req.body[field] === undefined) continue
      const val = req.body[field]
      updates[field] = (val === '' ? null : val)
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

    res.json({ success: true })
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

    const { data: linkedTask } = await supabase
      .from('tasks')
      .select('id, status')
      .eq('tree_id', existing.id)
      .maybeSingle()

    if (linkedTask?.status === 'approved') {
      return res.status(409).json({ error: 'This record has already been verified and is on the ledger — it can no longer be deleted.' })
    }

    if (linkedTask) {
      await supabase.from('tasks').delete().eq('id', linkedTask.id)
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
    const latitude   = Number(b.latitude)
    const longitude  = Number(b.longitude)

    if (!onBehalfOf) return res.status(400).json({ error: 'Choose which user this tree belongs to' })
    if (!projectId)  return res.status(400).json({ error: 'Choose a project' })
    if (!species)    return res.status(400).json({ error: 'Species is required' })
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      return res.status(400).json({ error: 'Valid latitude and longitude are required' })
    }
    if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
      return res.status(400).json({ error: 'Coordinates are out of range' })
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

    let member = (members || []).find(m => m.user_id === onBehalfOf)
    if (!member) {
      const listed = await listAllAuthUsers()
      const authUser = (listed?.users || []).find(u => u.id === onBehalfOf)
      const email = String(authUser?.email || '').toLowerCase()
      member = (members || []).find(m => String(m.email || '').toLowerCase() === email)
    }

    if (!member) {
      return res.status(403).json({ error: 'That user is not on your team' })
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
      const path = `${onBehalfOf}/${Date.now()}.${ext}`
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
      user_id:      onBehalfOf,
      project_id:   projectId,
      latitude,
      longitude,
      species,
      photo_url:    photoUrl,
      health_status: b.health_status || 'healthy',
      event_type:   b.event_type || 'Planting',
      quantity:     num(b.quantity) || 1,
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

    const { data, error } = await supabase
      .from('tree_records')
      .insert(payload)
      .select('id, species, quantity, project_id, user_id')
      .single()

    if (error) throw error

    // Bridges Tree Data -> Automatic Task Creation -> Field Operator in the
    // Super Admin / Partner / Business-Individual-User flow.
    const tasksCreated = await autoCreateVerificationTasks({
      trees: [{ id: data.id, species: data.species, latitude, longitude }],
      projectId,
      partnerUserId,
      ownerRole: member.role,
    })

    res.status(201).json({
      tree: data,
      recordedFor: member.name || member.email,
      message: `Tree recorded for ${member.name || member.email}`,
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

    let member = (members || []).find(m => m.user_id === onBehalfOf)
    if (!member) {
      const listed = await listAllAuthUsers()
      const authUser = (listed?.users || []).find(u => u.id === onBehalfOf)
      const email = String(authUser?.email || '').toLowerCase()
      member = (members || []).find(m => String(m.email || '').toLowerCase() === email)
    }
    if (!member) return res.status(403).json({ error: 'That user is not on your team' })

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

    const payload = parsed.rows.map(r => {
      const record = {
        user_id:        onBehalfOf,
        project_id:     projectId,
        latitude:       r.latitude,
        longitude:      r.longitude,
        species:        r.species,
        scientific_name: r.scientific_name,
        health_status:  r.health_status,
        tree_condition: r.tree_condition,
        event_type:     r.event_type,
        quantity:       r.quantity,
        land_type:      r.land_type,
        dbh_cm:         r.dbh_cm,
        height_m:       r.height_m,
        notes:          r.notes,
        surveyor,
        survey_date:    today,
        submitted_at:   now,
        synced:         true,
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
      .select('id')

    if (error) throw error

    // One task per imported tree, same rule and shape as the single-entry path.
    // Postgres preserves row order for a multi-row INSERT ... RETURNING, and
    // parsed.rows/payload/data are all built from the same ordered array, so
    // pairing by index is safe here.
    const tasksCreated = await autoCreateVerificationTasks({
      trees: data.map((row, i) => ({
        id:        row.id,
        species:   parsed.rows[i].species,
        latitude:  parsed.rows[i].latitude,
        longitude: parsed.rows[i].longitude,
      })),
      projectId,
      partnerUserId,
      ownerRole: member.role,
    })

    res.status(201).json({
      imported:   data.length,
      totalTrees: summary.totalTrees,
      recordedFor: summary.recordedFor,
      message: `${data.length} record(s) imported for ${summary.recordedFor}.`,
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