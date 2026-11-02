/**
 * ledger.js — public ledger API, for the marketplace's Ledger page.
 *
 *   GET /api/ledger              paginated, filtered entries
 *   GET /api/ledger/summary      tree / tCO2e totals for the same filters
 *   GET /api/ledger/projects     projects that appear on the ledger (filter dropdown)
 *   GET /api/ledger/export.csv   same filters as GET /, as a CSV download
 *
 * Previously fetched straight from Supabase by the frontend (anon-key client,
 * browser-side); moved server-side so no frontend page queries the database
 * directly — every read goes through this API instead.
 *
 * Superseded entries (corrected by an admin) are always excluded — only the
 * replacement entry is public, so nothing is counted twice.
 */
const express = require('express')
const router  = express.Router()
const supabase = require('../supabaseClient')

// Delivery entries (field captures, approved evidence) carry a sentinel in the
// NOT NULL funder column instead of a funder identity. Classifying by funder
// rather than id prefix keeps superseded copies ("le-sup-...") typed correctly.
const DELIVERY_FUNDERS = ['field-delivery', 'evidence-delivery']

const FUNDER_LABELS = {
  'field-delivery':    'Field team',
  'evidence-delivery': 'Partner evidence',
}

const MAX_LIMIT  = 200
const EXPORT_CAP = 5000

function funderLabel(funder) {
  if (!funder) return '—'
  return FUNDER_LABELS[funder] ?? funder
}

/**
 * Applies ?q=, ?type= and ?project= to a ledger_entries query.
 * q matches project name, funder (raw or display label) and entry id; a
 * leading "#" is ignored so the short refs shown in the table work too.
 */
function applyFilters(query, { q, type, project }) {
  query = query.is('superseded_by', null)

  if (type === 'planted') query = query.in('funder', DELIVERY_FUNDERS)
  if (type === 'funded')  query = query.not('funder', 'in', `(${DELIVERY_FUNDERS.join(',')})`)

  if (project) query = query.eq('project_id', project)

  // Strip PostgREST filter syntax characters so user input can't break the or() expression
  const term = String(q || '').trim().replace(/^#/, '').replace(/[,()%*\\:"]/g, ' ').trim()
  if (term) {
    const lower = term.toLowerCase()
    const conds = [
      `project.ilike.%${term}%`,
      `funder.ilike.%${term}%`,
      `id.ilike.%${term}%`,
      ...Object.entries(FUNDER_LABELS)
        .filter(([, label]) => label.toLowerCase().includes(lower))
        .map(([raw]) => `funder.eq.${raw}`),
    ]
    query = query.or(conds.join(','))
  }

  return query
}

const SELECT = 'id, date, project, project_id, funder, trees, t_co2e, trees_verified, co2e_verified, verified, approved_at, public_hash, projects(slug, location, partner)'

// Public tree fields only — surveyor / team member names stay private.
const TREE_SELECT = 'id, species, scientific_name, photo_url, photo_urls, latitude, longitude, health_status, tree_condition, height_m, survey_date, submitted_at'

/** Field app stores species as "Vad (TREE-L0W9ZQ5)"; split the tag code out. */
function splitSpecies(raw) {
  const m = String(raw || '').match(/^(.*?)\s*\((TREE-[A-Z0-9]+)\)\s*$/i)
  return m ? { name: m[1] || null, code: m[2].toUpperCase() } : { name: raw || null, code: null }
}

function toTree(t) {
  const { name, code } = splitSpecies(t.species)
  const photos = Array.isArray(t.photo_urls) && t.photo_urls.length
    ? t.photo_urls
    : (t.photo_url ? [t.photo_url] : [])
  return {
    species:        name,
    scientificName: t.scientific_name || null,
    code,
    photos:         photos.slice(0, 4),
    lat:            t.latitude,
    lng:            t.longitude,
    condition:      t.tree_condition || t.health_status || null,
    heightM:        t.height_m ?? null,
    plantedOn:      t.survey_date || (t.submitted_at || '').slice(0, 10) || null,
  }
}

/** Tree details for field-capture entries, whose public_hash is "tree:<tree_records.id>". */
async function treesByHash(rows) {
  const treeIds = rows
    .map(r => r.public_hash)
    .filter(h => typeof h === 'string' && h.startsWith('tree:'))
    .map(h => h.slice(5))
  if (!treeIds.length) return {}

  const { data } = await supabase.from('tree_records').select(TREE_SELECT).in('id', treeIds)
  return Object.fromEntries((data || []).map(t => [`tree:${t.id}`, toTree(t)]))
}

function toEntry(r, trees) {
  const planted = DELIVERY_FUNDERS.includes(r.funder)
  return {
    id:              r.id,
    date:            r.date,
    type:            planted ? 'planted' : 'funded',
    project:         r.project,
    projectId:       r.project_id,
    projectSlug:     r.projects?.slug || null,
    projectLocation: r.projects?.location || null,
    partner:         r.projects?.partner || null,
    funder:          r.funder,
    funderLabel:     funderLabel(r.funder),
    trees:           planted ? (r.trees_verified ?? r.trees) : r.trees,
    // Funded rows carry a per-tree estimate made at funding time; delivery rows
    // carry the verified figure.
    tCO2e:           Number(planted ? (r.co2e_verified ?? r.t_co2e) : r.t_co2e),
    estimated:       !planted,
    verified:        r.verified,
    verifiedAt:      r.verified ? (r.approved_at || null) : null,
    tree:            trees[r.public_hash] || null,
  }
}

// GET /api/ledger?limit=&offset=&q=&type=planted|funded&project=<project_id>
router.get('/', async (req, res) => {
  try {
    const limit  = Math.min(Number(req.query.limit) || 25, MAX_LIMIT)
    const offset = Math.max(Number(req.query.offset) || 0, 0)

    const { data, error, count } = await applyFilters(
      supabase.from('ledger_entries').select(SELECT, { count: 'exact' }),
      req.query,
    )
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1)

    if (error) throw error

    const rows = data || []
    const trees = await treesByHash(rows)
    res.json({ data: rows.map(r => toEntry(r, trees)), count: count ?? rows.length })
  } catch (err) {
    console.error('[GET /api/ledger]', err)
    res.status(500).json({ error: 'Failed to fetch ledger entries' })
  }
})

