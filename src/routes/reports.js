const express = require('express')
const router = express.Router()
const supabase = require('../supabaseClient')
const { requireRole } = require('../middleware/auth')
const { replyIfMissingSchema, getOrgName } = require('../services/businessOrg')
const { fundingScope } = require('../services/funding')

// Business Reports Centre only (ProtectedRoute allows 'business'). Every query
// is scoped to owner_id = the signed-in account.
router.use(requireRole('business', 'admin'))

const TCO2E_PER_TREE = 0.017
const FRAMEWORKS = ['GHG Protocol', 'CSRD / ESRS', 'CDP', 'TCFD']

const fmtDay = (iso) => iso
  ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
  : '—'

function displayDate(r) {
  return r.status === 'Published' ? fmtDay(r.published_at) : `Created ${fmtDay(r.created_at)}`
}

/** A 4-digit period ("2026") covers that calendar year; anything else covers all time. */
function periodRange(period) {
  const m = String(period || '').match(/^(\d{4})$/)
  if (!m) return null
  const y = Number(m[1])
  return [`${y}-01-01T00:00:00Z`, `${y + 1}-01-01T00:00:00Z`]
}

/**
 * GET /api/reports
 * This organisation's reports, newest first.
 */
router.get('/', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('reports')
      .select('id, name, status, framework, period, created_at, published_at')
      .eq('owner_id', req.userId)
      .order('created_at', { ascending: false })

    if (replyIfMissingSchema(res, error)) return
    if (error) throw error

    res.json({
      reports: (data || []).map(r => ({
        id:        r.id,
        name:      r.name,
        status:    r.status || 'Draft',
        framework: r.framework || 'GHG Protocol',
        period:    r.period || '',
        date:      displayDate(r),
      })),
    })
  } catch (err) {
    console.error('[GET /api/reports]', err.message)
    res.status(500).json({ error: 'Failed to fetch reports', detail: err.message })
  }
})

/**
 * POST /api/reports
 * Generate a new (draft) report for a calendar year. Body: { year, framework, name? }
 */
router.post('/', async (req, res) => {
  try {
    const year = Number(req.body.year)
    const thisYear = new Date().getFullYear()
    if (!Number.isInteger(year) || year < 2000 || year > thisYear) {
      return res.status(400).json({ error: `Year must be between 2000 and ${thisYear}` })
    }
    const framework = FRAMEWORKS.includes(req.body.framework) ? req.body.framework : 'GHG Protocol'
    const name = String(req.body.name || '').trim() || `${year} ${framework} impact report`
    const id = `RPT-${year}-${Date.now().toString(36).toUpperCase()}`

    const { data, error } = await supabase
      .from('reports')
      .insert([{
        id, name, framework,
        period:     String(year),
        status:     'Draft',
        org_name:   await getOrgName(req.userId),
        owner_id:   req.userId,
        created_at: new Date().toISOString(),
      }])
      .select('id, name, status, framework, period, created_at, published_at')
      .single()

    if (replyIfMissingSchema(res, error)) return
    if (error) throw error

    res.status(201).json({ report: { ...data, date: displayDate(data) } })
  } catch (err) {
    console.error('[POST /api/reports]', err.message)
    res.status(500).json({ error: 'Failed to generate report', detail: err.message })
  }
})

/**
 * GET /api/reports/:id
 * One of this organisation's reports, with its funding drawn from the
 * organisation's own fundings in the report's period.
 */
router.get('/:id', async (req, res) => {
  try {
    const { data: report, error } = await supabase
      .from('reports')
      .select('*')
      .eq('id', req.params.id)
      .eq('owner_id', req.userId)
      .maybeSingle()

    if (replyIfMissingSchema(res, error)) return
    if (error) throw error
    if (!report) return res.status(404).json({ error: 'Report not found' })

    const scope = await fundingScope('business')
    let q = scope(supabase
      .from('individual_fundings')
      .select('id, project_id, trees_funded, amount_paid, funded_at, verification_status, projects(name)')
      .eq('user_id', req.userId))
      .order('funded_at', { ascending: false })
    const range = periodRange(report.period)
    if (range) q = q.gte('funded_at', range[0]).lt('funded_at', range[1])
    const { data: fundings, error: fErr } = await q
    if (fErr) throw fErr

    const entries = (fundings || []).map(f => {
      const proj = Array.isArray(f.projects) ? f.projects[0] : f.projects
      const trees = f.trees_funded || 0
      return {
        id:        f.id,
        date:      f.funded_at ? f.funded_at.slice(0, 10) : '',
        project:   proj?.name || f.project_id,
        projectId: f.project_id,
        trees,
        tCO2e:     Math.round(trees * TCO2E_PER_TREE * 100) / 100,
        amount:    Number(f.amount_paid) || 0,
        verified:  f.verification_status === 'verified',
        txHash:    null,
      }
    })

    const treesFunded = entries.reduce((s, e) => s + e.trees, 0)
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
        date:      displayDate(report),
        emissionsMeasured: total > 0,
        scopeSummary: [
          { label: 'Scope 1', value: `${fmtNum(scope1)} tCO₂e`, desc: 'Direct emissions' },
          { label: 'Scope 2', value: `${fmtNum(scope2)} tCO₂e`, desc: 'Purchased electricity' },
          { label: 'Scope 3', value: `${fmtNum(scope3)} tCO₂e`, desc: 'Value chain' },
          { label: 'Total',   value: `${fmtNum(total)} tCO₂e`,  desc: 'Combined Scope 1–3' },
        ],
        funding: {
          treesFunded,
          treesFundedFmt:        treesFunded.toLocaleString('en-IN'),
          amount:                entries.reduce((s, e) => s + e.amount, 0),
          tco2e:                 Math.round(treesFunded * TCO2E_PER_TREE * 10) / 10,
          verifiedLedgerEntries: entries.filter(e => e.verified).length,
        },
        ledgerEntries: entries,
      },
    })
  } catch (err) {
    console.error('[GET /api/reports/:id]', err.message)
    res.status(500).json({ error: 'Failed to fetch report', detail: err.message })
  }
})

module.exports = router
