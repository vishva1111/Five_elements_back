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
 * Returns a single report by ID.
 */
router.get('/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('reports')
      .select('*')
      .eq('id', req.params.id)
      .single()

    if (error) throw error
    if (!data) return res.status(404).json({ error: 'Report not found' })

    res.json({ report: data })
  } catch (err) {
    console.error('[GET /api/reports/:id]', err.message)
    res.status(500).json({ error: 'Failed to fetch report', detail: err.message })
  }
})

module.exports = router