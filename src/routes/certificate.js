/**
 * certificate.js — GET /api/certificate/:id
 *
 * Returns certificate data for a given certificate ID.
 * The certificate is publicly readable (no auth required for QR/verify link),
 * but the route is registered without requireAuth in index.js.
 */

const express = require('express')
const router  = express.Router()
const supabase = require('../supabaseClient')

router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params

    // Fetch the funding record that has this certificate_id
    const { data, error } = await supabase
      .from('individual_fundings')
      .select(`
        id,
        certificate_id,
        trees_funded,
        funded_at,
        ledger_entry_id,
        verification_code,
        profiles (
          display_name
        ),
        projects (
          name,
          element,
          partner,
          location,
          tco2e
        )
      `)
      .eq('certificate_id', id)
      .single()

    if (error || !data) {
      return res.status(404).json({ error: 'Certificate not found' })
    }

    const p = data.projects || {}
    const profile = data.profiles || {}
    const tco2e = ((data.trees_funded || 0) * 0.017).toFixed(2)

    res.json({
      id:               data.certificate_id,
      recipientName:    profile.display_name || 'Anonymous',
      projectName:      p.name || 'Unknown project',
      element:          p.element || 'earth',
      partner:          p.partner || '',
      location:         p.location || '',
      treesFunded:      data.trees_funded || 0,
      tco2e,
      issuedAt:         data.funded_at
        ? new Date(data.funded_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
        : '—',
      ledgerEntryId:    data.ledger_entry_id || null,
      ledgerUrl:        data.ledger_entry_id
        ? `${process.env.FRONTEND_URL || 'http://localhost:5173'}/ledger?entry=${data.ledger_entry_id}`
        : null,
      verificationCode: data.verification_code || data.certificate_id?.slice(0, 16).toUpperCase() || '—',
    })
  } catch (err) {
    console.error('[certificate]', err)
    res.status(500).json({ error: 'Failed to fetch certificate' })
  }
})

module.exports = router