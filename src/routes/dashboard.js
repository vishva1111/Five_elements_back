const express = require('express')
const router = express.Router()
const supabase = require('../supabaseClient')

const ELEMENT_GLYPH = { earth: '🌍', water: '💧', fire: '🔥', air: '💨', ether: '✨' }
const TCO2E_PER_TREE = 0.017

function fmtLocation(p) {
  const loc = (p.location || '').trim()
  const cty = (p.country  || '').trim()
  // avoid "West Bengal, India, India" when location already ends with country
  if (cty && !loc.endsWith(cty)) return [loc, cty].filter(Boolean).join(', ')
  return loc || cty || '—'
}

/**
 * GET /api/dashboard
 * The signed-in organisation's own funding — never platform-wide figures.
 * Returns every funding (light rows) plus the projects they went to, so the
 * page can total any period it shows without another round trip.
 */
router.get('/', async (req, res) => {
  try {
    const { data: rows, error } = await supabase
      .from('individual_fundings')
      .select('id, project_id, trees_funded, amount_paid, funded_at, verification_status')
      .eq('user_id', req.userId)
      .order('funded_at', { ascending: false })
    if (error) throw error

    const projectIds = [...new Set((rows || []).map(r => r.project_id).filter(Boolean))]
    let projects = []
    if (projectIds.length > 0) {
      const { data, error: pErr } = await supabase
        .from('projects')
        .select('id, slug, name, element, location, country, certification, total_trees, funded_trees, verified, status')
        .in('id', projectIds)
      if (pErr) throw pErr
      projects = data || []
    }

    res.json({
      fundings: (rows || []).map(r => ({
        id:        r.id,
        projectId: r.project_id,
        date:      r.funded_at,
        trees:     r.trees_funded || 0,
        tco2e:     Math.round((r.trees_funded || 0) * TCO2E_PER_TREE * 100) / 100,
        amount:    Number(r.amount_paid) || 0,
        verified:  r.verification_status === 'verified',
      })),
      projects: projects.map(p => {
        const el = (p.element || 'earth').toLowerCase()
        return {
          id:          p.id,
          slug:        p.slug,
          name:        p.name,
          element:     el,
          elGlyph:     ELEMENT_GLYPH[el] || '🌍',
          location:    fmtLocation(p),
          standard:    p.certification || '—',
          totalTrees:  p.total_trees  || 0,
          fundedTrees: p.funded_trees || 0,   // whole project, all funders
          status:      p.status,
        }
      }),
      updatedAt: new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }),
    })
  } catch (err) {
    console.error('[GET /api/dashboard]', err.message)
    res.status(500).json({ error: 'Failed to fetch dashboard data', detail: err.message })
  }
})

/**
 * GET /api/dashboard/tree-records
 * Field captures from the projects the signed-in user has funded — the
 * evidence behind their money. Admins may pass ?user_id= to look at someone
 * else's.
 */
router.get('/tree-records', async (req, res) => {
  try {
    const user_id = (req.role === 'admin' && req.query.user_id) || req.userId

    const { data: fundings, error: fErr } = await supabase
      .from('individual_fundings')
      .select('project_id')
      .eq('user_id', user_id)
    if (fErr) throw fErr

    const projectIds = [...new Set((fundings || []).map(f => f.project_id).filter(Boolean))]
    if (projectIds.length === 0) return res.json({ records: [] })

    const { data, error } = await supabase
      .from('tree_records')
      .select('id, photo_url, latitude, longitude, species, health_status, notes, submitted_at, synced, project_id, status')
      .in('project_id', projectIds)
      .or('status.is.null,status.neq.rejected')   // keep un-reviewed captures, drop rejected ones
      .order('submitted_at', { ascending: false })
      .limit(12)

    if (error) throw error
    res.json({ records: data || [] })
  } catch (err) {
    console.error('[GET /api/dashboard/tree-records]', err.message)
    res.status(500).json({ error: 'Failed to fetch tree records' })
  }
})

module.exports = router
