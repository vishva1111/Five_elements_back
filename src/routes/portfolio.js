const express = require('express')
const router = express.Router()
const supabase = require('../supabaseClient')

/**
 * GET /api/portfolio
 * Returns the organisation's funded portfolio with summary stats.
 */
router.get('/', async (req, res) => {
  try {
    // Fetch all projects (funded ones for this org)
    const { data: projects, error: projErr } = await supabase
      .from('projects')
      .select('id, name, element, category, partner, location, country, funded_trees, total_trees, tco2e, verified, status, certification, funded_amount, verification_status, has_ledger_entry, ledger_entry_id')
      .order('funded_amount', { ascending: false })

    if (projErr) throw projErr

    // Fetch platform stats for summary strip
    const { data: stats } = await supabase
      .from('platform_stats')
      .select('trees_funded, t_co2e_verified, projects_active')
      .eq('id', 1)
      .single()

    const rows = (projects || []).map(p => {
      const pct = p.total_trees > 0 ? Math.round((p.funded_trees / p.total_trees) * 100) : 0
      const verStatus = p.verification_status || (p.verified ? 'verified' : 'progress')
      const barColor = verStatus === 'verified' ? '#2B5341' : verStatus === 'progress' ? '#F5C27A' : '#D8CEC2'
      const rowBg = verStatus === 'paused' ? '#FDF6EE' : '#fff'

      return {
        id:                 p.id,
        name:               p.name,
        element:            p.element || 'earth',
        category:           p.category || '—',
        partner:            p.partner || '—',
        location:           [p.location, p.country].filter(Boolean).join(', '),
        fundedAmount:       p.funded_amount || 0,
        fundedAmountFmt:    `£${(p.funded_amount || 0).toLocaleString('en-GB')}`,
        fundedTrees:        p.funded_trees || 0,
        totalTrees:         p.total_trees || 0,
        progressPct:        pct,
        progressLabel:      pct >= 100 ? '100%' : pct > 0 ? `${pct}%` : 'expected Q2 2026',
        barColor,
        rowBg,
        verificationStatus: verStatus,
        standard:           p.certification || 'Verra VCS',
        hasLedgerEntry:     p.has_ledger_entry || false,
        ledgerEntryId:      p.ledger_entry_id || null,
        tco2e:              parseFloat(p.tco2e || 0).toFixed(0),
      }
    })

    // Summary totals
    const totalFunded    = rows.reduce((s, r) => s + r.fundedAmount, 0)
    const verifiedTco2   = rows.filter(r => r.verificationStatus === 'verified').reduce((s, r) => s + parseFloat(r.tco2e), 0)
    const verifiedTrees  = rows.filter(r => r.verificationStatus === 'verified').reduce((s, r) => s + r.fundedTrees, 0)
    const projectCount   = rows.length

    res.json({
      summary: {
        totalFunded:    `£${totalFunded.toLocaleString('en-GB')}`,
        verifiedTco2:   verifiedTco2.toFixed(0),
        verifiedTrees:  verifiedTrees.toLocaleString('en-GB'),
        projectCount,
        elementsActive: 1,
        elementsTotal:  5,
      },
      projects: rows,
    })
  } catch (err) {
    console.error('[GET /api/portfolio]', err.message)
    res.status(500).json({ error: 'Failed to fetch portfolio', detail: err.message })
  }
})

module.exports = router