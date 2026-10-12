/**
 * myProjects.js — GET /api/my-projects
 *
 * Returns all projects funded by the authenticated user,
 * joined with ledger entry and certificate data.
 *
 * Protected: requireAuth middleware applied in index.js
 * req.userId is set by the auth middleware.
 */

const express = require('express')
const router  = express.Router()
const supabase = require('../supabaseClient')

router.get('/', async (req, res) => {
  try {
    const userId = req.userId

    // Fetch fundings for this user, joined with project data
    const { data, error } = await supabase
      .from('individual_fundings')
      .select(`
        id,
        trees_funded,
        amount_paid,
        funded_at,
        verification_status,
        has_ledger_entry,
        ledger_entry_id,
        certificate_id,
        projects (
          id,
          slug,
          name,
          element,
          category,
          partner,
          location,
          tco2e
        )
      `)
      .eq('user_id', userId)
      .order('funded_at', { ascending: false })

    if (error) throw error

    const projects = (data || []).map(f => {
      // A many-to-one join is a single object; tolerate the array shape too.
      const p = (Array.isArray(f.projects) ? f.projects[0] : f.projects) || {}
      const trees = f.trees_funded || 0
      return {
        id:                 f.id,
        projectId:          p.id || null,
        projectSlug:        p.slug || null,
        name:               p.name || 'Unknown project',
        element:            p.element || 'earth',
        category:           p.category || '',
        partner:            p.partner || '',
        location:           p.location || '',
        treesFunded:        trees,
        // This funding's own estimated offset — not the whole project's verified total.
        tco2e:              (trees * 0.017).toFixed(1),
        amount:             Number(f.amount_paid) || 0,
        fundedAtRaw:        f.funded_at || null,
        fundedAt:           f.funded_at
          ? new Date(f.funded_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
          : '—',
        verificationStatus: f.verification_status || 'pending',
        hasLedgerEntry:     f.has_ledger_entry || false,
        ledgerEntryId:      f.ledger_entry_id || null,
        certificateId:      f.certificate_id || null,
      }
    })

    res.json({ projects })
  } catch (err) {
    console.error('[my-projects]', err)
    res.status(500).json({ error: 'Failed to fetch projects' })
  }
})

module.exports = router