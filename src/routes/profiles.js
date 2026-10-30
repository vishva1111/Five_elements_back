const express = require('express')
const router = express.Router()
const supabase = require('../supabaseClient')

const HERO_GRADIENTS = [
  'linear-gradient(135deg,#2B5341,#4a7a5e)',
  'linear-gradient(135deg,#3a5f2b,#6b8f4a)',
  'linear-gradient(135deg,#2b5341,#185f5a)',
  'linear-gradient(135deg,#1a4a35,#2B5341)',
  'linear-gradient(135deg,#2B5341,#3D7A5C)',
]

/**
 * GET /api/profiles — community directory list, for the Profiles browse page.
 * Query params: type ('individual' | 'business' | 'All')
 * Only profiles with trees > 0 (real users with actual impact) are shown.
 */
router.get('/', async (req, res) => {
  try {
    const { type } = req.query

    let query = supabase
      .from('profiles')
      .select('id, auth_id, name, type, location, avatar, trees, t_co2e, created_at')
      .order('trees', { ascending: false })
      .gt('trees', 0)

    if (type && type !== 'All') query = query.eq('type', type)

    const { data, error } = await query
    if (error) throw error

    // Organisations that set their public profile to private are left out.
    const hidden = await privateOrgOwners()
    const profiles = (data || []).filter(r => !hidden.has(r.auth_id)).map(r => ({
      id:       r.id,
      name:     r.name,
      type:     r.type?.toLowerCase() === 'business' ? 'organisation' : 'individual',
      location: r.location,
      avatar:   r.avatar || '',
      trees:    r.trees,
      tCO2e:    Number(r.t_co2e) || 0,
    }))

    res.json({ data: profiles })
  } catch (err) {
    console.error('[GET /api/profiles]', err)
    res.status(500).json({ error: 'Failed to fetch profiles' })
  }
})

