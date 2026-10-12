/**
 * stats.js — GET /api/stats
 *
 * Public platform-wide totals (trees funded, tCO2e verified, active projects),
 * shown on the Landing page, Ledger page and the Individual dashboard.
 * Computed live from the projects so they never go stale.
 */
const express = require('express')
const router  = express.Router()
const { getPlatformStats } = require('../services/projectStats')

router.get('/', async (req, res) => {
  try {
    res.json(await getPlatformStats())
  } catch (err) {
    console.error('[GET /api/stats]', err)
    res.status(500).json({ error: 'Failed to fetch platform stats' })
  }
})

module.exports = router
