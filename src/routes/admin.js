const express  = require('express')
const router   = express.Router()
const supabase = require('../supabaseClient')
const crypto   = require('crypto')
const { createNotification } = require('./notifications')
const { sendAccountCreatedEmail } = require('../services/emailService')
const { withSignedUrls } = require('../services/evidenceUrls')
const { listAllAuthUsers } = require('../services/authUsers')
const {
  grantRole,
  ensureFounderIsAdminMember,
  slugify,
  uniqueProjectSlug,
  DEFAULT_TCO2E_PER_TREE,
  publishCaptureToLedger,
  generateTempPassword,
  requireAdmin,
  requireAdminOrPartner,
} = require('../services/adminHelpers')

// ─── A1: Approval queue ───────────────────────────────────────────────────────
// GET /api/admin/queue
router.get('/queue', requireAdmin, async (req, res) => {
  try {
    const items = []

    // Pending evidence submissions
    const { data: evidence } = await supabase
      .from('evidence_files')
      .select('id, submission_id, created_at, project_submissions(project_id, submitted_by, projects(title, element))')
      .eq('status', 'pending_review')
      .order('created_at', { ascending: true })
      .limit(50)

    if (evidence) {
      evidence.forEach(e => {
        const sub = e.project_submissions
        items.push({
          id:          e.id,
          type:        'evidence',
          title:       sub?.projects?.title || 'Evidence submission',
          submittedBy: sub?.submitted_by || '—',
          submittedAt: new Date(e.created_at).toLocaleDateString('en-GB'),
          element:     sub?.projects?.element || '',
          priority:    'normal',
        })
      })
    }

    // Pending project submissions
    const { data: projects } = await supabase
      .from('project_submissions')
      .select('id, submitted_by, created_at, projects(title, element)')
      .eq('status', 'pending_review')
      .order('created_at', { ascending: true })
      .limit(50)

    if (projects) {
      projects.forEach(p => {
        items.push({
          id:          p.id,
          type:        'project',
          title:       p.projects?.title || 'Project submission',
          submittedBy: p.submitted_by || '—',
          submittedAt: new Date(p.created_at).toLocaleDateString('en-GB'),
          element:     p.projects?.element || '',
          priority:    'normal',
        })
      })
    }

    // Pending partner applications
    const { data: partners } = await supabase
      .from('partner_profiles')
      .select('id, org_name, user_id, applied_at, contact_name, contact_email')
      .eq('status', 'pending')
      .order('applied_at', { ascending: true })
      .limit(50)

    if (partners) {
      partners.forEach(p => {
        items.push({
          id:          p.id,
          type:        'partner',
          title:       p.org_name || 'Partner application',
          submittedBy: p.contact_name || p.contact_email || p.user_id || '—',
          submittedAt: p.applied_at ? new Date(p.applied_at).toLocaleDateString('en-GB') : '—',
          element:     '',
          priority:    'normal',
        })
      })
    }

    res.json({ items })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ─── A2: Evidence review detail ───────────────────────────────────────────────
// GET /api/admin/evidence/:id
router.get('/evidence/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params

    // Real columns only: evidence_files has no file_url / notes / created_at,
    // and the project detail lives on project_submissions itself, not on a
    // projects join (projects has `name`/`total_trees`, not `title`/`tree_count`).
    const { data: ev, error } = await supabase
      .from('evidence_files')
      .select(`
        id, file_name, file_type, file_size, storage_path, status, review_notes,
        uploaded_at, submission_id,
        project_submissions(
          id, submitted_by, status, title, element, location, description, tree_count
        )
      `)
      .eq('id', id)
      .single()

    if (error || !ev) return res.status(404).json({ error: 'Not found' })

    const sub = ev.project_submissions
    const [signed] = await withSignedUrls([ev])

    res.json({
      id:            ev.id,
      submissionId:  ev.submission_id,
      projectTitle:  sub?.title || '—',
      element:       sub?.element || '—',
      submittedBy:   sub?.submitted_by || '—',
      submittedAt:   ev.uploaded_at ? new Date(ev.uploaded_at).toLocaleDateString('en-GB') : '—',
      location:      sub?.location || '—',
      treeCount:     sub?.tree_count || 0,
      description:   sub?.description || '',
      evidenceNotes: ev.review_notes || '',
      status:        ev.status || 'pending_review',
      files: [{
        id:   ev.id,
        name: ev.file_name || 'file',
        type: ev.file_type || 'application/octet-stream',
        size: ev.file_size ? `${Math.round(ev.file_size / 1024)} KB` : '—',
        url:  signed?.file_url || null,
      }],
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/admin/evidence/:id/approve
router.post('/evidence/:id/approve', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params
    const { reviewNotes, treesVerified, co2eVerified } = req.body

    // Fetch evidence + submission + project
    const { data: ev } = await supabase
      .from('evidence_files')
      .select('submission_id, project_submissions(project_id, submitted_by)')
      .eq('id', id)
      .single()

    if (!ev) return res.status(404).json({ error: 'Evidence not found' })

    const projectId = ev.project_submissions?.project_id
    const publicHash = crypto.randomBytes(16).toString('hex')

    // Create ledger entry
    const { error: ledgerErr } = await supabase
      .from('ledger_entries')
      .insert({
        project_id:      projectId,
        evidence_id:     id,
        trees_verified:  treesVerified || 0,
        co2e_verified:   co2eVerified  || 0,
        approved_by:     req.adminId,
        approved_at:     new Date().toISOString(),
        public_hash:     publicHash,
        review_notes:    reviewNotes || '',
      })

    if (ledgerErr) throw new Error(ledgerErr.message)

    // Update evidence status
    await supabase.from('evidence_files').update({ status: 'approved' }).eq('id', id)

    // Update submission status
    await supabase
      .from('project_submissions')
      .update({ status: 'approved' })
      .eq('id', ev.submission_id)

    // 6.2: Notify funder — evidence approved, ledger entry created
    const funderId = ev.project_submissions?.submitted_by
    if (funderId) {
      await createNotification({
        userId: funderId,
        type:   'evidence_approved',
        title:  'Your evidence has been approved ✅',
        body:   'Your submission has been verified and added to the public ledger.',
        link:   `/ledger?hash=${publicHash}`,
      })
    }

    res.json({ success: true, publicHash, ledgerUrl: `/ledger?hash=${publicHash}` })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/admin/evidence/:id/reject
router.post('/evidence/:id/reject', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params
    const { reviewNotes } = req.body

    const { data: ev } = await supabase
      .from('evidence_files')
      .select('submission_id, project_submissions(submitted_by)')
      .eq('id', id)
      .single()

    if (!ev) return res.status(404).json({ error: 'Evidence not found' })

    await supabase.from('evidence_files').update({ status: 'rejected', review_notes: reviewNotes }).eq('id', id)
    await supabase.from('project_submissions').update({ status: 'rejected', review_notes: reviewNotes }).eq('id', ev.submission_id)

    // 6.2: Notify partner/submitter — evidence rejected, re-upload needed
    const submitterId = ev.project_submissions?.submitted_by
    if (submitterId) {
      await createNotification({
        userId: submitterId,
        type:   'evidence_rejected',
        title:  'Evidence submission rejected ❌',
        body:   reviewNotes || 'Your evidence submission was not approved. Please review and re-submit.',
        link:   '/partner/evidence',
      })
    }

    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ─── A3: Partner management ───────────────────────────────────────────────────
// GET /api/admin/partners
router.get('/partners', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('partner_profiles')
      .select('id, org_name, org_type, contact_name, contact_email, website, years_active, status, applied_at, description')
      .order('applied_at', { ascending: false })

    if (error) throw error

    res.json({
      partners: (data || []).map(p => ({
        id:           p.id,
        orgName:      p.org_name,
        orgType:      p.org_type,
        contactName:  p.contact_name,
        contactEmail: p.contact_email,
        website:      p.website,
        yearsActive:  p.years_active,
        status:       p.status,
        appliedAt:    p.applied_at ? new Date(p.applied_at).toLocaleDateString('en-GB') : '—',
        description:  p.description,
      }))
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// PATCH /api/admin/partners/:id
router.patch('/partners/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params
    const { status, reviewNotes } = req.body

    // Fetch partner to get user_id for notification
    const { data: partner } = await supabase
      .from('partner_profiles')
      .select('user_id, org_name, contact_name, contact_email')
      .eq('id', id)
      .single()

    const { error } = await supabase
      .from('partner_profiles')
      .update({ status, review_notes: reviewNotes, reviewed_by: req.adminId, reviewed_at: new Date().toISOString() })
      .eq('id', id)

    if (error) throw error

    // Approval is what makes someone a partner. Without this the account keeps
    // role 'individual', so ProtectedRoute and requirePartner both reject it and
    // the "you can now access the partner portal" notification goes nowhere.
    let roleWarning = null
    if (status === 'approved' && partner?.user_id) {
      const granted = await grantRole(partner.user_id, 'partner')
      if (!granted.ok) {
        roleWarning = `Approved, but the partner role could not be granted: ${granted.error}`
        console.error('[admin/partners approve] grantRole failed:', granted.error)
      }

      // The primary contact becomes the first partner_admin (P1-04).
      await ensureFounderIsAdminMember({
        partnerId:  id,
        authUserId: partner.user_id,
        name:       partner.contact_name,
        email:      partner.contact_email,
      })
    }

    // 6.3: Notify partner user of decision
    if (partner?.user_id) {
      if (status === 'approved') {
        await createNotification({
          userId: partner.user_id,
          type:   'partner_approved',
          title:  'Partner application approved ✅',
          body:   `${partner.org_name || 'Your organisation'} has been approved. You can now access the partner portal.`,
          link:   '/partner/dashboard',
        })
      } else if (status === 'rejected') {
        await createNotification({
          userId: partner.user_id,
          type:   'partner_rejected',
          title:  'Partner application not approved ❌',
          body:   reviewNotes || 'Your partner application was not approved at this time.',
          link:   '/partner/onboarding',
        })
      }
    }

    res.json({ success: true, warning: roleWarning })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/admin/partners — Super Admin creates a partner outright.
// The application flow (partner applies -> admin approves) still works; this is
// the top-down path: the admin makes the org and its login in one step.
router.post('/partners', requireAdmin, async (req, res) => {
  try {
    const {
      orgName, orgType, contactName, contactEmail, contactPhone,
      website, address, description,
    } = req.body

    if (!orgName || !contactName || !contactEmail) {
      return res.status(400).json({ error: 'orgName, contactName and contactEmail are required' })
    }

    const email = String(contactEmail).toLowerCase().trim()

    // Reuse the account if this person already exists, rather than failing.
    const listed = await listAllAuthUsers()
    let authUser = (listed?.users || []).find(u => u.email?.toLowerCase() === email)
    let tempPassword = null

    if (!authUser) {
      tempPassword = generateTempPassword()
      const { data: created, error: createErr } = await supabase.auth.admin.createUser({
        email,
        password: tempPassword,
        email_confirm: true,
        user_metadata: { display_name: contactName },
      })
      if (createErr) return res.status(400).json({ error: createErr.message })
      authUser = created.user
    }

    // One partner profile per account.
    const { data: existingProfile } = await supabase
      .from('partner_profiles')
      .select('id')
      .eq('user_id', authUser.id)
      .maybeSingle()

    if (existingProfile) {
      return res.status(409).json({ error: 'This account already has a partner profile' })
    }

    // Platform profile — created if the account is brand new, then given the role.
    const { data: profileRow } = await supabase
      .from('profiles')
      .select('id')
      .eq('auth_id', authUser.id)
      .maybeSingle()

    if (!profileRow) {
      const { error: profErr } = await supabase.from('profiles').insert({
        id:           `partner-${authUser.id.slice(0, 8)}`,
        auth_id:      authUser.id,
        display_name: contactName,
        name:         orgName,
        type:         'Individual',   // profiles_type_check allows Individual | Business

        location:     address || '',
        avatar:       '',
        trees:        0,
        t_co2e:       0,
        role:         'partner',
        roles:        ['partner'],
        status:       'active',
        is_first_login: true,
      })
      if (profErr) return res.status(500).json({ error: `Profile creation failed: ${profErr.message}` })
    } else {
      const granted = await grantRole(authUser.id, 'partner')
      if (!granted.ok) return res.status(500).json({ error: `Role grant failed: ${granted.error}` })
    }

    const nowIso = new Date().toISOString()
    const { data: partner, error: partnerErr } = await supabase
      .from('partner_profiles')
      .insert({
        user_id:       authUser.id,
        org_name:      orgName,
        org_type:      orgType || null,
        website:       website || null,
        contact_name:  contactName,
        contact_email: email,
        contact_phone: contactPhone || null,
        address:       address || null,
        description:   description || null,
        status:        'approved',       // admin-created partners skip review
        applied_at:    nowIso,
        reviewed_by:   req.adminId,
        reviewed_at:   nowIso,
      })
      .select('id')
      .single()

    if (partnerErr) return res.status(500).json({ error: partnerErr.message })

    // The contact becomes the org's first partner_admin (P1-04).
    await ensureFounderIsAdminMember({
      partnerId:  partner.id,
      authUserId: authUser.id,
      name:       contactName,
      email,
    })

    if (tempPassword) {
      await sendAccountCreatedEmail({
        toEmail:      email,
        displayName:  contactName,
        roleLabel:    'Implementation Partner',
        tempPassword,
        orgName,
      }).catch(e => console.error('[admin/partners] invite email failed:', e.message))
    }

    await createNotification({
      userId: authUser.id,
      type:   'partner_approved',
      title:  'Your partner account is ready ✅',
      body:   `${orgName} has been set up by the Five Elements team. You can register projects now.`,
      link:   '/partner/dashboard',
    })

    res.status(201).json({
      id: partner.id,
      userId: authUser.id,
      // Returned once so the admin can pass it on if the email bounces.
      tempPassword,
      reusedExistingAccount: !tempPassword,
    })
  } catch (err) {
    console.error('[admin/partners POST]', err)
    res.status(500).json({ error: err.message })
  }
})

// ─── A4: Submission review (CARM flow) ───────────────────────────────────────

// GET /api/admin/submissions — list all pending_review submissions with evidence files
router.get('/submissions', requireAdmin, async (req, res) => {
  try {
    const { status = 'pending_review' } = req.query

    const { data, error } = await supabase
      .from('project_submissions')
      .select(`
        id, title, element, category, project_type, location,
        start_date, end_date, tree_count, description,
        partner_type, partner_name, partner_contact, partner_role, partner_user_id,
        partner_review_status, partner_review_notes, partner_reviewed_at,
        status, submitted_by, submitted_at, reviewed_by, reviewed_at, review_notes,
        outcome, more_info_request, more_info_response,
        evidence_files(id, file_name, file_type, file_size, storage_path)
      `)
      .eq('status', status)
      .order('submitted_at', { ascending: true })
      .limit(100)

    if (error) throw error

    const submissions = await Promise.all((data || []).map(async sub => ({
      ...sub,
      evidence_files: await withSignedUrls(sub.evidence_files || []),
    })))

    res.json({ submissions })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// GET /api/admin/submissions/:id — get single submission detail
router.get('/submissions/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params

    const { data, error } = await supabase
      .from('project_submissions')
      .select(`
        id, title, element, category, project_type, location,
        start_date, end_date, tree_count, description,
        partner_type, partner_name, partner_contact, partner_role, partner_user_id,
        partner_review_status, partner_review_notes, partner_reviewed_at,
        status, submitted_by, submitted_at, reviewed_by, reviewed_at, review_notes,
        outcome, more_info_request, more_info_response,
        evidence_files(id, file_name, file_type, file_size, storage_path)
      `)
      .eq('id', id)
      .single()

    if (error || !data) return res.status(404).json({ error: 'Submission not found' })

    res.json({
      submission: {
        ...data,
        evidence_files: await withSignedUrls(data.evidence_files || []),
      },
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// PATCH /api/admin/submissions/:id/review — approve, reject, or request more info
// Body: { action: 'approve'|'reject'|'more_info', outcome?: 'verified'|'self_reported', reviewNotes?: string, moreInfoRequest?: string }
router.patch('/submissions/:id/review', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params
    const { action, outcome, reviewNotes, moreInfoRequest } = req.body

    if (!['approve', 'reject', 'more_info'].includes(action)) {
      return res.status(400).json({ error: 'action must be approve, reject, or more_info' })
    }

    // Fetch submission — the project fields are needed to mint the projects row.
    const { data: sub, error: fetchErr } = await supabase
      .from('project_submissions')
      .select('id, submitted_by, title, partner_user_id, project_id, element, category, description, location, tree_count, start_date, end_date')
      .eq('id', id)
      .single()

    if (fetchErr || !sub) return res.status(404).json({ error: 'Submission not found' })

    let updatePayload = {
      reviewed_by:  req.adminId,
      reviewed_at:  new Date().toISOString(),
      review_notes: reviewNotes || null,
    }

    if (action === 'approve') {
      updatePayload.status  = 'approved'
      updatePayload.outcome = outcome || 'self_reported'
    } else if (action === 'reject') {
      updatePayload.status  = 'rejected'
      updatePayload.outcome = 'rejected'
    } else if (action === 'more_info') {
      updatePayload.status             = 'more_info'
      updatePayload.more_info_request  = moreInfoRequest || reviewNotes || ''
    }

    // Approving a submission is what brings the project into existence. Until
    // this ran, nothing in the codebase ever inserted a projects row, so approved
    // projects never reached the marketplace, the partner portal or the field app.
    let createdProjectId = null
    let projectWarning   = null

    if (action === 'approve' && !sub.project_id) {
      try {
        const slug = await uniqueProjectSlug(sub.title)

        // projects.partner is the public "delivered by" label and is NOT NULL.
        // Most submissions come from a partner org; the rest (an individual or
        // business submitting their own project) fall back to the submitter's
        // display name, so approval never fails for want of a label.
        const { data: partnerProfile } = await supabase
          .from('partner_profiles')
          .select('org_name')
          .eq('user_id', sub.submitted_by)
          .maybeSingle()

        let partnerLabel = partnerProfile?.org_name || null
        if (!partnerLabel) {
          const { data: submitter } = await supabase
            .from('profiles')
            .select('display_name, name')
            .eq('auth_id', sub.submitted_by)
            .maybeSingle()
          partnerLabel = submitter?.display_name || submitter?.name || 'Unattributed'
        }

        const { error: projErr } = await supabase.from('projects').insert({
          id:            slug,
          slug,
          name:          sub.title,
          element:       (sub.element || 'earth').toLowerCase(),
          // projects.category and .location are NOT NULL. Category is required in
          // the P3 form, but older drafts and API callers may omit it, and a
          // missing label must never block an otherwise valid approval.
          category:      sub.category || 'Uncategorised',
          location:      sub.location || 'Not specified',
          description:   sub.description || null,
          partner:       partnerLabel,
          total_trees:   sub.tree_count || 0,
          funded_trees:  0,
          funders_count: 0,
          funded_amount: 0,
          tco2e:         0,
          t_co2e:        0,
          evidence_count: 0,
          verified:      updatePayload.outcome === 'verified',
          verification_status: updatePayload.outcome === 'verified' ? 'verified' : 'self_reported',
          has_ledger_entry: false,
          active:        true,
          status:        'active',
        })

        if (projErr) throw new Error(projErr.message)

        createdProjectId    = slug
        updatePayload.project_id = slug
      } catch (e) {
        // Don't fail the review itself — record it and let the admin retry.
        projectWarning = `Submission approved, but the project record could not be created: ${e.message}`
        console.error('[admin/submissions review] project creation failed:', e.message)
      }
    }

    const { error: updateErr } = await supabase
      .from('project_submissions')
      .update(updatePayload)
      .eq('id', id)

    if (updateErr) throw new Error(updateErr.message)

    // Notify submitter
    if (sub.submitted_by) {
      if (action === 'approve') {
        await createNotification({
          userId: sub.submitted_by,
          type:   'submission_approved',
          title:  `Your project has been ${updatePayload.outcome === 'verified' ? 'Verified ✅' : 'approved as Self-reported'}`,
          body:   reviewNotes || `"${sub.title}" has been reviewed and approved.`,
          link:   '/impact',
        })
      } else if (action === 'reject') {
        await createNotification({
          userId: sub.submitted_by,
          type:   'submission_rejected',
          title:  'Project submission not approved ❌',
          body:   reviewNotes || `"${sub.title}" was not approved. Please review the feedback and resubmit.`,
          link:   '/submit-project/details',
        })
      } else if (action === 'more_info') {
        await createNotification({
          userId: sub.submitted_by,
          type:   'submission_more_info',
          title:  'More information needed for your submission',
          body:   moreInfoRequest || `The reviewer has a question about "${sub.title}".`,
          link:   '/submit-project/review',
        })
      }
    }

    res.json({
      success:   true,
      status:    updatePayload.status,
      outcome:   updatePayload.outcome || null,
      projectId: createdProjectId,
      warning:   projectWarning,
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ─── A5: Users & tenants ──────────────────────────────────────────────────────
// GET /api/admin/users
router.get('/users', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('id, auth_id, display_name, role, status, created_at, last_seen_at')
      .order('created_at', { ascending: false })

    if (error) throw error

    // Fetch emails from auth.users via admin API for profiles that have auth_id
    const authIds = (data || []).map(u => u.auth_id).filter(Boolean)
    let emailMap = {}
    if (authIds.length > 0) {
      const { users: authUsers } = await listAllAuthUsers()
      if (authUsers) {
        authUsers.forEach(au => { emailMap[au.id] = au.email })
      }
    }

    res.json({
      users: (data || []).map(u => ({
        id:        u.id,
        email:     (u.auth_id && emailMap[u.auth_id]) || '—',
        role:      u.role  || 'individual',
        name:      u.display_name || '—',
        createdAt: new Date(u.created_at).toLocaleDateString('en-GB'),
        lastSeen:  u.last_seen_at ? new Date(u.last_seen_at).toLocaleDateString('en-GB') : '—',
        status:    u.status || 'active',
      }))
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// PATCH /api/admin/users/:id
router.patch('/users/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params
    const { status } = req.body
    const { error } = await supabase.from('profiles').update({ status }).eq('id', id)
    if (error) throw error
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ─── A5: Projects oversight ───────────────────────────────────────────────────
// GET /api/admin/projects
router.get('/projects', requireAdminOrPartner, async (req, res) => {
  try {
    // NOTE: this previously selected columns (title, tree_count, profiles(display_name))
    // that don't exist on `projects` — it 500'd on every call. Fixed to match the real schema.
    const { data, error } = await supabase
      .from('projects')
      .select('id, name, element, category, location, partner, total_trees, funded_trees, status, active, created_at')
      .order('created_at', { ascending: false })

    if (error) throw error

    res.json({
      projects: (data || []).map(p => ({
        id:          p.id,
        title:       p.name,
        element:     p.element,
        category:    p.category,
        location:    p.location,
        submittedBy: p.partner || '—',
        partnerName: p.partner || '—',
        treeCount:   p.total_trees || 0,
        fundedTrees: p.funded_trees || 0,
        status:      p.status || 'active',
        active:      p.active,
        submittedAt: new Date(p.created_at).toLocaleDateString('en-GB'),
      }))
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// GET /api/admin/tree-records — list tree records, optionally filtered by project
// Used by the task-creation form ("link to tree") and the bulk task-generation flow.
router.get('/tree-records', requireAdminOrPartner, async (req, res) => {
  try {
    const { project_id, limit } = req.query
    let query = supabase
      .from('tree_records')
      .select('id, species, project_id, latitude, longitude, health_status, submitted_at')
      .order('submitted_at', { ascending: false })
      .limit(limit ? parseInt(limit, 10) : 200)

    if (project_id) query = query.eq('project_id', project_id)

    const { data, error } = await query
    if (error) throw error

    res.json({ records: data || [] })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/admin/projects/:id/approve
router.post('/projects/:id/approve', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params

    // Fetch project to get submitter + title for notification
    const { data: project } = await supabase
      .from('projects')
      .select('title, created_by')
      .eq('id', id)
      .single()

    const { error } = await supabase.from('projects').update({ status: 'active' }).eq('id', id)
    if (error) throw error

    // 6.4: Notify project submitter — project is now live on marketplace
    if (project?.created_by) {
      await createNotification({
        userId: project.created_by,
        type:   'project_approved',
        title:  'Your project is now live ✅',
        body:   `"${project.title || 'Your project'}" has been approved and is now visible on the marketplace.`,
        link:   `/projects`,
      })
    }

    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/admin/projects/:id/reject
router.post('/projects/:id/reject', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params
    const { error } = await supabase.from('projects').update({ status: 'rejected' }).eq('id', id)
    if (error) throw error
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ─── A6: Data quality & fraud ─────────────────────────────────────────────────
// GET /api/admin/data-quality
router.get('/data-quality', requireAdmin, async (req, res) => {
  // Placeholder — real implementation would run anomaly detection queries
  res.json({ flags: [] })
})

// PATCH /api/admin/data-quality/:id
router.patch('/data-quality/:id', requireAdmin, async (req, res) => {
  res.json({ success: true })
})

// ─── A7: Ledger administration ────────────────────────────────────────────────
// GET /api/admin/ledger
router.get('/ledger', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('ledger_entries')
      .select('id, project_id, project, funder, trees, t_co2e, trees_verified, co2e_verified, verified, approved_at, public_hash, superseded_by, approved_by, review_notes, projects(name)')
      .order('approved_at', { ascending: false })
      .limit(200)

    if (error) throw error

    res.json({
      entries: (data || []).map(e => ({
        id:           e.id,
        project:      e.projects?.name || e.project || '—',
        projectId:    e.project_id,
        funder:       e.funder || '—',
        trees:        e.trees_verified || e.trees || 0,
        tCo2e:        Number(e.co2e_verified || e.t_co2e) || 0,
        verified:     e.verified || false,
        date:         e.approved_at ? new Date(e.approved_at).toLocaleDateString('en-GB') : (e.date || '—'),
        publicHash:   e.public_hash || '',
        supersededBy: e.superseded_by || null,
        approvedBy:   e.approved_by || null,
        reviewNotes:  e.review_notes || '',
      }))
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/admin/ledger/:id/supersede
router.post('/ledger/:id/supersede', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params
    const { reason } = req.body

    // Fetch original entry
    const { data: orig } = await supabase
      .from('ledger_entries')
      .select('*')
      .eq('id', id)
      .single()

    if (!orig) return res.status(404).json({ error: 'Entry not found' })

    // Create corrected replacement entry
    const newHash = crypto.randomBytes(16).toString('hex')
    const { data: newEntry, error: insertErr } = await supabase
      .from('ledger_entries')
      .insert({
        project_id:     orig.project_id,
        evidence_id:    orig.evidence_id,
        trees_verified: orig.trees_verified,
        co2e_verified:  orig.co2e_verified,
        approved_by:    req.adminId,
        approved_at:    new Date().toISOString(),
        public_hash:    newHash,
        review_notes:   `Supersedes ${id}. Reason: ${reason}`,
      })
      .select('id')
      .single()

    if (insertErr) throw new Error(insertErr.message)

    // Mark original as superseded
    await supabase
      .from('ledger_entries')
      .update({ superseded_by: newEntry.id })
      .eq('id', id)

    res.json({ success: true, newEntryId: newEntry.id })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ─── A8: Finance console ──────────────────────────────────────────────────────
// GET /api/admin/finance
router.get('/finance', requireAdmin, async (req, res) => {
  try {
    const { data: fundings } = await supabase
      .from('individual_fundings')
      .select('id, amount_paid, user_id, project_id, verification_status, funded_at, funder_name, trees_funded, projects(name)')
      .order('funded_at', { ascending: false })
      .limit(200)

    const transactions = (fundings || []).map(f => ({
      id:       f.id,
      type:     'funding',
      amount:   Number(f.amount_paid) || 0,
      currency: 'GBP',
      from:     f.funder_name || f.user_id || '—',
      to:       'Five Elements',
      project:  f.projects?.name || '—',
      status:   f.verification_status === 'verified' ? 'completed' : f.verification_status || 'pending',
      date:     f.funded_at ? new Date(f.funded_at).toLocaleDateString('en-GB') : '—',
    }))

    const totalRevenue = transactions.reduce((s, t) => s + (t.type === 'funding' ? t.amount : 0), 0)

    res.json({
      summary: { totalRevenue, totalPayouts: 0, pendingPayouts: 0, platformFees: totalRevenue * 0.05, currency: 'GBP' },
      transactions,
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ─── A9: Platform health ──────────────────────────────────────────────────────
// GET /api/admin/health
router.get('/health', requireAdmin, async (req, res) => {
  const start = Date.now()

  // Ping Supabase
  let dbStatus = 'ok'
  try {
    await supabase.from('platform_stats').select('id').limit(1)
  } catch {
    dbStatus = 'error'
  }

  const latency = Date.now() - start

  res.json({
    metrics: [
      { name: 'API',      value: 'Online',          status: 'ok',                                    detail: `${latency}ms` },
      { name: 'Database', value: dbStatus === 'ok' ? 'Connected' : 'Error', status: dbStatus,        detail: 'Supabase Postgres' },
      { name: 'Latency',  value: `${latency}ms`,    status: latency < 500 ? 'ok' : latency < 2000 ? 'warn' : 'error' },
    ],
    queues:       [],
    recentErrors: [],
    lastUpdated:  new Date().toLocaleTimeString('en-GB'),
  })
})

// ─── A10: Configuration ───────────────────────────────────────────────────────
// GET /api/admin/config
router.get('/config', requireAdmin, async (req, res) => {
  res.json({
    featureFlags: [
      { key: 'marketplace_public',    label: 'Public marketplace',       description: 'Show marketplace to unauthenticated users', enabled: true },
      { key: 'partner_self_register', label: 'Partner self-registration', description: 'Allow partners to apply without invite',    enabled: true },
      { key: 'bulk_upload',           label: 'Bulk upload',              description: 'Enable CSV bulk upload for businesses',      enabled: true },
      { key: 'qr_verification',       label: 'QR verification',          description: 'Enable QR code on certificates',            enabled: true },
    ],
    emissionFactors: [
      { key: 'electricity_uk',  label: 'UK electricity',    value: 0.21233, unit: 'kgCO₂e/kWh', source: 'DEFRA 2024' },
      { key: 'natural_gas',     label: 'Natural gas',       value: 0.18254, unit: 'kgCO₂e/kWh', source: 'DEFRA 2024' },
      { key: 'diesel',          label: 'Diesel (road)',      value: 2.51868, unit: 'kgCO₂e/litre', source: 'DEFRA 2024' },
      { key: 'petrol',          label: 'Petrol (road)',      value: 2.31380, unit: 'kgCO₂e/litre', source: 'DEFRA 2024' },
      { key: 'flight_domestic', label: 'Domestic flight',   value: 0.24510, unit: 'kgCO₂e/km/pax', source: 'DEFRA 2024' },
    ],
    platformSettings: [
      { key: 'platform_fee_pct',  label: 'Platform fee (%)',       value: '5',    type: 'number' },
      { key: 'min_funding_gbp',   label: 'Minimum funding (£)',    value: '10',   type: 'number' },
      { key: 'default_currency',  label: 'Default currency',       value: 'GBP',  type: 'select', options: ['GBP', 'USD', 'EUR'] },
      { key: 'support_email',     label: 'Support email',          value: 'hello@fiveelements.earth', type: 'text' },
    ],
  })
})

// PATCH /api/admin/config/flags
router.patch('/config/flags', requireAdmin, async (req, res) => {
  // In production: persist to a config table. For now, acknowledge.
  res.json({ success: true })
})

// PATCH /api/admin/config/factors
router.patch('/config/factors', requireAdmin, async (req, res) => {
  res.json({ success: true })
})

// PATCH /api/admin/config/settings
router.patch('/config/settings', requireAdmin, async (req, res) => {
  res.json({ success: true })
})

// ─── Task Management (Admin) ──────────────────────────────────────────────────

// GET /api/admin/tasks — list all tasks with filters
router.get('/tasks', requireAdminOrPartner, async (req, res) => {
  try {
    const { status, project_id, assignee_id } = req.query
    let query = supabase
      .from('tasks')
      .select(`
        id, task_code, name, project_id, assignee_id, target_count,
        location, priority, status, due_date, started_at, completed_at,
        created_at, created_by, reviewed_by, review_notes, reviewed_at,
        tree_id, captured
      `)
      .order('created_at', { ascending: false })
      .limit(200)

    if (status)      query = query.eq('status', status)
    if (project_id)  query = query.eq('project_id', project_id)
    if (assignee_id) query = query.eq('assignee_id', assignee_id)

    const { data, error } = await query
    if (error) throw error

    // Enrich with assignee name + project name
    const profileIds = [...new Set((data || []).map(t => t.assignee_id).filter(Boolean))]
    let profileMap = {}
    if (profileIds.length > 0) {
      const { data: profiles } = await supabase
        .from('profiles')
        .select('auth_id, id, display_name')
        .in('auth_id', profileIds)
      ;(profiles || []).forEach(p => { profileMap[p.auth_id] = p.display_name })
    }

    const projectIds = [...new Set((data || []).map(t => t.project_id).filter(Boolean))]
    let projectMap = {}
    if (projectIds.length > 0) {
      const { data: projects } = await supabase
        .from('projects')
        .select('id, name')
        .in('id', projectIds)
      ;(projects || []).forEach(p => { projectMap[p.id] = p.name })
    }

    // The photo the field user captured lives on the linked tree record, not the task.
    const treeIds = [...new Set((data || []).map(t => t.tree_id).filter(Boolean))]
    let treeMap = {}
    if (treeIds.length > 0) {
      const { data: trees } = await supabase
        .from('tree_records')
        .select('id, photo_url, species, health_status, submitted_at')
        .in('id', treeIds)
      ;(trees || []).forEach(tr => { treeMap[tr.id] = tr })
    }

    res.json({
      tasks: (data || []).map(t => ({
        ...t,
        assignee_name: profileMap[t.assignee_id] || t.assignee_id || '—',
        project_name:  projectMap[t.project_id]  || t.project_id  || '—',
        photo_url:     treeMap[t.tree_id]?.photo_url     || null,
        tree_species:  treeMap[t.tree_id]?.species       || null,
        tree_health:   treeMap[t.tree_id]?.health_status || null,
      }))
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/admin/tasks — create a new task
// Body: { name, project_id, assignee_id, tree_id?, target_count, location, priority, due_date }
router.post('/tasks', requireAdminOrPartner, async (req, res) => {
  try {
    const { name, project_id, assignee_id, tree_id, target_count, location, priority, due_date } = req.body

    if (!name || !assignee_id) {
      return res.status(400).json({ error: 'name and assignee_id are required' })
    }

    // assignee_id must be a real profile's auth_id (uuid) with an Admin/Partner role —
    // this is the whole assignable pool. Prevents the old profiles.id-vs-auth_id mismatch
    // from silently corrupting/failing the insert.
    const { data: assigneeProfile } = await supabase
      .from('profiles')
      .select('auth_id, role, roles')
      .eq('auth_id', assignee_id)
      .maybeSingle()

    // Field users are the point of a survey task — they were previously excluded,
    // so a task had to be created for a partner and then reassigned by hand.
    const assigneeRoles = assigneeProfile ? [assigneeProfile.role, ...(assigneeProfile.roles || [])] : []
    const ASSIGNABLE = ['admin', 'partner', 'field_user', 'individual']
    if (!assigneeProfile || !assigneeRoles.some(r => ASSIGNABLE.includes(r))) {
      return res.status(400).json({ error: 'assignee_id must belong to a known Admin, Partner or Field account' })
    }

    // Generate task_code
    let task_code = null
    if (tree_id) {
      const { data: codeRow } = await supabase
        .rpc('generate_task_code', { p_tree_id: tree_id })
      task_code = codeRow
    } else {
      // Fallback: TRK-XXXX-T{seq} using random short id
      const shortId = Math.random().toString(36).substring(2, 6).toUpperCase()
      const { count } = await supabase.from('tasks').select('id', { count: 'exact', head: true })
      const seq = ((count || 0) + 1).toString().padStart(3, '0')
      task_code = `TRK-${shortId}-T${seq}`
    }

    const { data, error } = await supabase
      .from('tasks')
      .insert({
        name,
        project_id:   project_id   || null,
        assignee_id,
        tree_id:      tree_id      || null,
        task_code,
        target_count: target_count || 10,
        location:     location     || null,
        priority:     priority     || 'medium',
        due_date:     due_date     || null,
        status:       'assigned',
        captured:     0,
        created_by:   req.reviewerId,
      })
      .select()
      .single()

    if (error) throw error

    // Notify assignee
    await createNotification({
      userId: assignee_id,
      type:   'task_assigned',
      title:  `New task assigned: ${name}`,
      body:   `Task ${task_code} has been assigned to you. Priority: ${priority || 'medium'}.`,
      link:   '/app/tasks',
    })

    res.status(201).json({ task: data })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// PUT /api/admin/tasks/:id — update task (reassign, change priority, etc.)
// Unlike POST /tasks, assignee_id here is NOT restricted to Admin/Partner — this is also
// how a ticket gets handed off to the real TreeApp field/individual user who'll do the work.
router.put('/tasks/:id', requireAdminOrPartner, async (req, res) => {
  try {
    const { id } = req.params
    const { name, project_id, assignee_id, target_count, location, priority, due_date, status } = req.body

    let newAssigneeProfile = null
    if (assignee_id !== undefined) {
      const { data: profile } = await supabase
        .from('profiles')
        .select('auth_id, display_name')
        .eq('auth_id', assignee_id)
        .maybeSingle()
      if (!profile) return res.status(400).json({ error: 'assignee_id does not match any known account' })
      newAssigneeProfile = profile
    }

    const updates = {}
    if (name         !== undefined) updates.name         = name
    if (project_id   !== undefined) updates.project_id   = project_id
    if (assignee_id  !== undefined) updates.assignee_id  = assignee_id
    if (target_count !== undefined) updates.target_count = target_count
    if (location     !== undefined) updates.location     = location
    if (priority     !== undefined) updates.priority     = priority
    if (due_date     !== undefined) updates.due_date     = due_date
    if (status       !== undefined) updates.status       = status

    const { data: before } = await supabase.from('tasks').select('assignee_id, name, task_code').eq('id', id).maybeSingle()

    const { data, error } = await supabase
      .from('tasks')
      .update(updates)
      .eq('id', id)
      .select()
      .single()

    if (error) throw error

    // Notify the new assignee when the ticket is actually handed off to someone new
    if (newAssigneeProfile && before && before.assignee_id !== assignee_id) {
      await createNotification({
        userId: assignee_id,
        type:   'task_assigned',
        title:  `Task assigned to you: ${data.name}`,
        body:   `${data.task_code || id.slice(0, 8).toUpperCase()} has been assigned to you.`,
        link:   '/app/tasks',
      })
    }

    res.json({ task: data })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// DELETE /api/admin/tasks/:id
router.delete('/tasks/:id', requireAdminOrPartner, async (req, res) => {
  try {
    const { id } = req.params

    // An approved task is the trigger for a ledger entry (see publishCaptureToLedger).
    // Deleting it afterward would erase the record of why that evidence exists while
    // leaving the ledger entry and the project counters it moved untouched — the same
    // integrity gap "evidence is read-only after capture" exists to prevent elsewhere.
    const { data: task } = await supabase.from('tasks').select('status').eq('id', id).maybeSingle()
    if (task?.status === 'approved') {
      return res.status(409).json({ error: 'Approved tasks cannot be deleted — their evidence is already on the ledger.' })
    }

    const { error } = await supabase.from('tasks').delete().eq('id', id)
    if (error) throw error
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// GET /api/admin/tasks/assignable-users — the curated assignee pool for task creation.
// Only accounts with a real auth login — NOT the full user list, and NOT profiles with
// no auth_id (they could never be validly assigned anything).
// ?pool=admin_partner (default) — Admin/Partner accounts. Used for creating/generating
//   tickets — who *owns* the ticket.
// ?pool=field — individual / field_user accounts who have actually captured at least one
//   tree via TreeApp (real field activity — not just signed up or logged in). Used for
//   handing an already-created ticket off to whoever will actually go do the fieldwork.
router.get('/tasks/assignable-users', requireAdminOrPartner, async (req, res) => {
  try {
    const pool = req.query.pool === 'field' ? 'field' : 'admin_partner'
    const matchRoles = pool === 'field' ? ['individual', 'field_user'] : ['admin', 'partner']

    const { data, error } = await supabase
      .from('profiles')
      .select('auth_id, display_name, role, roles')
      .not('auth_id', 'is', null)

    if (error) throw error

    let assignable = (data || []).filter(p => {
      const roles = [p.role, ...(p.roles || [])]
      return roles.some(r => matchRoles.includes(r))
    })

    // For the field pool: anyone explicitly given the field_user role is assignable
    // straight away — a partner has just created them and needs to hand them work.
    // Plain 'individual' accounts still have to show real activity (at least one
    // tree_records row) before they clutter the list.
    if (pool === 'field') {
      const { data: activeIds } = await supabase.from('tree_records').select('user_id')
      const capturedIds = new Set((activeIds || []).map(t => t.user_id))
      assignable = assignable.filter(p => {
        const roles = [p.role, ...(p.roles || [])]
        return roles.includes('field_user') || capturedIds.has(p.auth_id)
      })
    }

    res.json({
      users: assignable.map(p => ({
        auth_id:      p.auth_id,
        display_name: p.display_name || p.auth_id,
        role:         p.role,
      }))
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/admin/tasks/bulk-generate — create one task per tree in a project.
// Body: { project_id, assignee_id, priority? }
// Skips trees that already have a task (safe to call repeatedly / incrementally).
router.post('/tasks/bulk-generate', requireAdminOrPartner, async (req, res) => {
  try {
    const { project_id, assignee_id, priority } = req.body
    if (!project_id || !assignee_id) {
      return res.status(400).json({ error: 'project_id and assignee_id are required' })
    }

    const { data: assigneeProfile } = await supabase
      .from('profiles')
      .select('auth_id, role, roles')
      .eq('auth_id', assignee_id)
      .maybeSingle()
    // Field users are the point of a survey task — they were previously excluded,
    // so a task had to be created for a partner and then reassigned by hand.
    const assigneeRoles = assigneeProfile ? [assigneeProfile.role, ...(assigneeProfile.roles || [])] : []
    const ASSIGNABLE = ['admin', 'partner', 'field_user', 'individual']
    if (!assigneeProfile || !assigneeRoles.some(r => ASSIGNABLE.includes(r))) {
      return res.status(400).json({ error: 'assignee_id must belong to a known Admin, Partner or Field account' })
    }

    const { data: trees, error: treeErr } = await supabase
      .from('tree_records')
      .select('id, species, latitude, longitude')
      .eq('project_id', project_id)
    if (treeErr) throw treeErr

    const { data: existingTasks } = await supabase
      .from('tasks')
      .select('tree_id')
      .eq('project_id', project_id)
    const alreadyTicketed = new Set((existingTasks || []).map(t => t.tree_id))

    const toCreate = (trees || []).filter(t => !alreadyTicketed.has(t.id))

    let created = 0
    const errors = []
    for (const tree of toCreate) {
      const { data: codeData } = await supabase.rpc('generate_task_code', { p_tree_id: tree.id })
      const { error: insErr } = await supabase.from('tasks').insert({
        name:         `Tree Survey — ${tree.species || 'Unknown species'} (${tree.id.slice(0, 8).toUpperCase()})`,
        project_id,
        assignee_id,
        tree_id:      tree.id,
        task_code:    codeData || null,
        target_count: 1,
        // No location here — that used to pre-fill from the tree's original (months-old)
        // coordinates. Location should reflect where the field user actually is when
        // they complete this ticket, so it stays null until the app sets it on completion.
        location:     null,
        priority:     priority || 'medium',
        status:       'assigned',
        captured:     0,
        created_by:   req.reviewerId,
      })
      if (insErr) { errors.push({ tree_id: tree.id, error: insErr.message }); continue }
      created++
    }

    if (created > 0) {
      await createNotification({
        userId: assignee_id,
        type:   'task_assigned',
        title:  `${created} new tree task${created !== 1 ? 's' : ''} assigned`,
        body:   `You've been assigned ${created} tree survey task${created !== 1 ? 's' : ''} for project ${project_id}.`,
        link:   '/app/tasks',
      })
    }

    res.status(201).json({
      created,
      skipped: (trees || []).length - toCreate.length,
      totalTrees: (trees || []).length,
      errors,
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ─── Task Review (Admin + Partner) ────────────────────────────────────────────
// requireAdminOrPartner is imported above, alongside the other admin helpers.

// GET /api/admin/tasks/pending-review — tasks completed by field users, awaiting review
router.get('/tasks/pending-review', requireAdminOrPartner, async (req, res) => {
  try {
    const { project_id } = req.query
    let query = supabase
      .from('tasks')
      .select(`
        id, task_code, name, project_id, assignee_id, target_count,
        location, priority, status, due_date, started_at, completed_at,
        created_at, tree_id, captured, review_notes
      `)
      .eq('status', 'completed')
      .order('completed_at', { ascending: true })
      .limit(100)

    if (project_id) query = query.eq('project_id', project_id)

    const { data, error } = await query
    if (error) throw error

    // Enrich with assignee name
    const profileIds = [...new Set((data || []).map(t => t.assignee_id).filter(Boolean))]
    let profileMap = {}
    if (profileIds.length > 0) {
      const { data: profiles } = await supabase
        .from('profiles')
        .select('auth_id, display_name')
        .in('auth_id', profileIds)
      ;(profiles || []).forEach(p => { profileMap[p.auth_id] = p.display_name })
    }

    const projectIds = [...new Set((data || []).map(t => t.project_id).filter(Boolean))]
    let projectMap = {}
    if (projectIds.length > 0) {
      const { data: projects } = await supabase
        .from('projects')
        .select('id, name')
        .in('id', projectIds)
      ;(projects || []).forEach(p => { projectMap[p.id] = p.name })
    }

    // The photo the field user captured lives on the linked tree record, not the task.
    const treeIds = [...new Set((data || []).map(t => t.tree_id).filter(Boolean))]
    let treeMap = {}
    if (treeIds.length > 0) {
      const { data: trees } = await supabase
        .from('tree_records')
        .select('id, photo_url, species, health_status')
        .in('id', treeIds)
      ;(trees || []).forEach(tr => { treeMap[tr.id] = tr })
    }

    res.json({
      tasks: (data || []).map(t => ({
        ...t,
        assignee_name: profileMap[t.assignee_id] || '—',
        project_name:  projectMap[t.project_id]  || '—',
        photo_url:     treeMap[t.tree_id]?.photo_url     || null,
        tree_species:  treeMap[t.tree_id]?.species       || null,
        tree_health:   treeMap[t.tree_id]?.health_status || null,
      }))
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// PUT /api/admin/tasks/:id/approve
router.put('/tasks/:id/approve', requireAdminOrPartner, async (req, res) => {
  try {
    const { id } = req.params
    const { review_notes } = req.body

    const { data: task } = await supabase
      .from('tasks')
      .select('assignee_id, name, task_code, tree_id, project_id')
      .eq('id', id)
      .single()

    if (!task) return res.status(404).json({ error: 'Task not found' })

    const { error } = await supabase
      .from('tasks')
      .update({
        status:       'approved',
        reviewed_by:  req.reviewerId,
        review_notes: review_notes || null,
        reviewed_at:  new Date().toISOString(),
      })
      .eq('id', id)

    if (error) throw error

    // Approval is the verification moment — publish the capture to the ledger.
    const ledger = await publishCaptureToLedger({
      taskId:       id,
      treeId:       task.tree_id,
      projectId:    task.project_id,
      reviewerId:   req.reviewerId,
      reviewNotes:  review_notes,
    })

    if (!ledger.ok && ledger.error) {
      console.error('[tasks/approve] ledger publish failed:', ledger.error)
    }

    // Notify field user
    if (task.assignee_id) {
      await createNotification({
        userId: task.assignee_id,
        type:   'task_approved',
        title:  `Task approved ✅`,
        body:   `Your task "${task.name}" (${task.task_code || id.slice(0,8)}) has been approved.`,
        link:   '/app/tasks',
      })
    }

    res.json({ success: true, ledger })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// PUT /api/admin/tasks/:id/reject
router.put('/tasks/:id/reject', requireAdminOrPartner, async (req, res) => {
  try {
    const { id } = req.params
    const { review_notes } = req.body

    const { data: task } = await supabase
      .from('tasks')
      .select('assignee_id, name, task_code')
      .eq('id', id)
      .single()

    if (!task) return res.status(404).json({ error: 'Task not found' })

    const { error } = await supabase
      .from('tasks')
      .update({
        status:       'rejected',
        reviewed_by:  req.reviewerId,
        review_notes: review_notes || null,
        reviewed_at:  new Date().toISOString(),
      })
      .eq('id', id)

    if (error) throw error

    // Notify field user
    if (task.assignee_id) {
      await createNotification({
        userId: task.assignee_id,
        type:   'task_rejected',
        title:  `Task rejected ❌`,
        body:   `Your task "${task.name}" (${task.task_code || id.slice(0,8)}) was rejected. ${review_notes || 'Please review and redo.'}`,
        link:   '/app/tasks',
      })
    }

    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

module.exports = router