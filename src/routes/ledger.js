/**
 * ledger.js — GET /api/ledger
 *
 * Public read of the verified-delivery ledger, for the marketplace's Ledger
 * page. Previously fetched straight from Supabase by the frontend (anon-key
 * client, browser-side); moved server-side so no frontend page queries the
 * database directly — every read goes through this API instead.
 */
const express = require('express')
const router  = express.Router()
const supabase = require('../supabaseClient')

router.get('/', async (req, res) => {
  try {
    const limit  = Number(req.query.limit)  || 200
    const offset = Number(req.query.offset) || 0

    const { data, error } = await supabase
      .from('ledger_entries')
      .select('id, date, project, funder, trees, t_co2e, verified, tx_hash')
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1)

    if (error) throw error

    const mapped = (data || []).map(r => ({
      id:       r.id,
      date:     r.date,
      project:  r.project,
      funder:   r.funder,
      trees:    r.trees,
      tCO2e:    r.t_co2e,
      verified: r.verified,
      txHash:   r.tx_hash,
    }))

    res.json({ data: mapped, count: mapped.length })
  } catch (err) {
    console.error('[GET /api/ledger]', err)
    res.status(500).json({ error: 'Failed to fetch ledger entries' })
  }
})

module.exports = router
