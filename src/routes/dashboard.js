const express = require('express')
const router = express.Router()
const supabase = require('../supabaseClient')

/**
 * GET /api/dashboard
 * Returns aggregated dashboard data:
 *   - verified impact (trees funded, tCO2e offset, projects count)
 *   - funded portfolio (top 3 active projects)
 */
router.get('/', async (req, res) => {
  try {
    // 1. Fetch active projects (for portfolio section)
    const { data: projects, error: projErr } = await supabase
      .from('projects')
      .select('id, slug, name, element, location, country, partner, certification, tco2e, funded_trees, total_trees, funders_count, verified, status')
      .eq('status', 'active')
      .order('funded_trees', { ascending: false })
      .limit(3)

    if (projErr) throw projErr

    // 2. Fetch platform stats
    const { data: statsRow } = await supabase
      .from('platform_stats')
      .select('trees_funded, t_co2e_verified, projects_active')
      .eq('id', 1)
      .single()

    // ── Normalise projects for portfolio cards ─────────────────────────────
    const ELEMENT_GLYPH = {
      earth: '🌍', water: '💧', fire: '🔥', air: '💨', ether: '✨',
    }
    const ELEMENT_HERO_BG = {
      earth: 'linear-gradient(135deg,#2B5341,#4a7a5e)',
      water: 'linear-gradient(135deg,#185FA5,#2a7fc4)',
      fire:  'linear-gradient(135deg,#F09125,#e05a00)',
      air:   'linear-gradient(135deg,#534AB7,#7b72d4)',
      ether: 'linear-gradient(135deg,#112121,#2a3a3a)',
    }

    const portfolioProjects = (projects || []).map(p => {
      const el = (p.element || 'earth').toLowerCase()
      const pct = p.total_trees > 0 ? Math.round((p.funded_trees / p.total_trees) * 100) : 0
      return {
        id:          p.id,
        slug:        p.slug,
        name:        p.name,
        element:     p.element,
        elGlyph:     ELEMENT_GLYPH[el] || '🌍',
        heroBg:      ELEMENT_HERO_BG[el] || ELEMENT_HERO_BG.earth,
        location:    (() => {
          const loc = (p.location || '').trim()
          const cty = (p.country  || '').trim()
          // avoid "West Bengal, India, India" when location already ends with country
          if (cty && !loc.endsWith(cty)) return [loc, cty].filter(Boolean).join(', ')
          return loc || cty || 'India'
        })(),
        standard:    p.certification || 'Verra VCS',
        tco2:        p.tco2e ? p.tco2e.toFixed(0) : '0',
        fundedTrees: p.funded_trees || 0,
        totalTrees:  p.total_trees  || 0,
        progressPct: pct,
        verified:    p.verified || false,
        status:      pct >= 100 ? 'Completed' : p.funded_trees > 0 ? 'Active' : 'Open',
        statusBg:    pct >= 100 ? '#185FA5'   : p.funded_trees > 0 ? '#2B5341' : '#8B3A00',
      }
    })

    const curYear = new Date().getFullYear()

    res.json({
      impact: {
        treesFunded:    statsRow?.trees_funded    || 0,
        tco2eVerified:  statsRow?.t_co2e_verified || 0,
        projectsActive: statsRow?.projects_active || (projects || []).length,
        projectsFunded: portfolioProjects.length,
      },
      portfolio: portfolioProjects,
      period:    `FY ${curYear}`,
      updatedAt: new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }),
    })
  } catch (err) {
    console.error('[GET /api/dashboard]', err.message)
    res.status(500).json({ error: 'Failed to fetch dashboard data', detail: err.message })
  }
})

module.exports = router