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

/**
 * Attach `file_url` to each evidence row, so callers keep the shape the
 * frontend already expects. Signing happens in parallel and never throws.
 */
async function withSignedUrls(files) {
  if (!Array.isArray(files) || files.length === 0) return []
  return Promise.all(files.map(async f => ({
    ...f,
    file_url: await signEvidencePath(f.storage_path),
  })))
}

module.exports = { signEvidencePath, withSignedUrls, BUCKET }
