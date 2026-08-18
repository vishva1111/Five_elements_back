const express = require('express')
const router = express.Router()
const supabase = require('../supabaseClient')

/**
 * GET /api/reports
 * Returns all reports for the organisation.
 */
router.get('/', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('reports')
      .select('id, name, status, framework, period, created_at, published_at')
      .order('created_at', { ascending: false })

    if (error) throw error

    const reports = (data || []).map(r => ({
      id:          r.id,
      name:        r.name,
      status:      r.status || 'Draft',
      framework:   r.framework || 'GHG Protocol',
      period:      r.period || '',
      date:        r.status === 'Published'
        ? (r.published_at ? new Date(r.published_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—')
        : (r.created_at  ? `Due ${new Date(r.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}` : '—'),
    }))

    res.json({ reports })
  } catch (err) {
    console.error('[GET /api/reports]', err.message)
    res.status(500).json({ error: 'Failed to fetch reports', detail: err.message })
  }
})

/**
 * GET /api/reports/:id
 * Returns a single report by ID, with real emissions + funding data
 * aggregated from ledger_entries for the report's organisation.
 */
router.get('/:id', async (req, res) => {
  try {
    const { data: report, error } = await supabase
      .from('reports')
      .select('*')
      .eq('id', req.params.id)
      .single()

    if (error) throw error
    if (!report) return res.status(404).json({ error: 'Report not found' })

    // Normalise a name for loose matching (case/space/hyphen-insensitive)
    // e.g. "Meridian Manufacturing" ↔ "meridian-manufacturing"
    const normalise = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '')
    const orgKey = normalise(report.org_name)

    // Fetch all verified ledger entries and filter client-side by normalised funder name
    const { data: allEntries, error: ledgerErr } = await supabase
      .from('ledger_entries')
      .select('id, date, project, project_id, funder, trees, t_co2e, verified, tx_hash')
      .order('date', { ascending: false })

    if (ledgerErr) throw ledgerErr

    const orgEntries = (allEntries || []).filter(e => normalise(e.funder) === orgKey)
    const verifiedEntries = orgEntries.filter(e => e.verified)

    const treesFunded   = orgEntries.reduce((s, e) => s + (e.trees || 0), 0)
    const ledgerCount    = verifiedEntries.length

    const scope1 = parseFloat(report.scope1_tco2e || 0)
    const scope2 = parseFloat(report.scope2_tco2e || 0)
    const scope3 = parseFloat(report.scope3_tco2e || 0)
    const total  = scope1 + scope2 + scope3

    const fmtNum = (n) => n.toLocaleString('en-GB', { maximumFractionDigits: 1 })

    res.json({
      report: {
        id:        report.id,
        name:      report.name,
        status:    report.status || 'Draft',
        framework: report.framework || 'GHG Protocol',
        period:    report.period || '',
        orgName:   report.org_name || '—',
        date:      report.status === 'Published'
          ? (report.published_at ? new Date(report.published_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—')
          : (report.created_at  ? `Due ${new Date(report.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}` : '—'),
        scopeSummary: [
          { label: 'Scope 1', value: `${fmtNum(scope1)} tCO₂e`, desc: 'Direct emissions' },
          { label: 'Scope 2', value: `${fmtNum(scope2)} tCO₂e`, desc: 'Purchased electricity' },
          { label: 'Scope 3', value: `${fmtNum(scope3)} tCO₂e`, desc: 'Value chain' },
          { label: 'Total',   value: `${fmtNum(total)} tCO₂e`,  desc: 'Combined Scope 1–3' },
        ],
        funding: {
          treesFunded:          treesFunded,
          treesFundedFmt:       treesFunded.toLocaleString('en-GB'),
          verifiedLedgerEntries: ledgerCount,
        },
        ledgerEntries: orgEntries.map(e => ({
          id:       e.id,
          date:     e.date,
          project:  e.project,
          projectId: e.project_id,
          trees:    e.trees,
          tCO2e:    parseFloat(e.t_co2e || 0),
          verified: e.verified,
          txHash:   e.tx_hash,
        })),
      },
    })
  } catch (err) {
    console.error('[GET /api/reports/:id]', err.message)
    res.status(500).json({ error: 'Failed to fetch report', detail: err.message })
  }
})

module.exports = router