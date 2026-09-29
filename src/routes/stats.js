/**
 * stats.js — GET /api/stats
 *
 * Public platform-wide totals (trees funded, tCO2e verified, active projects),
 * shown on the Landing page and Ledger page. Single-row summary table.
 */
const express = require('express')
const router  = express.Router()
const supabase = require('../supabaseClient')

router.get('/', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('platform_stats')
      .select('trees_funded, t_co2e_verified, projects_active')
      .eq('id', 1)
      .single()

    if (error) throw error

    res.json({
      treesFunded:    data?.trees_funded || 0,
      tCO2eVerified:  Number(data?.t_co2e_verified) || 0,
      projectsActive: data?.projects_active || 0,
    })
  } catch (err) {
    console.error('[GET /api/stats]', err)
    res.status(500).json({ error: 'Failed to fetch platform stats' })
  }
})

module.exports = router
