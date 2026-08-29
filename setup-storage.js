const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = 'https://iauhmhkmreojmfahvxxh.supabase.co';
const SERVICE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlhdWhtaGttcmVvam1mYWh2eHhoIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4NjM0ODE4NywiZXhwIjoyMTAxOTI0MTg3fQ.mInD4p-f8Jgvm6xIETgjVLjUngSjisCsPbi2Oej9S5Q';

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});

async function main() {
  console.log('Checking storage buckets...');
  
  const { data: buckets, error } = await supabase.storage.listBuckets();
  if (error) {
    console.error('Error listing buckets:', error.message);
    return;
  }
  
  console.log('Existing buckets:', buckets.map(b => `${b.name} (public:${b.public})`).join(', ') || 'none');
  
  const exists = buckets.find(b => b.name === 'tree-photos');
  
  if (!exists) {
    console.log('\nCreating tree-photos bucket (public)...');
    const { data, error: ce } = await supabase.storage.createBucket('tree-photos', {
      public: true,
      fileSizeLimit: 10485760, // 10MB
      allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp']
    });
    if (ce) {
      console.error('Create bucket error:', ce.message);
    } else {
      console.log('SUCCESS: tree-photos bucket created!');
    }
  } else if (!exists.public) {
    console.log('\nMaking tree-photos bucket public...');
    const { error: ue } = await supabase.storage.updateBucket('tree-photos', { public: true });
    if (ue) {
      console.error('Update bucket error:', ue.message);
    } else {
      console.log('SUCCESS: tree-photos bucket is now public!');
    }
  } else {
    console.log('\ntree-photos bucket already exists and is public. No changes needed.');
  }
  
  // Verify
  const { data: buckets2 } = await supabase.storage.listBuckets();
  const treePhotos = buckets2?.find(b => b.name === 'tree-photos');
  console.log('\nFinal status:', treePhotos ? `tree-photos exists, public: ${treePhotos.public}` : 'NOT FOUND');
}

main().catch(console.error);