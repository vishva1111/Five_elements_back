const express = require('express')
const router = express.Router()
const supabase = require('../supabaseClient')

const TCO2E_PER_TREE = 0.017

/**
 * GET /api/portfolio
 * The signed-in organisation's own funded projects — one row per project with
 * what *they* funded (trees, ₹, verification), plus summary totals.
 */
router.get('/', async (req, res) => {
  try {
    const { data: fundings, error } = await supabase
      .from('individual_fundings')
      .select('project_id, trees_funded, amount_paid, funded_at, verification_status')
      .eq('user_id', req.userId)
    if (error) throw error

    const byProject = new Map()
    for (const f of fundings || []) {
      if (!f.project_id) continue
      const g = byProject.get(f.project_id) || { trees: 0, amount: 0, fundings: 0, verifiedFundings: 0, verifiedTrees: 0, lastFunded: null }
      const trees = f.trees_funded || 0
      g.trees    += trees
      g.amount   += Number(f.amount_paid) || 0
      g.fundings += 1
      if (f.verification_status === 'verified') { g.verifiedFundings += 1; g.verifiedTrees += trees }
      if (f.funded_at && (!g.lastFunded || f.funded_at > g.lastFunded)) g.lastFunded = f.funded_at
      byProject.set(f.project_id, g)
    }

    const ids = [...byProject.keys()]
    let projects = []
    if (ids.length > 0) {
      const { data, error: pErr } = await supabase
        .from('projects')
        .select('id, slug, name, element, category, partner, location, country, certification, total_trees, funded_trees, status')
        .in('id', ids)
      if (pErr) throw pErr
      projects = data || []
    }

    const rows = projects.map(p => {
      const g = byProject.get(p.id)
      const verification = g.verifiedFundings === g.fundings ? 'verified' : g.verifiedFundings > 0 ? 'partial' : 'pending'
      return {
        id:               p.id,
        slug:             p.slug,
        name:             p.name,
        element:          (p.element || 'earth').toLowerCase(),
        category:         p.category || '—',
        partner:          p.partner || '—',
        location:         [p.location, p.country].filter(Boolean).filter((v, i, a) => i === 0 || !a[0].endsWith(v)).join(', ') || '—',
        standard:         p.certification || '—',
        trees:            g.trees,
        amount:           g.amount,
        fundings:         g.fundings,
        verifiedFundings: g.verifiedFundings,
        verifiedTrees:    g.verifiedTrees,
        tco2e:            Math.round(g.trees * TCO2E_PER_TREE * 10) / 10,
        verification,
        projectFunded:    p.funded_trees || 0,
        projectTotal:     p.total_trees  || 0,
        lastFunded:       g.lastFunded,
      }
    }).sort((a, b) => b.amount - a.amount)

    const sum = (k) => rows.reduce((s, r) => s + (r[k] || 0), 0)
    res.json({
      summary: {
        totalFunded:    sum('amount'),
        trees:          sum('trees'),
        verifiedTrees:  sum('verifiedTrees'),
        tco2e:          Math.round(sum('trees') * TCO2E_PER_TREE * 10) / 10,
        projectCount:   rows.length,
        elementsActive: new Set(rows.map(r => r.element)).size,
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
