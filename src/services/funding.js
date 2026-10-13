/**
 * funding.js — the one place a funding event is written to the database.
 *
 * Extracted out of fund.js so the online checkout and the partner's offline
 * donation import move the ledger and the project counters the same way —
 * two copies of this logic drifting apart is exactly the kind of bug that
 * keeps turning up elsewhere in this codebase.
 *
 * fund.js's exact prior behaviour is preserved: called with no amountPaid, it
 * computes trees * price_per_tree * 1.1 (a 10% platform fee), same as before.
 * The donor-import path always passes an explicit amountPaid (the receipt's
 * real figure, or trees * price_per_tree with no markup) — a fee was never
 * actually charged on money already collected on paper.
 */
const supabase = require('../supabaseClient')
const { syncProjectStats } = require('./projectStats')
const { isMissingSchema } = require('./businessOrg')

// Estimated CO₂ a funded tree will absorb — same default fund.js has always used.
// (projects.tco2e now holds verified CO₂ only, so it can't be the basis for this.)
const FUNDED_TCO2E_PER_TREE = 0.017

// individual_fundings.funded_as ('individual' | 'business') arrives with
// backend/sql/business_funding.sql. Until that's run every row is personal and
// both panels keep reading all of an account's rows, exactly as before.
let fundedAsReady = false
async function fundedAsAvailable() {
  if (fundedAsReady) return true
  const { error } = await supabase.from('individual_fundings').select('funded_as').limit(1)
  if (!error) fundedAsReady = true
  // Only a missing column means "not yet" — a passing network error doesn't.
  return fundedAsReady || !isMissingSchema(error)
}

/**
 * A filter narrowing an individual_fundings query to one side of an account:
 * its own personal funding ('individual') or its organisation's ('business').
 * Returns a function rather than the query — a query builder is thenable, so
 * handing it back from an async function would run it.
 *
 *   const scope = await fundingScope('business')
 *   const { data } = await scope(supabase.from('individual_fundings').select(...))
 */
async function fundingScope(as) {
  if (!(await fundedAsAvailable())) return q => q
  return as === 'business'
    ? q => q.eq('funded_as', 'business')
    : q => q.neq('funded_as', 'business')
}

async function recordFunding({
  project,
  trees,
  funderName = 'Anonymous',
  publicAttribution = true,
  userId = null,
  fundedAt = null,
  verificationStatus = 'pending',
  amountPaid = null,
  fundedAs = 'individual',
}) {
  const tCO2e = Number((trees * FUNDED_TCO2E_PER_TREE).toFixed(4))

  const orderId = `ORD-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`
  const at = fundedAt ? new Date(fundedAt) : new Date()
  const dateOnly = at.toISOString().split('T')[0]

  const { error: insertErr } = await supabase
    .from('ledger_entries')
    .insert({
      id: orderId,
      date: dateOnly,
      project_id: project.id,
      project: project.name,
      funder: publicAttribution ? funderName : 'Anonymous',
      trees,
      t_co2e: tCO2e,
      verified: false,
      tx_hash: null,
    })

  if (insertErr) throw new Error(`Failed to record funding: ${insertErr.message}`)

  let fundingRowId = null
  if (userId) {
    const finalAmount = amountPaid != null
      ? Math.round(amountPaid)
      : Math.round(trees * (project.price_per_tree || 100) * 1.1)   // fund.js's original default

    const { data: fundingRow, error: fundingErr } = await supabase
      .from('individual_fundings')
      .insert({
        user_id:            userId,
        project_id:         project.id,
        trees_funded:       trees,
        amount_paid:        finalAmount,
        funded_at:          at.toISOString(),
        verification_status: verificationStatus,
        has_ledger_entry:   true,
        ledger_entry_id:    null,   // ledger entry id is a text field, not uuid — skip FK
        public_attribution: publicAttribution,
        // The real name is always kept here so the partner and admin can see
        // who funded; public_attribution decides what public surfaces show.
        funder_name:        funderName,
        // Personal rows rely on the column default, so they still insert
        // before business_funding.sql has been run.
        ...(fundedAs === 'business' ? { funded_as: 'business' } : {}),
      })
      .select('id')
      .single()

    if (fundingErr) {
      console.error('[recordFunding] individual_fundings insert error:', fundingErr.message)
    } else {
      fundingRowId = fundingRow.id
    }
  }

  // funded_trees / funders_count come from individual_fundings — refresh them.
  await syncProjectStats([project.id])

  return { orderId, tCO2e, fundingRowId }
}

module.exports = { recordFunding, fundingScope, fundedAsAvailable }
