/**
 * evidenceUrls.js — turn evidence_files.storage_path into a usable link.
 *
 * evidence_files has no file_url column; several routes used to select one and
 * failed the whole query with "column evidence_files_1.file_url does not exist".
 * The `evidence` bucket is private, so a signed URL is issued on read instead of
 * storing a public one.
 *
 * Some seeded rows carry the bucket name inside the path ("evidence/foo/bar")
 * while uploads write it without ("submissions/<id>/bar"), so the prefix is
 * stripped before signing.
 */
const supabase = require('../supabaseClient')

const BUCKET = 'evidence'
const SIGNED_URL_TTL_SECONDS = 60 * 60   // one hour

function normalisePath(storagePath) {
  if (!storagePath) return null
  return String(storagePath).replace(/^\/+/, '').replace(new RegExp(`^${BUCKET}/`), '')
}

/** Signed URL for one stored file, or null if it cannot be signed. */
async function signEvidencePath(storagePath) {
  const path = normalisePath(storagePath)
  if (!path) return null
  try {
    const { data, error } = await supabase.storage
      .from(BUCKET)
      .createSignedUrl(path, SIGNED_URL_TTL_SECONDS)
    if (error) return null
    return data?.signedUrl || null
  } catch {
    return null
  }
}

// A signed link is good for an hour, so one signed a few minutes ago can be
// handed out again instead of asking storage to sign it a second time.
const REUSE_MS = 25 * 60 * 1000
const signedCache = new Map()   // storage path → { url, at }

/**
 * Attach `file_url` to each evidence row, so callers keep the shape the
 * frontend already expects. All new links are signed in ONE storage call
 * (not one per file); never throws.
 */
async function withSignedUrls(files) {
  if (!Array.isArray(files) || files.length === 0) return []
  const now = Date.now()
  const urls = new Map()
  const todo = []
  for (const f of files) {
    const path = normalisePath(f.storage_path)
    if (!path || urls.has(path)) continue
    const hit = signedCache.get(path)
    if (hit && now - hit.at < REUSE_MS) urls.set(path, hit.url)
    else { urls.set(path, null); todo.push(path) }
  }
  if (todo.length > 0) {
    try {
      const { data, error } = await supabase.storage.from(BUCKET).createSignedUrls(todo, SIGNED_URL_TTL_SECONDS)
      if (!error) {
        for (const row of data || []) {
          if (row.path && row.signedUrl) { urls.set(row.path, row.signedUrl); signedCache.set(row.path, { url: row.signedUrl, at: now }) }
        }
      }
    } catch { /* leave them unsigned, same as before */ }
  }
  return files.map(f => ({ ...f, file_url: urls.get(normalisePath(f.storage_path)) || null }))
}

module.exports = { signEvidencePath, withSignedUrls, BUCKET }
