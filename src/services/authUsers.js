/**
 * authUsers.js — the one place that lists Supabase Auth users.
 *
 * supabase-js's admin API has no "get user by email" call — only listUsers()
 * with pagination — so every email/id lookup this backend does (team invite,
 * donor import, task assignee resolution, ...) had its own copy of
 * `listUsers({ perPage: 1000 })`, eleven of them, each a full round trip to
 * Supabase Auth. One shared call, reused per request where a caller already
 * has the result, replaces that duplication without changing what any of them
 * resolve to.
 *
 * Boundary worth knowing: perPage: 1000 returns only the first page. On an
 * account with more than 1000 auth users, a lookup for someone outside that
 * first page won't find them. Changing that is a real behavioural decision
 * (paginating changes timing and, if done wrong, correctness), so it's
 * deliberately left as-is here rather than silently altered — flagged once,
 * in this one place, instead of being an implicit assumption in eleven.
 */
const supabase = require('../supabaseClient')

/**
 * All auth users (first page, up to 1000) — the exact same shape
 * `supabase.auth.admin.listUsers({ perPage: 1000 })` already returned at
 * every call site, so `(await listAllAuthUsers()).users` drops in unchanged.
 */
async function listAllAuthUsers() {
  const { data, error } = await supabase.auth.admin.listUsers({ perPage: 1000 })
  if (error) {
    console.error('[listAllAuthUsers]', error.message)
    return { users: [] }
  }
  return data
}

module.exports = { listAllAuthUsers }
