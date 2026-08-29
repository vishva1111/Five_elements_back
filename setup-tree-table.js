const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = 'https://iauhmhkmreojmfahvxxh.supabase.co';
const SERVICE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlhdWhtaGttcmVvam1mYWh2eHhoIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4NjM0ODE4NywiZXhwIjoyMTAxOTI0MTg3fQ.mInD4p-f8Jgvm6xIETgjVLjUngSjisCsPbi2Oej9S5Q';
const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlhdWhtaGttcmVvam1mYWh2eHhoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYzNDgxODcsImV4cCI6MjEwMTkyNDE4N30.RKrSMG4vYHj4Hdm-27N6JStcr7seCROTvx7FNzY3jF4';

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});

async function main() {
  // Step 1: Sign in as field@test.com to get user ID
  console.log('Step 1: Signing in as field@test.com to get user ID...');
  const anonClient = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });
  
  const { data: signInData, error: signInErr } = await anonClient.auth.signInWithPassword({
    email: 'field@test.com',
    password: 'Field@1234'
  });
  
  if (signInErr) {
    console.error('Sign in error:', signInErr.message);
    return;
  }
  
  const userId = signInData.user.id;
  console.log('User ID:', userId);

  // Step 2: Insert sample tree records
  console.log('\nStep 2: Inserting 5 sample tree records for Ahmedabad Urban Canopy...');
  
  const trees = [
    {
      user_id: userId,
      project_id: 'ahmedabad-urban-canopy',
      photo_url: 'https://images.unsplash.com/photo-1542601906990-b4d3fb778b09?w=400',
      latitude: 23.0225,
      longitude: 72.5714,
      species: 'Neem',
      health_status: 'healthy',
      notes: 'Strong healthy neem near road',
      submitted_at: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(),
      synced: true
    },
    {
      user_id: userId,
      project_id: 'ahmedabad-urban-canopy',
      photo_url: 'https://images.unsplash.com/photo-1518531933037-91b2f5f229cc?w=400',
      latitude: 23.0235,
      longitude: 72.5724,
      species: 'Peepal',
      health_status: 'healthy',
      notes: 'Large peepal, good canopy coverage',
      submitted_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      synced: true
    },
    {
      user_id: userId,
      project_id: 'ahmedabad-urban-canopy',
      photo_url: 'https://images.unsplash.com/photo-1448375240586-882707db888b?w=400',
      latitude: 23.0215,
      longitude: 72.5704,
      species: 'Banyan (Vad)',
      health_status: 'sick',
      notes: 'Leaves yellowing, needs attention',
      submitted_at: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
      synced: true
    },
    {
      user_id: userId,
      project_id: 'ahmedabad-urban-canopy',
      photo_url: 'https://images.unsplash.com/photo-1502082553048-f009c37129b9?w=400',
      latitude: 23.0245,
      longitude: 72.5734,
      species: 'Mango (Keri)',
      health_status: 'healthy',
      notes: 'Young mango tree, well watered',
      submitted_at: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(),
      synced: true
    },
    {
      user_id: userId,
      project_id: 'ahmedabad-urban-canopy',
      photo_url: 'https://images.unsplash.com/photo-1441974231531-c6227db76b6e?w=400',
      latitude: 23.0255,
      longitude: 72.5744,
      species: 'Gulmohar',
      health_status: 'dead',
      notes: 'Dried up, no leaves remaining',
      submitted_at: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(),
      synced: true
    },
  ];

  const { data, error } = await supabase.from('tree_records').insert(trees).select();
  
  if (error) {
    console.error('\nInsert error:', error.message);
    if (error.message.includes('tree_records')) {
      console.log('\n=== tree_records TABLE DOES NOT EXIST ===');
      console.log('Please run this SQL in Supabase Dashboard > SQL Editor:');
      console.log('URL: https://supabase.com/dashboard/project/iauhmhkmreojmfahvxxh/sql/new');
      console.log('\n--- COPY THIS SQL ---');
      console.log(`
CREATE TABLE tree_records (
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

CREATE POLICY "allow_all" ON tree_records FOR ALL USING (true) WITH CHECK (true);
      `);
      console.log('--- END SQL ---');
      console.log('\nAfter running SQL, run: node setup-tree-table.js');
    }
  } else {
    console.log('\nSUCCESS! Inserted', data.length, 'tree records!');
    data.forEach((t, i) => {
      console.log(`  ${i+1}. ${t.species} (${t.health_status}) at ${t.latitude},${t.longitude}`);
    });
    console.log('\nApp ma login karo ane History tab ma data dikhe!');
  }
}

main().catch(console.error);