const express = require('express')
const router = express.Router()
const supabase = require('../supabaseClient')

/**
 * GET /api/projects
 * Query params:
 *   element   - filter by element slug (earth | water | fire | air | ether)
 *   category  - filter by category string
 *   country   - filter by country string
 *   minPrice  - minimum pricePerTree (number)
 *   maxPrice  - maximum pricePerTree (number)
 *   progress  - 'under50' | 'over50'
 *   sort      - 'newest' | 'price' | 'progress'
 *   limit     - number of results (default 50)
 *   offset    - pagination offset (default 0)
 */
router.get('/', async (req, res) => {
  try {
    const {
      element,
      category,
      country,
      minPrice,
      maxPrice,
      progress,
      sort = 'newest',
      limit = 50,
      offset = 0,
    } = req.query

    let query = supabase
      .from('projects')
      .select(`
        id,
        slug,
        name,
        element,
        category,
        location,
        country,
        partner,
        certification,
        certification_id,
        price_per_tree,
        total_trees,
        funded_trees,
        funders_count,
        last_evidence_date,
        evidence_count,
        tco2e,
        description,
        verified,
        status,
        created_at,
        cover_image
      `)
      .eq('status', 'active')

    // Filters
    if (element) query = query.eq('element', element)
    if (category && category !== 'All') query = query.eq('category', category)
    if (country && country !== 'All') query = query.ilike('country', `%${country}%`)
    if (minPrice) query = query.gte('price_per_tree', Number(minPrice))
    if (maxPrice) query = query.lte('price_per_tree', Number(maxPrice))
    if (progress === 'under50') {
      // funded_trees / total_trees < 0.5  → funded_trees < total_trees * 0.5
      // Supabase doesn't support computed filters directly; we filter post-fetch for this
    }

    // Sorting
    if (sort === 'price') {
      query = query.order('price_per_tree', { ascending: true })
    } else if (sort === 'progress') {
      // Sort by funded ratio descending — done post-fetch
      query = query.order('funded_trees', { ascending: false })
    } else {
      // newest
      query = query.order('created_at', { ascending: false })
    }

    query = query.range(Number(offset), Number(offset) + Number(limit) - 1)

    const { data, error } = await query

    if (error) throw error

    // Post-fetch progress filter
    let results = data || []
    if (progress === 'under50') {
      results = results.filter(p => p.funded_trees / p.total_trees < 0.5)
    } else if (progress === 'over50') {
      results = results.filter(p => p.funded_trees / p.total_trees >= 0.5)
    }

    // Normalise field names to camelCase for the frontend
    const normalised = results.map(p => ({
      id: p.id,
      slug: p.slug,
      name: p.name,
      element: p.element,
      category: p.category,
      location: p.location,
      country: p.country,
      partner: p.partner,
      certification: p.certification,
      certificationId: p.certification_id,
      pricePerTree: p.price_per_tree,
      totalTrees: p.total_trees,
      fundedTrees: p.funded_trees,
      fundersCount: p.funders_count,
      lastEvidenceDate: p.last_evidence_date,
      evidenceCount: p.evidence_count,
      tCO2e: p.tco2e,
      description: p.description,
      verified: p.verified,
      status: p.status,
      createdAt: p.created_at,
      coverImage: p.cover_image || null,
    }))

    res.json({ data: normalised, count: normalised.length })
  } catch (err) {
    console.error('[GET /api/projects]', err.message)
    res.status(500).json({ error: 'Failed to fetch projects', detail: err.message })
  }
})

/**
 * GET /api/projects/:slug
 * Returns a single project by slug (or id)
 */
router.get('/:slug', async (req, res) => {
  try {
    const { slug } = req.params

    const { data, error } = await supabase
      .from('projects')
      .select('*')
      .or(`slug.eq.${slug},id.eq.${slug}`)
      .single()

    if (error) throw error
    if (!data) return res.status(404).json({ error: 'Project not found' })

    const p = data
    res.json({
      id: p.id,
      slug: p.slug,
      name: p.name,
      element: p.element,
      category: p.category,
      location: p.location,
      country: p.country,
      partner: p.partner,
      certification: p.certification,
      certificationId: p.certification_id,
      pricePerTree: p.price_per_tree,
      totalTrees: p.total_trees,
      fundedTrees: p.funded_trees,
      fundersCount: p.funders_count,
      lastEvidenceDate: p.last_evidence_date,
      evidenceCount: p.evidence_count,
      tCO2e: p.tco2e,
      description: p.description,
      verified: p.verified,
      status: p.status,
      createdAt: p.created_at,
    })
  } catch (err) {
    console.error('[GET /api/projects/:slug]', err.message)
    res.status(500).json({ error: 'Failed to fetch project', detail: err.message })
  }
})

/**
 * GET /api/projects/meta/categories
 * Returns distinct categories for the filter sidebar
 */
router.get('/meta/categories', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('projects')
      .select('category')
      .eq('status', 'active')

    if (error) throw error

    const categories = ['All', ...new Set((data || []).map(r => r.category).filter(Boolean))]
    res.json({ categories })
  } catch (err) {
    console.error('[GET /api/projects/meta/categories]', err.message)
    res.status(500).json({ error: 'Failed to fetch categories' })
  }
})

module.exports = router