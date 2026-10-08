const express  = require('express')
const router   = express.Router()
const supabase = require('../supabaseClient')
const crypto   = require('crypto')
const fs       = require('fs')
const path     = require('path')
const { createNotification } = require('./notifications')
const { sendAccountCreatedEmail, sendAccountApprovedEmail } = require('../services/emailService')
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
  createDefaultProjectUser,
  requireAdmin,
  requireAdminOrPartner,
} = require('../services/adminHelpers')
const { partnerScope, partnerScopeCached, clearPartnerCache } = require('../services/partnerHelpers')

// Approving or rejecting a submission changes which projects are a partner's — drop the cached scope.
router.use((req, res, next) => {
  if (req.method !== 'GET') { clearPartnerCache(); res.on('finish', clearPartnerCache) }
  next()
})
const { syncProjectStats, syncAllProjectStats } = require('../services/projectStats')
const treeTasks = require('../services/treeTasks')
const auditSchedule = require('../services/auditSchedule')
const { activityFor } = require('../services/activityReport')
const { treeHistory, treeSummaries, allTasksFor } = require('../services/treeHistory')
const projectChanges = require('../services/projectChanges')

// submitted_by columns hold auth ids — map them to something a reviewer can
// read: profile display name first, then the auth account's email.
async function submitterNames(authIds) {
  const ids = [...new Set(authIds.filter(Boolean))]
  if (ids.length === 0) return {}

  const { data: profs } = await supabase
    .from('profiles')
    .select('auth_id, display_name, full_name, name')
    .in('auth_id', ids)

  const names = {}
  ;(profs || []).forEach(p => {
    const label = p.display_name || p.full_name || p.name
    if (label) names[p.auth_id] = label
  })

  if (ids.some(id => !names[id])) {
    const listed = await listAllAuthUsers()
    ;(listed?.users || []).forEach(u => {
      if (ids.includes(u.id) && !names[u.id] && u.email) names[u.id] = u.email
    })
  }
  return names
}

