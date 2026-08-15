/**
 * One-time script to create a test user in Supabase Auth.
 * Run: node create-user.js <service_role_key>
 *
 * Get the service_role key from:
 * https://supabase.com/dashboard/project/iauhmhkmreojmfahvxxh/settings/api
 */
require('dotenv').config()
const { createClient } = require('@supabase/supabase-js')

const SUPABASE_URL = 'https://iauhmhkmreojmfahvxxh.supabase.co'
const SERVICE_KEY  = process.argv[2] || process.env.SUPABASE_SERVICE_KEY

if (!SERVICE_KEY) {
  console.error('Usage: node create-user.js <service_role_key>')
  console.error('Or set SUPABASE_SERVICE_KEY in backend/.env')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
})

async function main() {
  console.log('Creating test user...')

  const { data, error } = await supabase.auth.admin.createUser({
    email:            'test@fiveelements.com',
    password:         'Test@1234',
    email_confirm:    true,
    user_metadata:    { display_name: 'Test User' },
  })

  if (error) {
    console.error('Error:', error.message)
    process.exit(1)
  }

  console.log('✅ User created:', data.user.id, data.user.email)

  // Also insert a profile row
  const supabaseAnon = createClient(SUPABASE_URL, process.env.SUPABASE_ANON_KEY || '')
  const { error: profileErr } = await supabaseAnon
    .from('profiles')
    .upsert({
      id:           data.user.id,
      name:         'Test User',
      display_name: 'Test User',
      role:         'individual',
      type:         'Individual',
      location:     'India',
      avatar:       'TU',
      is_first_login: false,
    })

  if (profileErr) {
    console.warn('Profile insert warning:', profileErr.message)
  } else {
    console.log('✅ Profile row created')
  }

  console.log('\nLogin credentials:')
  console.log('  Email:    test@fiveelements.com')
  console.log('  Password: Test@1234')
}

main()