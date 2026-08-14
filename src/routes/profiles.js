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

// GET /api/profiles/:slug
router.get('/:slug', async (req, res) => {
  try {
    const { slug } = req.params

    // 1. Fetch profile by slug or id
    const { data: profile, error: profileErr } = await supabase
      .from('profiles')
      .select('*')
      .or(`slug.eq.${slug},id.eq.${slug}`)
      .single()

    if (profileErr || !profile) {
      return res.status(404).json({ error: 'Profile not found' })
    }

    // 2. Fetch ledger entries for this profile (funder = profile id)
    const { data: entries = [] } = await supabase
      .from('ledger_entries')
      .select('*')
      .eq('funder', profile.id)
      .eq('verified', true)
      .order('date', { ascending: false })

    // 3. Fetch projects funded by this profile
    const projectIds = [...new Set(entries.map(e => e.project_id))]
    let projects = []
    if (projectIds.length > 0) {
      const { data: projData = [] } = await supabase
        .from('projects')
        .select('id, name, location, certification, element')
        .in('id', projectIds)
      projects = projData
    }

    // 4. Build tiles from ledger entries
    const ICONS = { earth: '🌳', water: '💧', fire: '🔥', air: '🌬', ether: '✨' }
    const tiles = entries.map((e, i) => {
      const proj = projects.find(p => p.id === e.project_id)
      const element = proj?.element || 'earth'
      return {
        id: e.id,
        icon: ICONS[element] || '🌳',
        qty: `${e.trees.toLocaleString()} trees`,
        date: new Date(e.date).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' }),
        type: e.project,
        hero: HERO_GRADIENTS[i % HERO_GRADIENTS.length],
        tco2e: Number(e.t_co2e),
        location: proj?.location || 'India',
        standard: proj?.certification || 'Verra VCS',
        txHash: e.tx_hash,
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
      { label: 'Trees funded',   value: totalTrees.toLocaleString(), unit: 'trees' },
      { label: 'tCO₂e offset',  value: totalTco2e.toFixed(1),       unit: 'tCO₂e' },
      { label: 'Projects',       value: String(profile.projects_count || projectIds.length), unit: 'active' },
    ]
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
    const earthTrees = entries.reduce((s, e) => {
      const proj = projects.find(p => p.id === e.project_id)
      return proj?.element === 'earth' || !proj ? s + e.trees : s
    }, 0)
    const radarValues = [
      Math.min(1, earthTrees / 15000),
      0, 0, 0, 0,
    ]

    // 9. Share URL
    const shareUrl = `https://carm.fiveelements.earth/profile/${profile.slug || profile.id}`

    res.json({
      id: profile.id,
      slug: profile.slug || profile.id,
      displayName: profile.name,
      bio: profile.bio || '',
      metaLine: [profile.location, profile.type, profile.member_since ? `Member since ${profile.member_since}` : null].filter(Boolean).join(' · '),
      isOrg: profile.is_org || false,
      website: profile.website || null,
      shareNote: profile.share_note || 'Share your verified climate action.',
      shareUrl,
      radarValues,
      stats,
      tiles,
      projects: projectList,
      badges,
    })
  } catch (err) {
    console.error('profiles route error:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

module.exports = router