// ─── A1: Approval queue ───────────────────────────────────────────────────────
// GET /api/admin/queue/count — head-only counts for the sidebar badge, so every
// admin page can show it without pulling the whole queue.
router.get('/queue/count', requireAdmin, async (_req, res) => {
  try {
    const head = { count: 'exact', head: true }
    const [ev, pr, pa, changes] = await Promise.all([
      supabase.from('evidence_files').select('id', head).eq('status', 'pending_review'),
      supabase.from('project_submissions').select('id', head).eq('status', 'pending_review'),
      supabase.from('partner_profiles').select('id', head).eq('status', 'pending'),
      projectChanges.pendingChangeCount(),
    ])
    const evidence = ev.count || 0, projects = pr.count || 0, partners = pa.count || 0
    res.json({ total: evidence + projects + partners + changes, evidence, projects, partners, changes })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// GET /api/admin/queue
router.get('/queue', requireAdmin, async (req, res) => {
  try {
    const items = []

    // Three independent reads — none depends on another's result, so they run
    // concurrently instead of paying for three round trips back to back.
    const [{ data: evidence }, { data: projects }, { data: partners }, changes] = await Promise.all([
      supabase
        .from('evidence_files')
        .select('id, submission_id, file_name, uploaded_at, project_submissions(project_id, submitted_by, title, element)')
        .eq('status', 'pending_review')
        .order('uploaded_at', { ascending: true })
        .limit(50),
      supabase
        .from('project_submissions')
        .select('id, submitted_by, submitted_at, title, element, project_id')
        .eq('status', 'pending_review')
        .order('submitted_at', { ascending: true })
        .limit(50),
      supabase
        .from('partner_profiles')
        .select('id, org_name, user_id, applied_at, contact_name, contact_email')
        .eq('status', 'pending')
        .order('applied_at', { ascending: true })
        .limit(50),
      projectChanges.listChangeRequests({ status: 'pending' }),
    ])

    const names = await submitterNames([
      ...(evidence || []).map(e => e.project_submissions?.submitted_by),
      ...(projects || []).map(p => p.submitted_by),
    ])
    const nameOf = id => (id && (names[id] || id)) || '—'

    if (evidence) {
      evidence.forEach(e => {
        const sub = e.project_submissions
        items.push({
          id:          e.id,
          type:        'evidence',
          title:       sub?.title || 'Evidence submission',
          detail:      e.file_name || '',
          submittedBy: nameOf(sub?.submitted_by),
          submittedAt: e.uploaded_at ? new Date(e.uploaded_at).toLocaleDateString('en-GB') : '—',
          element:     sub?.element || '',
        })
      })
    }

    if (projects) {
      projects.forEach(p => {
        items.push({
          id:          p.id,
          type:        'project',
          title:       p.title || 'Project submission',
          submittedBy: nameOf(p.submitted_by),
          submittedAt: p.submitted_at ? new Date(p.submitted_at).toLocaleDateString('en-GB') : '—',
          element:     p.element || '',
        })
      })
    }

    if (partners) {
      partners.forEach(p => {
        items.push({
          id:          p.id,
          type:        'partner',
          title:       p.org_name || 'Partner application',
          submittedBy: p.contact_name || p.contact_email || p.user_id || '—',
          submittedAt: p.applied_at ? new Date(p.applied_at).toLocaleDateString('en-GB') : '—',
          element:     '',
        })
      })
    }

    // Colour / fencing / boundary changes wait here until an admin decides.
    const CHANGE_LABEL = { color: 'Colour change', fencing: 'Fencing update', boundary: 'Boundary change (app)' }
    ;(changes || []).forEach(c => {
      items.push({
        id:          c.id,
        type:        'change',
        source:      c.source,
        changeType:  c.type,
        title:       c.projectName,
        detail:      CHANGE_LABEL[c.type] || 'Project change',
        submittedBy: c.requestedByName || '—',
        submittedAt: c.createdAt ? new Date(c.createdAt).toLocaleDateString('en-GB') : '—',
        element:     '',
      })
    })

    res.json({ items })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ─── Project change requests (colour / fencing / app boundary) ────────────────
// GET /api/admin/change-requests?status=pending
router.get('/change-requests', requireAdmin, async (req, res) => {
  try {
    const status = ['pending', 'approved', 'rejected'].includes(req.query.status) ? req.query.status : undefined
    const requests = await projectChanges.listChangeRequests({ status })
    // The reviewer compares against the project as it is now, not as it was when asked.
    const ids = [...new Set(requests.map(r => r.projectId))]
    const [extras, boundaries] = await Promise.all([
      projectChanges.projectExtras(ids),
      projectChanges.geofencesFor(ids),
    ])
    res.json({
      requests: requests.map(r => ({
        ...r,
        live: { color: extras[r.projectId]?.mapColor || null, fencing: extras[r.projectId]?.fencing || null, boundary: boundaries[r.projectId] || null },
      })),
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/admin/change-requests/:source/:id/:decision — source: project | geofence; decision: approve | reject
router.post('/change-requests/:source/:id/:decision', requireAdmin, async (req, res) => {
  try {
    const { source, id, decision } = req.params
    if (!['project', 'geofence'].includes(source)) return res.status(400).json({ error: 'Unknown request source' })
    if (!['approve', 'reject'].includes(decision)) return res.status(400).json({ error: 'Unknown decision' })
    const notes = String(req.body?.review_notes || '').trim() || null
    if (decision === 'reject' && !notes) return res.status(400).json({ error: 'Say why the request is rejected' })

    const table = source === 'project' ? 'project_change_requests' : 'geofence_change_requests'
    const { data: request, error: readErr } = await supabase.from(table).select('*').eq('id', id).maybeSingle()
    if (readErr) throw readErr
    if (!request) return res.status(404).json({ error: 'Request not found' })
    if (request.status !== 'pending') return res.status(409).json({ error: `This request was already ${request.status}` })

    const { data: me } = await supabase.from('profiles').select('display_name').eq('auth_id', req.reviewerId).maybeSingle()
    const reviewer = { id: req.reviewerId, name: me?.display_name || 'Admin' }

    if (decision === 'approve') {
      if (source === 'project') await projectChanges.applyProjectRequest(request, reviewer)
      else await projectChanges.unlockBoundary(request.project_id)
    }

    const { error } = await supabase
      .from(table)
      .update({
        status:           decision === 'approve' ? 'approved' : 'rejected',
        reviewed_by:      reviewer.id,
        reviewed_by_name: reviewer.name,
        reviewed_at:      new Date().toISOString(),
        review_notes:     notes,
      })
      .eq('id', id)
    if (error) throw error

    const what = source === 'geofence' ? 'boundary change' : request.type === 'color' ? 'colour change' : 'fencing update'
    if (request.requested_by) {
      await createNotification({
        userId: request.requested_by,
        type:   decision === 'approve' ? 'change_approved' : 'change_rejected',
        title:  decision === 'approve' ? `Your ${what} was approved ✅` : `Your ${what} was not approved`,
        body:   `${request.project_name || 'Your project'}: ${decision === 'approve'
          ? (source === 'geofence' ? 'the boundary is unlocked — redraw it in the app.' : 'the change is now live.')
          : notes}`,
        link:   '/partner/projects',
      }).catch(() => {})
    }

    res.json({ success: true })
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
    const [[signed], names] = await Promise.all([
      withSignedUrls([ev]),
      submitterNames([sub?.submitted_by]),
    ])

    res.json({
      id:            ev.id,
      submissionId:  ev.submission_id,
      projectTitle:  sub?.title || '—',
      element:       sub?.element || '—',
      submittedBy:   names[sub?.submitted_by] || sub?.submitted_by || '—',
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
      .select('submission_id, project_submissions(project_id, submitted_by, title)')
      .eq('id', id)
      .single()

    if (!ev) return res.status(404).json({ error: 'Evidence not found' })

    const projectId = ev.project_submissions?.project_id
    const publicHash = crypto.randomBytes(16).toString('hex')

    const { data: project } = projectId
      ? await supabase.from('projects').select('name').eq('id', projectId).maybeSingle()
      : { data: null }

    const trees = Number(treesVerified) || 0
    const co2e  = Number(co2eVerified)  || 0

    // Create ledger entry. id, date, project and funder are NOT NULL — this
    // insert used to omit them and failed on every approval.
    const { error: ledgerErr } = await supabase
      .from('ledger_entries')
      .insert({
        id:              `le-ev-${String(id).slice(0, 8)}-${Date.now().toString(36)}`,
        date:            new Date().toISOString().slice(0, 10),
        project_id:      projectId,
        project:         project?.name || ev.project_submissions?.title || 'Unlinked submission',
        // Verified delivery, not a funding event — same sentinel idea as field captures.
        funder:          'evidence-delivery',
        trees,
        t_co2e:          co2e,
        verified:        true,
        evidence_id:     id,
        trees_verified:  trees,
        co2e_verified:   co2e,
        approved_by:     req.adminId,
        approved_at:     new Date().toISOString(),
        public_hash:     publicHash,
        review_notes:    reviewNotes || '',
      })

    if (ledgerErr) throw new Error(ledgerErr.message)

    // Update evidence status
    await supabase.from('evidence_files').update({ status: 'approved' }).eq('id', id)
    if (projectId) await syncProjectStats([projectId])

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

    // Names and file links are independent; every file of every submission is signed in one call.
    const allFiles = (data || []).flatMap(sub => sub.evidence_files || [])
    const [names, signedFiles] = await Promise.all([
      submitterNames((data || []).map(s => s.submitted_by)),
      withSignedUrls(allFiles),
    ])
    const signedById = new Map(signedFiles.map(f => [f.id, f]))
    const submissions = (data || []).map(sub => ({
      ...sub,
      submitted_by_name: names[sub.submitted_by] || null,
      evidence_files: (sub.evidence_files || []).map(f => signedById.get(f.id) || f),
    }))

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
    let defaultUser       = null

    if (action === 'approve' && !sub.project_id) {
      try {
        const slug = await uniqueProjectSlug(sub.title)

        // projects.partner is the public "delivered by" label and is NOT NULL.
        // Most submissions come from a partner org; the rest (an individual or
        // business submitting their own project) fall back to the submitter's
        // display name, so approval never fails for want of a label. The same
        // lookup also tells us below whether this project belongs to a partner
        // org at all — only those get an auto-created default User.
        const { data: partnerProfile } = await supabase
          .from('partner_profiles')
          .select('id, org_name')
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

        // A project that belongs to a partner org never opens with zero
        // Users under it — mint one automatically. Self-submitted projects
        // (no partner_profiles row for the submitter) have no team to add
        // one to, so this only runs for genuine partner projects.
        if (partnerProfile) {
          try {
            defaultUser = await createDefaultProjectUser({
              partnerId:    partnerProfile.id,
              projectSlug:  slug,
              projectTitle: sub.title,
            })
          } catch (e) {
            console.error('[admin/submissions review] default user creation failed:', e.message)
            projectWarning = `Project approved, but the default user could not be created: ${e.message}`
          }
        }
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
      success:    true,
      status:     updatePayload.status,
      outcome:    updatePayload.outcome || null,
      projectId:  createdProjectId,
      warning:    projectWarning,
      defaultUser,
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
    if (!['active', 'suspended', 'pending'].includes(status)) {
      return res.status(400).json({ error: 'status must be active, suspended or pending' })
    }

    const { data: before } = await supabase.from('profiles').select('auth_id, display_name, status').eq('id', id).maybeSingle()
    if (!before) return res.status(404).json({ error: 'User not found' })

    const { error } = await supabase.from('profiles').update({ status }).eq('id', id)
    if (error) throw error

    // Approving a pending sign-up: the Maintenance page tells them to expect an email.
    if (before.status === 'pending' && status === 'active' && before.auth_id) {
      const { data: authUser } = await supabase.auth.admin.getUserById(before.auth_id)
      if (authUser?.user?.email) {
        await sendAccountApprovedEmail({ toEmail: authUser.user.email, displayName: before.display_name })
      }
      await createNotification({
        userId: before.auth_id,
        type:   'account_approved',
        title:  'Your account is approved ✅',
        body:   'Welcome to Five Elements — you can now use your dashboard.',
        link:   null,
      })
    }

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
      .select('id, name, element, category, location, description, partner, total_trees, funded_trees, status, active, created_at')
      .order('created_at', { ascending: false })

    if (error) throw error

    const ids = (data || []).map(p => p.id)
    const [extras, boundaries] = await Promise.all([
      projectChanges.projectExtras(ids),
      projectChanges.geofencesFor(ids),
    ])

    res.json({
      projects: (data || []).map(p => ({
        id:          p.id,
        title:       p.name,
        mapColor:    extras[p.id]?.mapColor || null,
        fencing:     extras[p.id]?.fencing || null,
        boundary:    boundaries[p.id] || null,
        element:     p.element,
        category:    p.category,
        location:    p.location,
        description: p.description || null,
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

// GET /api/admin/tree-records — list tree records, optionally filtered by
// project and/or health status. Used by the task-creation form ("link to
// tree"), the bulk task-generation flow, and the Tree Records gallery page —
// the extra columns and health_status filter here are for that last one; the
// other two callers simply ignore fields and filters they don't ask for.
router.get('/tree-records', requireAdminOrPartner, async (req, res) => {
  try {
    const { project_id, health_status, limit } = req.query
    // ?with=audit adds every photo, the latest audit and project names (Tree Records page).
    const withAudit = req.query.with === 'audit'
    let query = supabase
      .from('tree_records')
      .select(withAudit ? '*' : 'id, user_id, species, project_id, photo_url, latitude, longitude, health_status, notes, submitted_at, synced')
      .order('submitted_at', { ascending: false })
      .limit(limit ? parseInt(limit, 10) : 200)

    if (project_id) query = query.eq('project_id', project_id)
    if (health_status) query = query.eq('health_status', health_status)

    // A partner sees trees on their own projects only — never another partner's.
    if (req.role === 'partner') {
      const { projectIds } = await partnerScopeCached(req.userId)
      if (projectIds.length === 0) return res.json({ records: [] })
      query = query.in('project_id', projectIds)
    }

    // The query does not depend on reconcile; only the capture ids do.
    const [{ data, error }, captures] = await Promise.all([
      query,
      treeTasks.reconcileQuietly().then(() => treeTasks.captureTreeIds()),
    ])
    if (error) throw error

    // Field-app captures are evidence for an existing tree, not trees of their own.
    const records = (data || []).filter(r => !captures.has(r.id))
    if (!withAudit) return res.json({ records })

    const projectIds = [...new Set(records.map(r => r.project_id).filter(Boolean))]
    const [summaries, projectsRes, extras] = await Promise.all([
      treeSummaries(records).catch(e => { console.error('[admin/tree-records] summaries:', e.message); return {} }),
      projectIds.length ? supabase.from('projects').select('id, name').in('id', projectIds) : Promise.resolve({ data: [] }),
      projectChanges.projectExtras(projectIds),
    ])
    const projectNames = Object.fromEntries((projectsRes.data || []).map(p => [p.id, p.name]))
    res.json({
      records: records.map(r => ({
        id:            r.id,
        tree_code:     r.tree_id || `TREE-${String(r.id).slice(0, 8).toUpperCase()}`,
        user_id:       r.user_id,
        species:       r.species,
        project_id:    r.project_id,
        project_name:  projectNames[r.project_id] || r.project_id,
        project_color: extras[r.project_id]?.mapColor || null,
        photo_url:     r.photo_url,
        photo_urls:    summaries[r.id]?.photoUrls || (r.photo_url ? [r.photo_url] : []),
        photo_count:   summaries[r.id]?.photoCount ?? (r.photo_url ? 1 : 0),
        latitude:      r.latitude,
        longitude:     r.longitude,
        health_status: r.health_status,
        tree_condition: r.tree_condition || null,
        stage:         r.stage || null,
        notes:         r.notes,
        submitted_at:  r.submitted_at,
        survey_date:   r.survey_date || null,
        synced:        r.synced,
        audit_count:   summaries[r.id]?.auditCount ?? 0,
        latest_audit:  summaries[r.id]?.latestAudit || null,
      })),
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// GET /api/admin/tree-records/:id/history — every photo, the planting and every audit round.
// Partners may read trees on their own projects (the task review uses this too).
router.get('/tree-records/:id/history', requireAdminOrPartner, async (req, res) => {
  try {
    const [, { data: tree, error }, scope] = await Promise.all([
      treeTasks.reconcileQuietly({ force: true }),
      supabase.from('tree_records').select('*').eq('id', req.params.id).maybeSingle(),
      req.role === 'partner' ? partnerScopeCached(req.userId) : Promise.resolve(null),
    ])
    if (error) throw error
    if (!tree) return res.status(404).json({ error: 'Tree record not found' })
    if (scope && !scope.projectIds.includes(tree.project_id)) return res.status(404).json({ error: 'Tree record not found' })
    res.json(await treeHistory(tree))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// PATCH /api/admin/projects/:id — edit a project's details (colour and fencing go through change requests)
router.patch('/projects/:id', requireAdmin, async (req, res) => {
  try {
    const FIELDS = { name: 160, description: 5000, location: 300, category: 120 }
    const updates = {}
    for (const [key, max] of Object.entries(FIELDS)) {
      if (req.body[key] === undefined) continue
      const value = String(req.body[key] ?? '').trim()
      if (value.length > max) return res.status(400).json({ error: `${key} is too long (max ${max} characters)` })
      updates[key] = value || null
    }
    if (req.body.totalTrees !== undefined) {
      const n = Number(req.body.totalTrees)
      if (!Number.isInteger(n) || n < 0) return res.status(400).json({ error: 'Target trees must be a whole number' })
      updates.total_trees = n
    }
    if ('name' in updates && !updates.name) return res.status(400).json({ error: 'Project name is required' })
    if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'Nothing to update' })
    const { error } = await supabase.from('projects').update(updates).eq('id', req.params.id)
    if (error) throw error
    if (updates.name) await supabase.from('project_submissions').update({ title: updates.name }).eq('project_id', req.params.id)
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/admin/projects/:id/approve
router.post('/projects/:id/approve', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params

    // projects has `name`, not `title`, and no `created_by` — the submitter is
    // on the submission that minted this project.
    const [{ data: project }, { data: sub }] = await Promise.all([
      supabase.from('projects').select('name').eq('id', id).maybeSingle(),
      supabase.from('project_submissions').select('submitted_by').eq('project_id', id).limit(1).maybeSingle(),
    ])

    const { error } = await supabase.from('projects').update({ status: 'active' }).eq('id', id)
    if (error) throw error

    // 6.4: Notify project submitter — project is now live on marketplace
    if (sub?.submitted_by) {
      await createNotification({
        userId: sub.submitted_by,
        type:   'project_approved',
        title:  'Your project is now live ✅',
        body:   `"${project?.name || 'Your project'}" has been approved and is now visible on the marketplace.`,
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
        // id, date, project and funder are NOT NULL — carried over from the original.
        id:             `le-sup-${String(id).slice(0, 8)}-${Date.now().toString(36)}`,
        date:           new Date().toISOString().slice(0, 10),
        project:        orig.project,
        funder:         orig.funder,
        trees:          orig.trees,
        t_co2e:         orig.t_co2e,
        verified:       orig.verified,
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
    if (orig.project_id) await syncProjectStats([orig.project_id])

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
// There is no config table in the database, so saved values are kept in a
// JSON file next to the backend (data/admin-config.json, git-ignored) and
// merged over these defaults. Only the editable value of each entry is stored.
const CONFIG_DEFAULTS = {
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
}
const CONFIG_FILE = path.join(__dirname, '../../data/admin-config.json')
const CONFIG_SECTIONS = {
  flags:    { list: 'featureFlags',     field: 'enabled' },
  factors:  { list: 'emissionFactors',  field: 'value' },
  settings: { list: 'platformSettings', field: 'value' },
}

function readSavedConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) } catch { return {} }
}

function currentConfig() {
  const saved = readSavedConfig()
  const out = {}
  for (const [section, { list, field }] of Object.entries(CONFIG_SECTIONS)) {
    out[list] = CONFIG_DEFAULTS[list].map(item =>
      saved[section]?.[item.key] !== undefined ? { ...item, [field]: saved[section][item.key] } : item)
  }
  return out
}

function saveConfigSection(section) {
  const { list, field } = CONFIG_SECTIONS[section]
  return (req, res) => {
    const items = req.body?.[section]
    if (!Array.isArray(items)) return res.status(400).json({ error: `${section} must be an array` })
    const known = new Set(CONFIG_DEFAULTS[list].map(i => i.key))
    const values = {}
    for (const item of items) {
      if (!item || !known.has(item.key)) continue
      const v = item[field]
      if (field === 'enabled' && typeof v !== 'boolean') return res.status(400).json({ error: `${item.key}: enabled must be true or false` })
      if (section === 'factors' && (typeof v !== 'number' || !Number.isFinite(v) || v < 0)) {
        return res.status(400).json({ error: `${item.key}: value must be a positive number` })
      }
      values[item.key] = section === 'settings' ? String(v ?? '') : v
    }
    try {
      const saved = readSavedConfig()
      saved[section] = { ...(saved[section] || {}), ...values }
      fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true })
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(saved, null, 2))
      res.json({ success: true, ...currentConfig() })
    } catch (err) {
      console.error('[admin/config save]', err)
      res.status(500).json({ error: 'Failed to save configuration' })
    }
  }
}

// GET /api/admin/config
router.get('/config', requireAdmin, (req, res) => {
  res.json(currentConfig())
})

// PATCH /api/admin/config/flags | factors | settings
router.patch('/config/flags',    requireAdmin, saveConfigSection('flags'))
router.patch('/config/factors',  requireAdmin, saveConfigSection('factors'))
router.patch('/config/settings', requireAdmin, saveConfigSection('settings'))

// ─── Task Management (Admin) ──────────────────────────────────────────────────

// GET /api/admin/tasks — list all tasks with filters
// ── Partner scope for tasks ──────────────────────────────────────────────────
// Admins see every task; a partner only ever touches tasks on their own projects.
async function taskInPartnerScope(req, res, next) {
  if (req.role !== 'partner') return next()
  try {
    const { projectIds } = await partnerScope(req.userId)
    let projectId = req.body?.project_id
    if (req.params.id) {
      const { data: task } = await supabase.from('tasks').select('project_id').eq('id', req.params.id).maybeSingle()
      if (!task) return res.status(404).json({ error: 'Task not found' })
      projectId = task.project_id
      // Moving a task to another project must stay inside the partner's projects too.
      if (req.body?.project_id && !projectIds.includes(req.body.project_id)) {
        return res.status(403).json({ error: 'That project is not one of yours' })
      }
    }
    if (!projectId || !projectIds.includes(projectId)) {
      if (req.params.id) return res.status(404).json({ error: 'Task not found' })
      return res.status(projectId ? 403 : 400).json({ error: projectId ? 'That project is not one of yours' : 'Choose one of your projects for this task' })
    }
    next()
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
}

/**
 * Where a task is, as one number and one step:
 * assigned 0% → in the field (captured / target) → submitted 90% → approved 100%.
 * A task sent back for changes counts as being in the field again.
 */
function taskProgress(t) {
  const target = Math.max(1, Number(t.target_count) || 1)
  const captured = Math.max(0, Number(t.captured) || 0)
  if (t.status === 'approved')  return { pct: 100, step: 4, label: 'Approved' }
  if (t.status === 'completed') return { pct: 90, step: 3, label: 'Submitted for review' }
  if (t.status === 'rejected')  return { pct: Math.min(60, Math.round((captured / target) * 60)), step: 2, label: 'Changes requested' }
  if (t.status === 'in_progress' || captured > 0) {
    return { pct: Math.max(10, Math.min(80, Math.round((captured / target) * 80))), step: 2, label: `In the field · ${Math.min(captured, target)}/${target}` }
  }
  return { pct: 0, step: 1, label: 'Assigned' }
}

router.get('/tasks', requireAdminOrPartner, async (req, res) => {
  try {
    await treeTasks.reconcileQuietly()   // re-link field-app completions to their trees
    const { status, project_id, assignee_id } = req.query

    // A partner works on their own projects only — never another partner's tasks.
    let scope = null
    if (req.role === 'partner') {
      scope = (await partnerScopeCached(req.userId)).projectIds
      if (scope.length === 0) return res.json({ tasks: [] })
    }

    // Every task, a page at a time — each tree has a planting task and up to four audits,
    // so a fixed cap would silently hide the oldest ones. id breaks created_at ties so pages never overlap.
    const data = []
    for (let f = 0; ; f += 1000) {
      let query = supabase
        .from('tasks')
        .select('*')
        .order('created_at', { ascending: false })
        .order('id', { ascending: true })
        .range(f, f + 999)
      if (status)      query = query.eq('status', status)
      if (project_id)  query = query.eq('project_id', project_id)
      if (assignee_id) query = query.eq('assignee_id', assignee_id)
      if (scope)       query = query.in('project_id', scope)
      const { data: page, error } = await query
      if (error) throw error
      data.push(...(page || []))
      if (!page || page.length < 1000) break
    }

    // Looks rows up 300 ids at a time, so a long task list never makes an over-long request URL.
    const rowsIn = async (table, columns, column, ids) => {
      const out = []
      for (let i = 0; i < ids.length; i += 300) {
        const { data: rows, error } = await supabase.from(table).select(columns).in(column, ids.slice(i, i + 300))
        if (error) return { data: out, error }
        out.push(...(rows || []))
      }
      return { data: out }
    }

    // Enrich with assignee name + project name + tree photo. The three lookups
    // below each key off `data` but not off each other, so they run concurrently
    // instead of three round trips back to back.
    const profileIds = [...new Set((data || []).map(t => t.assignee_id).filter(Boolean))]
    const projectIds = [...new Set((data || []).map(t => t.project_id).filter(Boolean))]
    // The tree, plus the field capture that completed the task (its photo is the evidence).
    const treeIds    = [...new Set((data || []).flatMap(t => [t.tree_id, t.capture_tree_id]).filter(Boolean))]
    // An approved audit's next round waits in audit_schedule until its date, so it isn't a task yet.
    const auditedTreeIds = [...new Set((data || []).filter(t => t.status === 'approved' && Number(t.audit_round) > 0).map(t => t.tree_id).filter(Boolean))]

    const [profilesRes, projectsRes, treesRes, scheduleRes] = await Promise.all([
      rowsIn('profiles', 'auth_id, id, display_name, role, roles', 'auth_id', profileIds),
      rowsIn('projects', 'id, name', 'id', projectIds),
      // The photo the field user captured lives on the linked tree record, not the task.
      rowsIn('tree_records', 'id, tree_id, photo_url, species, health_status, stage', 'id', treeIds),
      // No audit_schedule table yet → error, and the tasks simply carry no next_audit.
      rowsIn('audit_schedule', 'tree_id, round, due_at, status, cancel_reason', 'tree_id', auditedTreeIds),
    ])

    const profileMap = {}
    const roleMap = {}
    ;(profilesRes.data || []).forEach(p => {
      profileMap[p.auth_id] = p.display_name
      const roles = [p.role, ...(p.roles || [])]
      roleMap[p.auth_id] = roles.includes('field_user') || roles.includes('individual') ? 'field'
        : roles.includes('partner') ? 'partner' : roles.includes('admin') ? 'admin' : (p.role || null)
    })
    const projectMap = {}
    ;(projectsRes.data || []).forEach(p => { projectMap[p.id] = p.name })
    const treeMap = {}
    ;(treesRes.data || []).forEach(tr => { treeMap[tr.id] = tr })
    const scheduleMap = {}
    ;(scheduleRes.data || []).forEach(s => { scheduleMap[`${s.tree_id}:${s.round}`] = s })
    const nextAuditOf = t => {
      const s = t.status === 'approved' && Number(t.audit_round) > 0 ? scheduleMap[`${t.tree_id}:${Number(t.audit_round) + 1}`] : null
      return s ? { round: s.round, due_at: s.due_at, status: s.status, cancel_reason: s.cancel_reason || null } : null
    }

    res.json({
      tasks: (data || []).map(t => ({
        ...t,
        assignee_name: profileMap[t.assignee_id] || t.assignee_id || '—',
        project_name:  projectMap[t.project_id]  || t.project_id  || '—',
        photo_url:     treeMap[t.capture_tree_id]?.photo_url || treeMap[t.tree_id]?.photo_url || null,
        task_type:     t.task_type || 'audit',
        tree_species:  treeMap[t.tree_id]?.species       || null,
        tree_health:   treeMap[t.tree_id]?.health_status || null,
        tree_stage:    treeMap[t.tree_id]?.stage || null,
        // Human-readable tree ID (TREE-…), same fallback the listing uses.
        tree_code:     t.tree_id ? (treeMap[t.tree_id]?.tree_id || `TREE-${String(t.tree_id).slice(0, 8).toUpperCase()}`) : null,
        assignee_role: roleMap[t.assignee_id] || null,
        progress:      taskProgress(t),
        // The planned next audit (Audit 2-4) for an approved audit — pending, created, or cancelled (tree dead/missing).
        next_audit:    nextAuditOf(t),
      }))
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/admin/tasks — create a new task
// Body: { name, project_id, assignee_id, tree_id?, target_count, location, due_date }
router.post('/tasks', requireAdminOrPartner, taskInPartnerScope, async (req, res) => {
  try {
    const { name, project_id, assignee_id, tree_id, target_count, location, due_date } = req.body

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
        // Priority is gone from the panel; the mobile app still reads the column.
        priority:     'medium',
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
      body:   `Task ${task_code} has been assigned to you.`,
      link:   '/app/tasks',
    })

    res.status(201).json({ task: data })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// PUT /api/admin/tasks/:id — update task (reassign, rename, due date, etc.)
// Unlike POST /tasks, assignee_id here is NOT restricted to Admin/Partner — this is also
// how a ticket gets handed off to the real TreeApp field/individual user who'll do the work.
router.put('/tasks/:id', requireAdminOrPartner, taskInPartnerScope, async (req, res) => {
  try {
    const { id } = req.params
    const { name, project_id, assignee_id, target_count, location, due_date, status } = req.body

    // Approval publishes to the ledger and rejection notifies the field user —
    // both have their own routes, so they can't be set by a plain edit.
    if (status === 'approved' || status === 'rejected') {
      return res.status(400).json({ error: `Use the ${status === 'approved' ? 'Approve' : 'Request changes'} action to review a task` })
    }

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
router.delete('/tasks/:id', requireAdminOrPartner, taskInPartnerScope, async (req, res) => {
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
    // ?pool=partner — partner accounts only, labelled with their organisation.
    const pool = ['field', 'partner'].includes(req.query.pool) ? req.query.pool : 'admin_partner'
    const matchRoles = pool === 'field' ? ['individual', 'field_user'] : pool === 'partner' ? ['partner'] : ['admin', 'partner']

    const { data, error } = await supabase
      .from('profiles')
      .select('auth_id, display_name, role, roles')
      .not('auth_id', 'is', null)

    if (error) throw error

    let assignable = (data || []).filter(p => {
      const roles = [p.role, ...(p.roles || [])]
      return roles.some(r => matchRoles.includes(r))
    })
    // A partner can hand work to their own account, never to another partner.
    if (pool === 'partner' && req.role === 'partner') assignable = assignable.filter(p => p.auth_id === req.userId)

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

    let orgNames = {}
    if (pool === 'partner' && assignable.length > 0) {
      const { data: orgs } = await supabase
        .from('partner_profiles')
        .select('user_id, org_name')
        .in('user_id', assignable.map(p => p.auth_id))
      orgNames = Object.fromEntries((orgs || []).map(o => [o.user_id, o.org_name]))
    }

    res.json({
      users: assignable.map(p => ({
        auth_id:      p.auth_id,
        display_name: orgNames[p.auth_id]
          ? `${orgNames[p.auth_id]}${p.display_name ? ` (${p.display_name})` : ''}`
          : (p.display_name || p.auth_id),
        role:         pool === 'partner' ? 'partner' : p.role,
      }))
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/admin/tasks/bulk-generate — create one task per tree in a project.
// Body: { project_id, assignee_id }
// Skips trees that already have a task (safe to call repeatedly / incrementally).
router.post('/tasks/bulk-generate', requireAdminOrPartner, taskInPartnerScope, async (req, res) => {
  try {
    const { project_id, assignee_id } = req.body
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

    await treeTasks.reconcileQuietly()
    const [{ data: allTrees, error: treeErr }, captures] = await Promise.all([
      supabase
        .from('tree_records')
        .select('id, tree_id, species, latitude, longitude')
        .eq('project_id', project_id),
      treeTasks.captureTreeIds(),
    ])
    if (treeErr) throw treeErr
    // A field-app capture is evidence for an existing tree — it gets no task of its own.
    const trees = (allTrees || []).filter(t => !captures.has(t.id))

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
        name:         `Tree Survey — ${tree.species || 'Unknown species'} (${tree.tree_id || tree.id.slice(0, 8).toUpperCase()})`,
        project_id,
        assignee_id,
        tree_id:      tree.id,
        task_code:    codeData || null,
        target_count: 1,
        // No location here — that used to pre-fill from the tree's original (months-old)
        // coordinates. Location should reflect where the field user actually is when
        // they complete this ticket, so it stays null until the app sets it on completion.
        location:     null,
        priority:     'medium',   // still read by the mobile app
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
    await treeTasks.reconcileQuietly()   // re-link field-app completions to their trees
    const { project_id } = req.query
    let query = supabase
      .from('tasks')
      .select('*')
      .eq('status', 'completed')
      .order('completed_at', { ascending: true })
      .limit(100)

    if (project_id) query = query.eq('project_id', project_id)
    if (req.role === 'partner') {
      const { projectIds } = await partnerScopeCached(req.userId)
      if (projectIds.length === 0) return res.json({ tasks: [] })
      query = query.in('project_id', projectIds)
    }

    const { data, error } = await query
    if (error) throw error

    // Same three-independent-lookups pattern as GET /tasks — run concurrently.
    const profileIds = [...new Set((data || []).map(t => t.assignee_id).filter(Boolean))]
    const projectIds = [...new Set((data || []).map(t => t.project_id).filter(Boolean))]
    // The tree, plus the field capture that completed the task (its photo is the evidence).
    const treeIds    = [...new Set((data || []).flatMap(t => [t.tree_id, t.capture_tree_id]).filter(Boolean))]

    const [profilesRes, projectsRes, treesRes] = await Promise.all([
      profileIds.length > 0
        ? supabase.from('profiles').select('auth_id, display_name').in('auth_id', profileIds)
        : Promise.resolve({ data: [] }),
      projectIds.length > 0
        ? supabase.from('projects').select('id, name').in('id', projectIds)
        : Promise.resolve({ data: [] }),
      // The photo the field user captured lives on the linked tree record, not the task.
      treeIds.length > 0
        ? supabase.from('tree_records').select('id, tree_id, photo_url, species, health_status, stage').in('id', treeIds)
        : Promise.resolve({ data: [] }),
    ])

    const profileMap = {}
    ;(profilesRes.data || []).forEach(p => { profileMap[p.auth_id] = p.display_name })
    const projectMap = {}
    ;(projectsRes.data || []).forEach(p => { projectMap[p.id] = p.name })
    const treeMap = {}
    ;(treesRes.data || []).forEach(tr => { treeMap[tr.id] = tr })

    res.json({
      tasks: (data || []).map(t => ({
        ...t,
        assignee_name: profileMap[t.assignee_id] || '—',
        project_name:  projectMap[t.project_id]  || '—',
        photo_url:     treeMap[t.capture_tree_id]?.photo_url || treeMap[t.tree_id]?.photo_url || null,
        task_type:     t.task_type || 'audit',
        tree_species:  treeMap[t.tree_id]?.species       || null,
        tree_health:   treeMap[t.tree_id]?.health_status || null,
        tree_stage:    treeMap[t.tree_id]?.stage || null,
        // Human-readable tree ID (TREE-…), same fallback the listing uses.
        tree_code:     t.tree_id ? (treeMap[t.tree_id]?.tree_id || `TREE-${String(t.tree_id).slice(0, 8).toUpperCase()}`) : null,
      }))
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// GET /api/admin/activity?from&to&project_id — the same report as the partner's, across every project.
router.get('/activity', requireAdmin, async (req, res) => {
  try {
    const wanted = req.query.project_id ? String(req.query.project_id) : null
    let ids = wanted ? [wanted] : null
    if (!ids) {
      const { data, error } = await supabase.from('projects').select('id')
      if (error) throw error
      ids = (data || []).map(p => p.id)
    }
    res.json(await activityFor({ projectIds: ids, from: req.query.from, to: req.query.to }))
  } catch (err) {
    console.error('[admin/activity]', err)
    res.status(500).json({ error: 'Failed to load the activity report' })
  }
})

// GET /api/admin/audit-schedule?project_id — audits still to come and dead/missing trees, every project.
router.get('/audit-schedule', requireAdmin, async (req, res) => {
  try {
    const wanted = req.query.project_id ? String(req.query.project_id) : null
    let ids = wanted ? [wanted] : null
    if (!ids) {
      const { data, error } = await supabase.from('projects').select('id')
      if (error) throw error
      ids = (data || []).map(p => p.id)
    }
    res.json(await auditSchedule.overview(ids))
  } catch (err) {
    console.error('[admin/audit-schedule]', err)
    res.status(500).json({ error: 'Failed to load the audit schedule' })
  }
})

// POST /api/admin/audit-schedule/backfill[?dry=1][&open_now=1] — label old audit tasks (Audit 1..4) and plan the next
// audit for trees whose audit is already approved (open_now=1: open it today). dry=1 only reports what it would do.
router.post('/audit-schedule/backfill', requireAdmin, async (req, res) => {
  try {
    const flag = v => v === '1' || v === 'true'
    res.json(await auditSchedule.backfill({ dry: flag(req.query.dry), openNow: flag(req.query.open_now) }))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/admin/audit-schedule/run — open every audit whose date has come, now.
router.post('/audit-schedule/run', requireAdmin, async (req, res) => {
  try {
    const made = await auditSchedule.runDue({ limit: 500 })
    res.json({ opened: made.length, tasks: made })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// PUT /api/admin/tasks/:id/approve
router.put('/tasks/:id/approve', requireAdminOrPartner, taskInPartnerScope, async (req, res) => {
  try {
    await treeTasks.reconcileCaptureTasks({ force: true })   // act on the task as linked to its own tree
    const { id } = req.params
    const { review_notes } = req.body

    const { data: task } = await supabase
      .from('tasks')
      .select('*')
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

    // A planting task only proves the tree is in the ground: the tree becomes
    // Planted and its audit task opens. The ledger waits for the audit.
    if (treeTasks.typeOf(task) === treeTasks.PLANTING) {
      const auditTask = task.tree_id ? await treeTasks.onPlantingApproved(task, req.reviewerId) : null
      if (task.assignee_id) {
        await createNotification({
          userId: task.assignee_id,
          type:   'task_approved',
          title:  'Planting approved ✅',
          body:   `Your planting task "${task.name}" (${task.task_code || id.slice(0, 8)}) has been approved.`,
          link:   '/app/tasks',
        })
      }
      return res.json({ success: true, planted: true, auditTask })
    }

    // An approved audit plans the next one (Audit 2-4), 3 months from today — or stops the
    // cycle when the tree was found dead/missing. Never lets a scheduling problem fail the approval.
    const nextAudit = await auditSchedule.onAuditApproved(task).catch(e => {
      console.error('[tasks/approve] audit schedule failed:', e.message)
      return { error: e.message }
    })

    // Approval is the verification moment — publish the capture to the ledger. A tree the audit
    // found dead or missing is not verified impact, so it never enters the ledger this way.
    const ledger = nextAudit?.stopped
      ? { ok: false, skipped: `tree found ${nextAudit.stopped}` }
      : await publishCaptureToLedger({
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

    res.json({ success: true, ledger, nextAudit })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// PUT /api/admin/tasks/:id/reject  (also served as /request-changes, same thing)
// Rejects the submission and sends it back to the field user with the reason. The task goes
// to status 'rejected' because that is the value the mobile app reads to show
// its Edit button; the user fixes it on the same task and resubmits.
const rejectTask = requireNote => async (req, res) => {
  try {
    await treeTasks.reconcileCaptureTasks({ force: true })   // act on the task as linked to its own tree
    const { id } = req.params
    const review_notes = String(req.body?.review_notes || '').trim()
    // The Submission review page always asks for a reason; the older Tasks page may leave it empty.
    if (requireNote && !review_notes) return res.status(400).json({ error: 'Say why it is rejected' })

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
        body:   `"${task.name}" (${task.task_code || id.slice(0,8)}) was rejected. ${review_notes || 'Please review and redo.'}`,
        link:   '/app/tasks',
      })
    }

    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}
router.put('/tasks/:id/request-changes', requireAdminOrPartner, taskInPartnerScope, rejectTask(true))
router.put('/tasks/:id/reject',          requireAdminOrPartner, taskInPartnerScope, rejectTask(false))

module.exports = router