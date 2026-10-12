/**
 * businessOrg.js — small helpers shared by the Business panel routes
 * (team, reports, org settings), which are all scoped to the signed-in
 * business account (owner_id = req.userId).
 */
const supabase = require('../supabaseClient')

const SCHEMA_HELP = 'Database update needed — run backend/sql/business_org_scoping.sql in the Supabase SQL editor.'

/** True when a query failed because business_org_scoping.sql hasn't been run yet. */
function isMissingSchema(error) {
  if (!error) return false
  return ['42703', '42P01', 'PGRST204', 'PGRST205'].includes(error.code)
    || /owner_id|business_orgs/.test(error.message || '') && /does not exist|Could not find/i.test(error.message || '')
}

/** Sends the standard "run the migration" answer if that's what went wrong. */
function replyIfMissingSchema(res, error) {
  if (!isMissingSchema(error)) return false
  res.status(503).json({ error: SCHEMA_HELP })
  return true
}

/** The organisation's display name: its saved org name, else the account's name. */
async function getOrgName(userId) {
  const [{ data: org }, { data: profile }] = await Promise.all([
    supabase.from('business_orgs').select('org_name').eq('owner_id', userId).maybeSingle(),
    supabase.from('profiles').select('display_name').eq('auth_id', userId).maybeSingle(),
  ])
  return org?.org_name || profile?.display_name || 'Your organisation'
}

module.exports = { SCHEMA_HELP, isMissingSchema, replyIfMissingSchema, getOrgName }
