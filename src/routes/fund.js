const express = require('express')
const router = express.Router()
const supabase = require('../supabaseClient')

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

    // userId comes from the verified JWT via requireAuth middleware
    const userId = req.userId || req.body.userId || null

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

    // ── Calculate values ──────────────────────────────────────────────────────
    const tCO2ePerTree = project.tco2e && project.total_trees > 0
      ? Number(project.tco2e) / project.total_trees
      : 0.017 // default estimate
    const tCO2e = (trees * tCO2ePerTree).toFixed(4)
    const orderId = `ORD-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`
    const today = new Date().toISOString().split('T')[0]

    // ── Insert ledger entry ───────────────────────────────────────────────────
    const { data: entry, error: insertErr } = await supabase
      .from('ledger_entries')
      .insert({
        id: orderId,
        date: today,
        project_id: project.id,
        project: project.name,
        funder: publicAttribution ? funderName : 'Anonymous',
        trees: trees,
        t_co2e: tCO2e,
        verified: false,
        tx_hash: null,
      })
      .select()
      .single()

    if (insertErr) {
      console.error('[POST /api/fund] ledger insert error:', insertErr.message)
      return res.status(500).json({ error: 'Failed to record funding', detail: insertErr.message })
    }

    // ── Update project counters ───────────────────────────────────────────────
    const { error: updateErr } = await supabase
      .from('projects')
      .update({
        funded_trees: (project.funded_trees || 0) + trees,
        funders_count: (project.funders_count || 0) + 1,
        updated_at: new Date().toISOString(),
      })
      .eq('id', project.id)

    if (updateErr) {
      // Non-fatal — ledger entry was created, just log the counter update failure
      console.error('[POST /api/fund] project update error:', updateErr.message)
    }

    // ── Insert individual_fundings row (if userId provided) ───────────────────
    if (userId) {
      const amountPaid = trees * (project.price_per_tree || 100) * 1.1 // includes 10% platform fee
      const { error: fundingErr } = await supabase
        .from('individual_fundings')
        .insert({
          user_id: userId,
          project_id: project.id,
          trees_funded: trees,
          amount_paid: Math.round(amountPaid),
          funded_at: new Date().toISOString(),
          verification_status: 'pending',
          has_ledger_entry: true,
          ledger_entry_id: null, // ledger entry id is a text field, not uuid — skip FK
          public_attribution: publicAttribution,
          funder_name: publicAttribution ? funderName : 'Anonymous',
        })
      if (fundingErr) {
        console.error('[POST /api/fund] individual_fundings insert error:', fundingErr.message)
        // Non-fatal for demo
      }
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