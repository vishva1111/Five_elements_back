const { createClient } = require('@supabase/supabase-js')

const supabaseUrl = process.env.SUPABASE_URL
// Use service role key if available, otherwise fall back to anon key.
// If service role key is a placeholder, skip it and use anon key.
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
const isPlaceholder = !serviceKey || serviceKey.startsWith('PASTE_') || serviceKey.length < 100
const supabaseKey = isPlaceholder ? process.env.SUPABASE_ANON_KEY : serviceKey

if (isPlaceholder) {
  console.warn('[supabaseClient] Service role key not set — using anon key. RLS policies will apply.')
}

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    autoRefreshToken: false,
    persistSession:   false,
  },
})

module.exports = supabase