/**
 * projectStats.js — keeps the summary columns on `projects` true to the records.
 *
 * Every screen (marketplace, project page, partner dashboard, admin, business
 * portfolio…) reads funded_trees / funders_count / tco2e / evidence_count /
 * last_evidence_date straight off `projects`. Those columns are never edited by
 * hand: they are recomputed from the records they summarise whenever one of
 * those records changes, so they can't drift.
 *
 *   funded_trees       = Σ individual_fundings.trees_funded
 *   funded_amount      = Σ individual_fundings.amount_paid       (₹, incl. platform fee)
 *   funders_count      = distinct funders in individual_fundings
 *   tco2e              = Σ ledger_entries.co2e_verified        (verified CO₂ only)
 *   evidence_count     = ledger entries that verified trees    (approved captures)
 *   last_evidence_date = latest of those approvals
 *
 * Ledger rows that have been superseded by a correction are left out.
 *
 * Platform-wide totals (platform_stats) are derived from the projects the same
 * way — see getPlatformStats().
 */
const supabase = require('../supabaseClient')

const PAGE = 1000

/** Reads every row of a query in pages — PostgREST returns at most 1000 at a time. */
async function readAll(build) {
  const out = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build().range(from, from + PAGE - 1)
    if (error) throw error
    out.push(...(data || []))
    if (!data || data.length < PAGE) return out
  }
}

function formatEvidenceDate(iso) {
  // Same display format the column has always held, e.g. "10 Jul 2026".
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

/** Computes the live figures for the given projects (does not write). */
async function computeProjectStats(projectIds) {
  const ids = [...new Set((projectIds || []).filter(Boolean))]
  const stats = Object.fromEntries(ids.map(id => [id, {
    funded_trees: 0, funded_amount: 0, funders_count: 0, tco2e: 0, evidence_count: 0, last_evidence_date: null,
  }]))
  if (ids.length === 0) return stats

  const [fundings, ledger] = await Promise.all([
    readAll(() => supabase.from('individual_fundings').select('project_id, user_id, funder_name, trees_funded, amount_paid').in('project_id', ids)),
    readAll(() => supabase.from('ledger_entries').select('project_id, trees_verified, co2e_verified, approved_at, date, superseded_by').in('project_id', ids)),
  ])

  const funders = {}
  for (const f of fundings) {
    const s = stats[f.project_id]
    if (!s) continue
    s.funded_trees  += Number(f.trees_funded) || 0
    s.funded_amount += Number(f.amount_paid) || 0
    ;(funders[f.project_id] ||= new Set()).add(f.user_id || `name:${(f.funder_name || '').toLowerCase()}`)
  }
  for (const [pid, set] of Object.entries(funders)) stats[pid].funders_count = set.size

  const lastAt = {}
  for (const l of ledger) {
    const s = stats[l.project_id]
    if (!s || l.superseded_by) continue
    s.tco2e += Number(l.co2e_verified) || 0
    if ((Number(l.trees_verified) || 0) > 0) {
      s.evidence_count += 1
      const at = l.approved_at || l.date
      if (at && (!lastAt[l.project_id] || new Date(at) > new Date(lastAt[l.project_id]))) lastAt[l.project_id] = at
    }
  }
  for (const s of Object.values(stats)) s.tco2e = Math.round(s.tco2e * 100) / 100
  for (const [pid, at] of Object.entries(lastAt)) stats[pid].last_evidence_date = formatEvidenceDate(at)

  return stats
}

/**
 * Recomputes and saves the summary columns for the given projects. Never throws
 * — a failed refresh is logged and the caller's own write still stands.
 */
async function syncProjectStats(projectIds) {
  try {
    const stats = await computeProjectStats(projectIds)
    for (const [id, s] of Object.entries(stats)) {
      const { error } = await supabase
        .from('projects')
        .update({ ...s, updated_at: new Date().toISOString() })
        .eq('id', id)
      if (error) console.error(`[projectStats] update failed for ${id}:`, error.message)
    }
    await refreshPlatformStatsRow()
    return stats
  } catch (e) {
    console.error('[projectStats] sync failed:', e.message)
    return null
  }
}

/**
 * Platform-wide totals, computed live from `projects` (whose columns the sync
 * above keeps true). Read this — not the platform_stats row — wherever the
 * totals are shown, so they can never go stale.
 */
async function getPlatformStats() {
  const rows = await readAll(() => supabase.from('projects').select('status, funded_trees, tco2e'))
  return {
    treesFunded:    rows.reduce((s, r) => s + (Number(r.funded_trees) || 0), 0),
    tCO2eVerified:  Math.round(rows.reduce((s, r) => s + (Number(r.tco2e) || 0), 0) * 100) / 100,
    projectsActive: rows.filter(r => r.status === 'active').length,
  }
}

/** Keeps the legacy platform_stats row in step for anything still reading it. */
async function refreshPlatformStatsRow() {
  try {
    const p = await getPlatformStats()
    const { error } = await supabase.from('platform_stats').update({
      trees_funded:    p.treesFunded,
      t_co2e_verified: p.tCO2eVerified,
      projects_active: p.projectsActive,
      updated_at:      new Date().toISOString(),
    }).eq('id', 1)
    if (error) console.error('[projectStats] platform_stats update failed:', error.message)
  } catch (e) {
    console.error('[projectStats] platform_stats refresh failed:', e.message)
  }
}

/** Recomputes every project. */
async function syncAllProjectStats() {
  const projects = await readAll(() => supabase.from('projects').select('id'))
  return syncProjectStats(projects.map(p => p.id))
}

module.exports = { computeProjectStats, syncProjectStats, syncAllProjectStats, getPlatformStats }
