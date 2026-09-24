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

async function recordFunding({
  project,
  trees,
  funderName = 'Anonymous',
  publicAttribution = true,
  userId = null,
  fundedAt = null,
  verificationStatus = 'pending',
  amountPaid = null,
}) {
  const tCO2ePerTree = project.tco2e && project.total_trees > 0
    ? Number(project.tco2e) / project.total_trees
    : 0.017   // default estimate, matching fund.js
  const tCO2e = Number((trees * tCO2ePerTree).toFixed(4))

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

  // Atomic SQL increment where the RPC exists; a non-atomic fallback otherwise.
  const { error: updateErr } = await supabase.rpc('increment_project_funding', {
    p_project_id:  project.id,
    p_trees_delta: trees,
  })
  if (updateErr) {
    console.warn('[recordFunding] RPC increment_project_funding not found, falling back:', updateErr.message)
    await supabase
      .from('projects')
      .update({
        funded_trees:  (project.funded_trees || 0) + trees,
        funders_count: (project.funders_count || 0) + 1,
        updated_at:    new Date().toISOString(),
      })
      .eq('id', project.id)
  }

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
        funder_name:        publicAttribution ? funderName : 'Anonymous',
      })
      .select('id')
      .single()

    if (fundingErr) {
      console.error('[recordFunding] individual_fundings insert error:', fundingErr.message)
    } else {
      fundingRowId = fundingRow.id
    }
  }

  return { orderId, tCO2e, fundingRowId }
}

module.exports = { recordFunding }
