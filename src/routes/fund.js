const express = require('express')
const router = express.Router()
const supabase = require('../supabaseClient')
const { recordFunding, fundedAsAvailable } = require('../services/funding')
const { getOrgName } = require('../services/businessOrg')
const { computeProjectStats } = require('../services/projectStats')

/**
 * POST /api/fund
 * Body: {
 *   projectId: string,
 *   trees: number,
 *   funderName?: string,
 *   paymentMethod: 'card' | 'invoice',
 *   publicAttribution: boolean,
 *   cardToken?: string,
 *   fundedAs?: 'individual' | 'business',   // default 'individual'
 * }
 *
 * Returns: { orderId: string, status: 'success' }
 *
 * What it does:
 *  1. Validates the project exists and is active
 *  2. Inserts a ledger_entry row (unverified — evidence comes later)
 *  3. Increments projects.funded_trees and projects.funders_count
 *  4. Returns the new ledger entry id as orderId
 */
router.post('/', async (req, res) => {
  try {
    const {
      projectId,
      trees,
      paymentMethod = 'card',
      publicAttribution = true,
    } = req.body
    const fundedAs = req.body.fundedAs === 'business' ? 'business' : 'individual'

    // userId comes exclusively from the verified JWT via requireAuth middleware.
    // Never trust req.body.userId — it could be spoofed by the caller.
    const userId = req.userId || null

    // Funding as the business needs the Business role and the funded_as column.
    if (fundedAs === 'business') {
      if (!(req.roles || []).includes('business')) {
        return res.status(403).json({ error: 'Only a business account can fund as a business.' })
      }
      if (!(await fundedAsAvailable())) {
        return res.status(503).json({ error: 'Database update needed — run backend/sql/business_funding.sql in the Supabase SQL editor.' })
      }
    }

    // The funder's real name comes from their own profile, not the request body
    // (older clients sent the literal 'Anonymous' here when hiding their name).
    let funderName = typeof req.body.funderName === 'string' && req.body.funderName.trim() && req.body.funderName !== 'Anonymous'
      ? req.body.funderName.trim()
      : null
    if (userId && fundedAs === 'business') {
      // A business funds under its organisation's name.
      funderName = await getOrgName(userId)
    } else if (userId) {
      const { data: profile } = await supabase
        .from('profiles')
        .select('display_name')
        .eq('auth_id', userId)
        .maybeSingle()
      if (profile?.display_name) funderName = profile.display_name
    }
    funderName = funderName || 'Funder'

    // ── Validate input ────────────────────────────────────────────────────────
    if (!projectId || typeof projectId !== 'string') {
      return res.status(400).json({ error: 'projectId is required' })
    }
    if (!Number.isInteger(trees) || trees < 1) {
      return res.status(400).json({ error: 'trees must be a whole number of 1 or more' })
    }

    // ── Fetch project (try slug first, then id) ───────────────────────────────
    let project = null
    let projectErr = null

    // Try by slug
    const bySlug = await supabase
      .from('projects')
      .select('id, slug, name, status, price_per_tree, funded_trees, funders_count, tco2e, total_trees')
      .eq('slug', projectId)
      .maybeSingle()

    if (bySlug.data) {
      project = bySlug.data
    } else {
      // Try by UUID id
      const byId = await supabase
        .from('projects')
        .select('id, slug, name, status, price_per_tree, funded_trees, funders_count, tco2e, total_trees')
        .eq('id', projectId)
        .maybeSingle()
      project = byId.data
      projectErr = byId.error
    }

    if (projectErr || !project) {
      return res.status(404).json({ error: 'Project not found', projectId })
    }

    if (project.status !== 'active') {
      return res.status(400).json({ error: 'Project is not accepting funding' })
    }

    // ── Tree limit: never fund more trees than the project has left ───────────
    // Counted live from the funding records (all of them — computeProjectStats
    // pages past PostgREST's 1000-row cap) rather than trusting the cached
    // projects.funded_trees column. A project with no target has no limit.
    const totalTrees = Number(project.total_trees) || 0
    if (totalTrees > 0) {
      const live = await computeProjectStats([project.id])
      const alreadyFunded = live[project.id]?.funded_trees || 0
      const remaining = Math.max(0, totalTrees - alreadyFunded)
      if (remaining === 0) {
        return res.status(400).json({ error: 'This project is fully funded', remaining: 0 })
      }
      if (trees > remaining) {
        return res.status(400).json({
          error: `Only ${remaining.toLocaleString('en-IN')} tree${remaining === 1 ? '' : 's'} left in this project`,
          remaining,
        })
      }
    }

    // ── Record the funding (ledger entry, project counters, individual_fundings) ─
    // amountPaid is intentionally omitted here — recordFunding then applies its
    // built-in trees * price_per_tree * 1.1 default, exactly as this route
    // always has.
    let orderId, tCO2e
    try {
      ;({ orderId, tCO2e } = await recordFunding({
        project,
        trees,
        funderName,
        publicAttribution,
        userId,
        verificationStatus: 'pending',
        fundedAs,
      }))
    } catch (e) {
      console.error('[POST /api/fund]', e.message)
      return res.status(500).json({ error: 'Failed to record funding', detail: e.message })
    }

    // ── Respond ───────────────────────────────────────────────────────────────
    console.log(`[POST /api/fund] Funded ${trees} trees in "${project.name}" by "${publicAttribution ? funderName : 'Anonymous'}" — orderId: ${orderId}`)

    res.status(201).json({
      orderId,
      status: 'success',
      trees,
      project: project.name,
      tCO2e,
    })
  } catch (err) {
    console.error('[POST /api/fund] Unhandled error:', err.message)
    res.status(500).json({ error: 'Internal server error', detail: err.message })
  }
})

module.exports = router