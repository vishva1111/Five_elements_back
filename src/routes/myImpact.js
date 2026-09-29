/**
 * myImpact.js — GET /api/my-impact
 *
 * The signed-in user's own funding history and derived stats, for their
 * ImpactHome dashboard. Same query individual_fundings query the frontend
 * used to run directly against Supabase (relying on RLS to scope it to
 * req.userId) — moved server-side, scoped explicitly by req.userId instead.
 */
const express = require('express')
const router  = express.Router()
const supabase = require('../supabaseClient')

router.get('/', async (req, res) => {
  try {
    const userId = req.userId
    if (!userId) return res.json({ entries: [], stats: { trees: 0, tCO2e: 0, projects: 0, fundsInvested: 0 } })

    const { data, error } = await supabase
      .from('individual_fundings')
      .select('id,user_id,project_id,trees_funded,amount_paid,funded_at,verification_status,public_attribution,funder_name,projects(name)')
      .eq('user_id', userId)
      .order('funded_at', { ascending: false })
      .limit(200)

    if (error) throw error
    const rows = data || []

    const entries = rows.map(r => ({
      id:       r.id,
      date:     r.funded_at ? r.funded_at.split('T')[0] : '',
      // Supabase returns a joined foreign table as an array here, not a
      // single object — same quirk this query hit when it ran client-side.
      project:  r.projects?.[0]?.name ?? r.project_id,
      trees:    r.trees_funded,
      tCO2e:    Math.round(r.trees_funded * 0.017 * 10) / 10,
      verified: r.verification_status === 'verified',
      txHash:   '',
    }))

    const uniqueProjects = new Set(entries.map(e => e.project)).size
    const totalTrees     = entries.reduce((s, e) => s + (e.trees || 0), 0)
    const totalTCO2e     = entries.reduce((s, e) => s + (e.tCO2e || 0), 0)
    const totalFunds     = rows.reduce((s, r) => s + (Number(r.amount_paid) || 0), 0)

    res.json({
      entries,
      stats: {
        trees:         totalTrees,
        tCO2e:         Math.round(totalTCO2e * 10) / 10,
        projects:      uniqueProjects,
        fundsInvested: Math.round(totalFunds),
      },
    })
  } catch (err) {
    console.error('[GET /api/my-impact]', err)
    res.status(500).json({ error: 'Failed to fetch impact data' })
  }
})

module.exports = router
