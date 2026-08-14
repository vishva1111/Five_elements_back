const express  = require('express')
const router   = express.Router()
const supabase = require('../supabaseClient')
const crypto   = require('crypto')
const { createNotification } = require('./notifications')

// ─── Auth guard — admin only ──────────────────────────────────────────────────
async function requireAdmin(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '')
  if (!token) return res.status(401).json({ error: 'Unauthorized' })

  const { data: { user }, error } = await supabase.auth.getUser(token)
  if (error || !user) return res.status(401).json({ error: 'Unauthorized' })

  // Check role in profiles table
  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single()

  if (!profile || profile.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden — admin only' })
  }

  req.adminId = user.id
  next()
}

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
      .select('id, org_name, user_id, created_at')
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .limit(50)

    if (partners) {
      partners.forEach(p => {
        items.push({
          id:          p.id,
          type:        'partner',
          title:       p.org_name || 'Partner application',
          submittedBy: p.user_id || '—',
          submittedAt: new Date(p.created_at).toLocaleDateString('en-GB'),
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

    const { data: ev, error } = await supabase
      .from('evidence_files')
      .select(`
        id, file_name, file_type, file_size, file_url, notes, status, created_at,
        submission_id,
        project_submissions(
          id, submitted_by, status,
          projects(id, title, element, location, description, tree_count)
        )
      `)
      .eq('id', id)
      .single()

    if (error || !ev) return res.status(404).json({ error: 'Not found' })

    const sub  = ev.project_submissions
    const proj = sub?.projects

    res.json({
      id:            ev.id,
      submissionId:  ev.submission_id,
      projectTitle:  proj?.title || '—',
      element:       proj?.element || '—',
      submittedBy:   sub?.submitted_by || '—',
      submittedAt:   new Date(ev.created_at).toLocaleDateString('en-GB'),
      location:      proj?.location || '—',
      treeCount:     proj?.tree_count || 0,
      description:   proj?.description || '',
      evidenceNotes: ev.notes || '',
      status:        ev.status || 'pending_review',
      files: [{
        id:   ev.id,
        name: ev.file_name || 'file',
        type: ev.file_type || 'application/octet-stream',
        size: ev.file_size ? `${Math.round(ev.file_size / 1024)} KB` : '—',
        url:  ev.file_url || null,
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
      .select('id, org_name, org_type, contact_name, contact_email, website, years_active, status, created_at, description')
      .order('created_at', { ascending: false })

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
        appliedAt:    new Date(p.created_at).toLocaleDateString('en-GB'),
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
      .select('user_id, org_name')
      .eq('id', id)
      .single()

    const { error } = await supabase
      .from('partner_profiles')
      .update({ status, review_notes: reviewNotes, reviewed_by: req.adminId, reviewed_at: new Date().toISOString() })
      .eq('id', id)

    if (error) throw error

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

    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ─── A4: Users & tenants ──────────────────────────────────────────────────────
// GET /api/admin/users
router.get('/users', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('id, display_name, email, role, status, created_at, last_seen_at')
      .order('created_at', { ascending: false })

    if (error) throw error

    res.json({
      users: (data || []).map(u => ({
        id:        u.id,
        email:     u.email || '—',
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
router.get('/projects', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('projects')
      .select('id, title, element, location, status, tree_count, created_at, profiles(display_name)')
      .order('created_at', { ascending: false })

    if (error) throw error

    res.json({
      projects: (data || []).map(p => ({
        id:          p.id,
        title:       p.title,
        element:     p.element,
        location:    p.location,
        submittedBy: p.profiles?.display_name || '—',
        partnerName: '—',
        treeCount:   p.tree_count || 0,
        status:      p.status || 'pending_review',
        submittedAt: new Date(p.created_at).toLocaleDateString('en-GB'),
      }))
    })
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
      .select('id, trees_verified, co2e_verified, approved_at, public_hash, superseded_by, approved_by, projects(title), profiles(display_name)')
      .order('approved_at', { ascending: false })
      .limit(200)

    if (error) throw error

    res.json({
      entries: (data || []).map(e => ({
        id:          e.id,
        project:     e.projects?.title || '—',
        projectId:   e.project_id,
        funder:      e.profiles?.display_name || '—',
        trees:       e.trees_verified || 0,
        tCo2e:       e.co2e_verified  || 0,
        verified:    true,
        date:        e.approved_at ? new Date(e.approved_at).toLocaleDateString('en-GB') : '—',
        publicHash:  e.public_hash || '',
        supersededBy: e.superseded_by || null,
        approvedBy:  e.approved_by || null,
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
      .select('id, amount, currency, user_id, project_id, status, created_at, profiles(display_name), projects(title)')
      .order('created_at', { ascending: false })
      .limit(200)

    const transactions = (fundings || []).map(f => ({
      id:       f.id,
      type:     'funding',
      amount:   f.amount || 0,
      currency: f.currency || 'GBP',
      from:     f.profiles?.display_name || f.user_id || '—',
      to:       'Five Elements',
      project:  f.projects?.title || '—',
      status:   f.status || 'completed',
      date:     new Date(f.created_at).toLocaleDateString('en-GB'),
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

module.exports = router