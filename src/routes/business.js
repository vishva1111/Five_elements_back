/**
 * business.js — /api/business
 *
 * The signed-in business account's own organisation record (business_orgs):
 * the Settings page and the Public-profile settings page read and save it.
 */
const express = require('express')
const router = express.Router()
const supabase = require('../supabaseClient')
const { requireRole } = require('../middleware/auth')
const { replyIfMissingSchema } = require('../services/businessOrg')

router.use(requireRole('business', 'admin'))

const TEXT_FIELDS = ['org_name', 'industry', 'country', 'employees', 'framework', 'fy_end', 'tagline', 'website']
const BOOL_FIELDS = ['show_trees', 'show_tco2e', 'show_projects', 'show_ledger']

function toClient(row, fallbackName, profileSlug) {
  return {
    profileSlug:  profileSlug || null,   // the org's public profile page: /profile/<slug>
    orgName:      row?.org_name   || fallbackName || '',
    industry:     row?.industry   || '',
    country:      row?.country    || '',
    employees:    row?.employees  || '',
    framework:    row?.framework  || 'GHG Protocol',
    fyEnd:        row?.fy_end     || '31 March',
    tagline:      row?.tagline    || '',
    website:      row?.website    || '',
    visibility:   row?.visibility || 'public',
    showTrees:    row?.show_trees    ?? true,
    showTco2e:    row?.show_tco2e    ?? true,
    showProjects: row?.show_projects ?? true,
    showLedger:   row?.show_ledger   ?? true,
    saved:        !!row,
    updatedAt:    row?.updated_at || null,
  }
}

/** GET /api/business/org — this account's organisation (defaults if never saved). */
router.get('/org', async (req, res) => {
  try {
    const [{ data: row, error }, { data: profile }] = await Promise.all([
      supabase.from('business_orgs').select('*').eq('owner_id', req.userId).maybeSingle(),
      supabase.from('profiles').select('id, slug, display_name').eq('auth_id', req.userId).maybeSingle(),
    ])
    if (replyIfMissingSchema(res, error)) return
    if (error) throw error
    res.json({ org: toClient(row, profile?.display_name, profile?.slug || profile?.id) })
  } catch (err) {
    console.error('[GET /api/business/org]', err.message)
    res.status(500).json({ error: 'Failed to load organisation', detail: err.message })
  }
})

/**
 * PUT /api/business/org — save any subset of the fields (camelCase, as GET returns).
 * Fields that aren't sent keep their saved value.
 */
router.put('/org', async (req, res) => {
  try {
    const b = req.body || {}
    const camel = {
      org_name: b.orgName, industry: b.industry, country: b.country, employees: b.employees,
      framework: b.framework, fy_end: b.fyEnd, tagline: b.tagline, website: b.website,
      visibility: b.visibility,
      show_trees: b.showTrees, show_tco2e: b.showTco2e, show_projects: b.showProjects, show_ledger: b.showLedger,
    }

    const update = { owner_id: req.userId, updated_at: new Date().toISOString() }
    for (const k of TEXT_FIELDS) {
      if (camel[k] === undefined) continue
      const v = String(camel[k] ?? '').trim()
      if (v.length > 200) return res.status(400).json({ error: `${k.replace('_', ' ')} is too long` })
      update[k] = v || null
    }
    for (const k of BOOL_FIELDS) if (camel[k] !== undefined) update[k] = !!camel[k]
    if (camel.visibility !== undefined) {
      if (!['public', 'private'].includes(camel.visibility)) return res.status(400).json({ error: 'Visibility must be public or private' })
      update.visibility = camel.visibility
    }
    if ('org_name' in update && !update.org_name) return res.status(400).json({ error: 'Organisation name is required' })
    if (update.website && !/^https?:\/\/\S+\.\S+/i.test(update.website)) {
      return res.status(400).json({ error: 'Website must start with http:// or https://' })
    }

    const { data, error } = await supabase
      .from('business_orgs')
      .upsert(update, { onConflict: 'owner_id' })
      .select('*')
      .single()
    if (replyIfMissingSchema(res, error)) return
    if (error) throw error

    const { data: profile } = await supabase.from('profiles').select('id, slug').eq('auth_id', req.userId).maybeSingle()
    res.json({ org: toClient(data, null, profile?.slug || profile?.id) })
  } catch (err) {
    console.error('[PUT /api/business/org]', err.message)
    res.status(500).json({ error: 'Failed to save organisation', detail: err.message })
  }
})

module.exports = router
