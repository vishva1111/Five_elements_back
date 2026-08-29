/**
 * Creates tree_records table using Supabase Management API
 * Requires a Supabase Personal Access Token (PAT)
 * Get it from: https://supabase.com/dashboard/account/tokens
 */
const https = require('https');
const { createClient } = require('@supabase/supabase-js');

const PROJECT_REF = 'iauhmhkmreojmfahvxxh';
const SERVICE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlhdWhtaGttcmVvam1mYWh2eHhoIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4NjM0ODE4NywiZXhwIjoyMTAxOTI0MTg3fQ.mInD4p-f8Jgvm6xIETgjVLjUngSjisCsPbi2Oej9S5Q';
const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlhdWhtaGttcmVvam1mYWh2eHhoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYzNDgxODcsImV4cCI6MjEwMTkyNDE4N30.RKrSMG4vYHj4Hdm-27N6JStcr7seCROTvx7FNzY3jF4';

// Get PAT from command line: node create-table-mgmt.js YOUR_PAT_HERE
const PAT = process.argv[2];

const CREATE_SQL = `
CREATE TABLE IF NOT EXISTS tree_records (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  project_id TEXT,
  photo_url TEXT NOT NULL DEFAULT '',
  latitude FLOAT8 NOT NULL,
  longitude FLOAT8 NOT NULL,
  species TEXT NOT NULL,
  health_status TEXT DEFAULT 'unknown',
  notes TEXT,
  submitted_at TIMESTAMPTZ DEFAULT NOW(),
  synced BOOLEAN DEFAULT true
);
ALTER TABLE tree_records ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='tree_records' AND policyname='allow_all') THEN
    CREATE POLICY allow_all ON tree_records FOR ALL USING (true) WITH CHECK (true);
  END IF;
END $$;
`;

function runSQLViaMgmtAPI(pat, sql) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ query: sql });
    const options = {
      hostname: 'api.supabase.com',
      path: `/v1/projects/${PROJECT_REF}/database/query`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${pat}`,
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function insertSampleData(userId) {
  const supabase = createClient(`https://${PROJECT_REF}.supabase.co`, SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  const trees = [
    {
      user_id: userId, project_id: 'ahmedabad-urban-canopy',
      photo_url: 'https://images.unsplash.com/photo-1542601906990-b4d3fb778b09?w=600&q=80',
      latitude: 23.0225, longitude: 72.5714, species: 'Neem', health_status: 'healthy',
      notes: 'Strong healthy neem near road, good canopy',
      submitted_at: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(), synced: true
    },
    {
      user_id: userId, project_id: 'ahmedabad-urban-canopy',
      photo_url: 'https://images.unsplash.com/photo-1518531933037-91b2f5f229cc?w=600&q=80',
      latitude: 23.0235, longitude: 72.5724, species: 'Peepal', health_status: 'healthy',
      notes: 'Large peepal, excellent canopy coverage',
      submitted_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), synced: true
    },
    {
      user_id: userId, project_id: 'ahmedabad-urban-canopy',
      photo_url: 'https://images.unsplash.com/photo-1448375240586-882707db888b?w=600&q=80',
      latitude: 23.0215, longitude: 72.5704, species: 'Banyan (Vad)', health_status: 'sick',
      notes: 'Leaves yellowing, needs treatment',
      submitted_at: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(), synced: true
    },
    {
      user_id: userId, project_id: 'ahmedabad-urban-canopy',
      photo_url: 'https://images.unsplash.com/photo-1502082553048-f009c37129b9?w=600&q=80',
      latitude: 23.0245, longitude: 72.5734, species: 'Mango (Keri)', health_status: 'healthy',
      notes: 'Young mango tree, well watered and growing',
      submitted_at: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(), synced: true
    },
    {
      user_id: userId, project_id: 'ahmedabad-urban-canopy',
      photo_url: 'https://images.unsplash.com/photo-1441974231531-c6227db76b6e?w=600&q=80',
      latitude: 23.0255, longitude: 72.5744, species: 'Gulmohar', health_status: 'dead',
      notes: 'Completely dried up, no leaves remaining',
      submitted_at: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(), synced: true
    },
  ];

  const { data, error } = await supabase.from('tree_records').insert(trees).select();
  if (error) {
    console.error('Insert error:', error.message);
    return false;
  }
  console.log(`Inserted ${data.length} tree records:`);
  data.forEach((t, i) => console.log(`  ${i+1}. ${t.species} (${t.health_status})`));
  return true;
}

async function main() {
  if (!PAT) {
    console.log('=== HOW TO GET YOUR PERSONAL ACCESS TOKEN ===');
    console.log('1. Go to: https://supabase.com/dashboard/account/tokens');
    console.log('2. Click "Generate new token"');
    console.log('3. Name it "tree-setup" and copy the token');
    console.log('4. Run: node create-table-mgmt.js YOUR_TOKEN_HERE');
    console.log('');
    console.log('OR manually run this SQL in Supabase Dashboard:');
    console.log('https://supabase.com/dashboard/project/' + PROJECT_REF + '/sql/new');
    console.log('');
    console.log(CREATE_SQL);
    return;
  }

  console.log('Creating tree_records table via Management API...');
  const result = await runSQLViaMgmtAPI(PAT, CREATE_SQL);
  console.log('Response:', result.status, result.body.substring(0, 300));

  if (result.status === 200 || result.status === 201 || result.status === 204) {
    console.log('\nTable created successfully!');
    
    // Get user ID and insert data
    const anonClient = createClient(`https://${PROJECT_REF}.supabase.co`, ANON_KEY, {
      auth: { autoRefreshToken: false, persistSession: false }
    });
    const { data: signIn, error: signInErr } = await anonClient.auth.signInWithPassword({
      email: 'field@test.com', password: 'Field@1234'
    });
    if (signInErr) { console.error('Sign in error:', signInErr.message); return; }
    
    console.log('\nInserting sample data...');
    await insertSampleData(signIn.user.id);
    console.log('\nDone! Go to /admin/tree-records in the web dashboard.');
  } else {
    console.log('\nFailed. Please run the SQL manually in Supabase Dashboard.');
  }
}

main().catch(console.error);