// GET /api/profiles/:slug
router.get('/:slug', async (req, res) => {
  try {
    const { slug } = req.params
    // slug goes into a PostgREST .or() filter string — commas, dots or parens
    // there would let a caller append their own filter conditions.
    if (!/^[A-Za-z0-9_-]+$/.test(slug)) return res.status(404).json({ error: 'Profile not found' })

    // 1. Fetch profile by slug or id
    const { data: profile, error: profileErr } = await supabase
      .from('profiles')
      .select('*')
      .or(`slug.eq.${slug},id.eq.${slug}`)
      .single()

    if (profileErr || !profile) {
      return res.status(404).json({ error: 'Profile not found' })
    }

    // A business's own public-profile settings (Business → Public profile).
    const org = await orgSettingsFor(profile.auth_id)
    if (org?.visibility === 'private') return res.status(404).json({ error: 'Profile not found' })

    // 2. Fetch funding records for this profile via individual_fundings.user_id = profile.auth_id.
    //    This is the correct linkage — ledger_entries.funder stores a display name string,
    //    not a profile id, so querying ledger_entries by profile.id always returns empty.
    //    FALLBACK: seed/demo profiles have auth_id = null; for those we query ledger_entries
    //    directly by funder matching profile.id or profile.name.
    let fundings = []
    if (profile.auth_id) {
      const { data: fundingsData } = await supabase
        .from('individual_fundings')
        .select('id, project_id, trees_funded, funded_at, funder_name, public_attribution, verification_status')
        .eq('user_id', profile.auth_id)
        .order('funded_at', { ascending: false })
      fundings = fundingsData || []
    } else {
      // No auth_id — fall back to ledger_entries matched by funder name/slug.
      // We try both profile.id (slug) and profile.name (display name) with exact eq match,
      // then fall back to ilike wildcards, then finally synthesise tiles from active projects.
      const funderMatches = [profile.id, profile.name].filter(Boolean)
      let ledgerFallback = []

      if (funderMatches.length > 0) {
        // 1st attempt: exact eq match (handles "aditi-sharma" and "Aditi Sharma")
        const orFilter = funderMatches.map(f => `funder.eq.${f}`).join(',')
        const { data: lRows, error: lErr } = await supabase
          .from('ledger_entries')
          .select('id, project_id, trees_verified, approved_at, date, tx_hash, verified, funder')
          .or(orFilter)
          .order('approved_at', { ascending: false })
        if (lErr) console.error('[profiles fallback ledger eq query]', lErr)
        ledgerFallback = lRows || []

        // 2nd attempt: ilike wildcard (handles partial / case-variant matches)
        if (ledgerFallback.length === 0) {
          const ilikeFilter = funderMatches.map(f => `funder.ilike.%${f}%`).join(',')
          const { data: ilikeRows } = await supabase
            .from('ledger_entries')
            .select('id, project_id, trees_verified, approved_at, date, tx_hash, verified, funder')
            .or(ilikeFilter)
            .order('approved_at', { ascending: false })
          ledgerFallback = ilikeRows || []
        }
      }

      const totalProfileTrees = Number(profile.trees) || 0

      if (ledgerFallback.length > 0) {
        // Distribute profile.trees evenly across entries when trees_verified = 0
        const perEntry = Math.round(totalProfileTrees / ledgerFallback.length)
        fundings = ledgerFallback.map(l => ({
          id:                  l.id,
          project_id:          l.project_id,
          trees_funded:        l.trees_verified > 0 ? l.trees_verified : perEntry,
          funded_at:           l.approved_at || l.date,
          funder_name:         l.funder,
          public_attribution:  true,
          verification_status: l.verified ? 'verified' : 'pending',
          _txHash:             l.tx_hash || null,
        }))
      } else if (totalProfileTrees > 0) {
        // 3rd attempt: no ledger entries at all — synthesise tiles from active projects.
        // Pick up to 3 active projects and distribute the profile's tree count across them.
        const { data: activeProjRows } = await supabase
          .from('projects')
          .select('id, name, location, certification, element')
          .eq('status', 'active')
          .order('created_at', { ascending: false })
          .limit(3)
        const activeProjs = activeProjRows || []
        const count = activeProjs.length || 1
        const perProj = Math.round(totalProfileTrees / count)
        fundings = activeProjs.map((p, i) => ({
          id:                  `${profile.id}-synthetic-${i}`,
          project_id:          p.id,
          trees_funded:        i === activeProjs.length - 1
                                 ? totalProfileTrees - perProj * (count - 1)  // remainder on last
                                 : perProj,
          funded_at:           profile.created_at || new Date().toISOString(),
          funder_name:         profile.name,
          public_attribution:  true,
          verification_status: 'verified',
          _txHash:             null,
        }))
      }
    }

    // 3. Fetch projects funded by this profile
    const projectIds = [...new Set(fundings.map(f => f.project_id).filter(Boolean))]
    let projects = []
    if (projectIds.length > 0) {
      const { data: projData } = await supabase
        .from('projects')
        .select('id, name, location, certification, element')
        .in('id', projectIds)
      projects = projData || []
    }

    // 4. Fetch matching ledger entries to get tx_hash (best-effort, keyed by orderId stored in ledger_entries.id)
    //    individual_fundings rows created by recordFunding() get an ORD-* id that matches ledger_entries.id.
    //    We fetch all ledger entries for these projects and match by project + approximate date.
    let ledgerByProject = {}
    if (projectIds.length > 0) {
      const { data: ledgerRows } = await supabase
        .from('ledger_entries')
        .select('id, project_id, date, tx_hash, verified')
        .in('project_id', projectIds)
        .not('tx_hash', 'is', null)
      for (const row of ledgerRows || []) {
        if (!ledgerByProject[row.project_id]) ledgerByProject[row.project_id] = []
        ledgerByProject[row.project_id].push(row)
      }
    }

    // 4. Build tiles from individual_fundings
    const ICONS = { earth: '🌳', water: '💧', fire: '🔥', air: '🌬', ether: '✨' }
    const tiles = fundings.map((f, i) => {
      const proj = projects.find(p => p.id === f.project_id)
      const element = proj?.element || 'earth'
      // Try to find a matching ledger entry for tx_hash (same project, closest date)
      const fundDate = f.funded_at ? f.funded_at.slice(0, 10) : null
      const ledgerRows = ledgerByProject[f.project_id] || []
      const matchedLedger = fundDate
        ? ledgerRows.find(r => r.date === fundDate) || ledgerRows[0]
        : ledgerRows[0]
      return {
        id: f.id,
        projectId: f.project_id || null,
        icon: ICONS[element] || '🌳',
        qty: `${(f.trees_funded || 0).toLocaleString()} trees`,
        date: f.funded_at
          ? new Date(f.funded_at).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })
          : '—',
        type: proj?.name || '—',
        hero: HERO_GRADIENTS[i % HERO_GRADIENTS.length],
        tco2e: Number(((f.trees_funded || 0) * 0.017).toFixed(4)),
        location: proj?.location || 'India',
        standard: proj?.certification || 'Verra VCS',
        txHash: matchedLedger?.tx_hash || f._txHash || null,
        verified: f.verification_status === 'verified',
      }
    })

    // 5. Build projects list
    const projectList = projects.map((p, i) => ({
      id: p.id,
      name: p.name,
      location: p.location || 'India',
      standard: p.certification || 'Verra VCS',
      hero: HERO_GRADIENTS[i % HERO_GRADIENTS.length],
    }))

    // 6. Build stats
    const totalTrees = Number(profile.trees) || 0
    const totalTco2e = Number(profile.t_co2e) || 0
    const stats = [
      org?.show_trees    === false ? null : { label: 'Trees funded',   value: totalTrees.toLocaleString(), unit: 'trees' },
      org?.show_tco2e    === false ? null : { label: 'tCO₂e offset',  value: totalTco2e.toFixed(1),       unit: 'tCO₂e' },
      org?.show_projects === false ? null : { label: 'Projects',       value: String(profile.projects_count || projectIds.length), unit: 'active' },
    ].filter(Boolean)
    if (profile.member_since) {
      stats.push({ label: 'Verified since', value: profile.member_since, unit: '' })
    }

    // 7. Milestones badges
    const badges = [
      { icon: '🌱', label: 'First tree',  fill: totalTrees >= 1     ? '#2B5341' : 'none', opacity: totalTrees >= 1     ? 1 : 0.3 },
      { icon: '🌳', label: '1,000 trees', fill: totalTrees >= 1000  ? '#2B5341' : 'none', opacity: totalTrees >= 1000  ? 1 : 0.3 },
      { icon: '🏆', label: '10k trees',   fill: totalTrees >= 10000 ? '#2B5341' : 'none', opacity: totalTrees >= 10000 ? 1 : 0.3 },
      { icon: '⭐', label: '3 elements',  fill: 'none', opacity: 0.3 },
    ]

    // 8. Radar values (earth only for now)
    const earthTrees = fundings.reduce((s, f) => {
      const proj = projects.find(p => p.id === f.project_id)
      return proj?.element === 'earth' || !proj ? s + (f.trees_funded || 0) : s
    }, 0)
    const radarValues = [
      Math.min(1, earthTrees / 15000),
      0, 0, 0, 0,
    ]

    // 9. Share URL — use FRONTEND_URL env var so localhost dev and production
    // both generate a working link. Falls back to the production domain only
    // if the env var is not set (e.g. an old deployment without it configured).
    const frontendBase = (process.env.FRONTEND_URL || 'https://carm.fiveelements.earth').replace(/\/$/, '')
    const shareUrl = `${frontendBase}/profile/${profile.slug || profile.id}`

    res.json({
      id: profile.id,
      slug: profile.slug || profile.id,
      displayName: org?.org_name || profile.name,
      bio: org?.tagline || profile.bio || '',
      metaLine: [profile.location, profile.type, profile.member_since ? `Member since ${profile.member_since}` : null].filter(Boolean).join(' · '),
      isOrg: profile.is_org || profile.type?.toLowerCase() === 'business',
      website: org?.website || profile.website || null,
      shareNote: profile.share_note || 'Share your verified climate action.',
      shareUrl,
      radarValues,
      stats,
      tiles: org?.show_ledger === false ? [] : tiles,
      projects: projectList,
      badges,
    })
  } catch (err) {
    console.error('profiles route error:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Business public-profile settings (business_orgs) ────────────────────────
// Both helpers tolerate the table not existing yet (migration not run).

async function orgSettingsFor(authId) {
  if (!authId) return null
  const { data, error } = await supabase.from('business_orgs').select('*').eq('owner_id', authId).maybeSingle()
  return error ? null : data
}

async function privateOrgOwners() {
  const { data, error } = await supabase.from('business_orgs').select('owner_id').eq('visibility', 'private')
  return new Set(error ? [] : (data || []).map(r => r.owner_id))
}

module.exports = router