// GET /api/ledger/summary — totals for the same filters as GET /
// Pages past PostgREST's 1000-row cap so totals stay right as the ledger grows.
router.get('/summary', async (req, res) => {
  try {
    const PAGE = 1000
    const sum = { treesFunded: 0, treesPlanted: 0, tCO2eVerified: 0, tCO2eEstimated: 0 }

    for (let from = 0; ; from += PAGE) {
      const { data, error } = await applyFilters(
        supabase.from('ledger_entries').select('funder, trees, t_co2e, trees_verified, co2e_verified'),
        req.query,
      )
        .order('id')
        .range(from, from + PAGE - 1)

      if (error) throw error

      for (const r of data || []) {
        if (DELIVERY_FUNDERS.includes(r.funder)) {
          sum.treesPlanted  += Number(r.trees_verified ?? r.trees) || 0
          sum.tCO2eVerified += Number(r.co2e_verified ?? r.t_co2e) || 0
        } else {
          sum.treesFunded    += Number(r.trees) || 0
          sum.tCO2eEstimated += Number(r.t_co2e) || 0
        }
      }
      if (!data || data.length < PAGE) break
    }

    sum.tCO2eVerified  = Number(sum.tCO2eVerified.toFixed(2))
    sum.tCO2eEstimated = Number(sum.tCO2eEstimated.toFixed(2))
    res.json(sum)
  } catch (err) {
    console.error('[GET /api/ledger/summary]', err)
    res.status(500).json({ error: 'Failed to fetch ledger summary' })
  }
})

// GET /api/ledger/projects — distinct projects with at least one public entry
router.get('/projects', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('ledger_entries')
      .select('project_id, project')
      .is('superseded_by', null)
      .not('project_id', 'is', null)
      .limit(10000)

    if (error) throw error

    const byId = new Map()
    for (const r of data || []) if (!byId.has(r.project_id)) byId.set(r.project_id, r.project)
    const projects = [...byId].map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name))

    res.json({ data: projects })
  } catch (err) {
    console.error('[GET /api/ledger/projects]', err)
    res.status(500).json({ error: 'Failed to fetch ledger projects' })
  }
})

function csvCell(v) {
  const s = v == null ? '' : String(v)
  // Quote everything; neutralise spreadsheet formula injection from user-supplied names
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s
  return `"${safe.replace(/"/g, '""')}"`
}

// GET /api/ledger/export.csv — same filters as GET /, capped at EXPORT_CAP rows
router.get('/export.csv', async (req, res) => {
  try {
    const { data, error } = await applyFilters(
      supabase.from('ledger_entries').select(SELECT),
      req.query,
    )
      .order('created_at', { ascending: false })
      .range(0, EXPORT_CAP - 1)

    if (error) throw error

    const rows = data || []
    const trees = await treesByHash(rows)
    const header = [
      'Entry ID', 'Date', 'Type', 'Project', 'Location', 'Funder', 'Trees', 'tCO2e', 'tCO2e basis',
      'Status', 'Verified on', 'Species', 'Scientific name', 'Tree tag', 'Latitude', 'Longitude',
    ]
    const lines = rows.map(r => {
      const e = toEntry(r, trees)
      const t = e.tree || {}
      return [
        e.id, e.date, e.type === 'planted' ? 'Planted' : 'Funded', e.project, e.projectLocation, e.funderLabel,
        e.trees, e.tCO2e, e.estimated ? 'Estimated' : 'Verified',
        e.verified ? 'Verified' : 'Recorded', (e.verifiedAt || '').slice(0, 10),
        t.species, t.scientificName, t.code, t.lat, t.lng,
      ].map(csvCell).join(',')
    })

    const stamp = new Date().toISOString().slice(0, 10)
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="five-elements-ledger-${stamp}.csv"`)
    // BOM so Excel opens UTF-8 (tCO₂e, Gujarati names) correctly
    res.send('﻿' + [header.map(csvCell).join(','), ...lines].join('\r\n'))
  } catch (err) {
    console.error('[GET /api/ledger/export.csv]', err)
    res.status(500).json({ error: 'Failed to export ledger' })
  }
})

module.exports = router
