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
      const p = f.projects || {}
      return {
        id:                 f.id,
        name:               p.name || 'Unknown project',
        element:            p.element || 'earth',
        category:           p.category || '',
        partner:            p.partner || '',
        location:           p.location || '',
        treesFunded:        f.trees_funded || 0,
        tco2e:              parseFloat(p.tco2e || 0).toFixed(1),
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