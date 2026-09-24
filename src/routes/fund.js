const express = require('express')
const router = express.Router()
const supabase = require('../supabaseClient')
const { recordFunding } = require('../services/funding')

/**
 * POST /api/fund
 * Body: {
 *   projectId: string,
 *   trees: number,
 *   funderName?: string,
 *   paymentMethod: 'card' | 'invoice',
 *   publicAttribution: boolean,
 *   cardToken?: string,
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
      funderName = 'Anonymous',
      paymentMethod = 'card',
      publicAttribution = true,
    } = req.body

    // userId comes exclusively from the verified JWT via requireAuth middleware.
    // Never trust req.body.userId — it could be spoofed by the caller.
    const userId = req.userId || null

    // ── Validate input ────────────────────────────────────────────────────────
    if (!projectId || typeof projectId !== 'string') {
      return res.status(400).json({ error: 'projectId is required' })
    }
    if (!trees || typeof trees !== 'number' || trees < 1) {
      return res.status(400).json({ error: 'trees must be a positive number' })
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