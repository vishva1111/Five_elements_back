const PAT_TOKEN = process.env.SUPABASE_PAT_TOKEN;
const PROJECT_ID = process.env.SUPABASE_PROJECT_ID || 'iauhmhkmreojmfahvxxh';

async function fixStoragePolicy() {
  const sql = `
    -- Drop existing policies for tree-photos bucket if any
    DROP POLICY IF EXISTS "tree_photos_insert" ON storage.objects;
    DROP POLICY IF EXISTS "tree_photos_select" ON storage.objects;
    DROP POLICY IF EXISTS "tree_photos_update" ON storage.objects;
    DROP POLICY IF EXISTS "tree_photos_delete" ON storage.objects;

    -- Allow authenticated users to upload to tree-photos bucket
    CREATE POLICY "tree_photos_insert"
    ON storage.objects FOR INSERT
    TO authenticated
    WITH CHECK (bucket_id = 'tree-photos');

    -- Allow public to read from tree-photos bucket (bucket is public)
    CREATE POLICY "tree_photos_select"
    ON storage.objects FOR SELECT
    TO public
    USING (bucket_id = 'tree-photos');

    -- Allow owner to update their own files
    CREATE POLICY "tree_photos_update"
    ON storage.objects FOR UPDATE
    TO authenticated
    USING (bucket_id = 'tree-photos' AND auth.uid()::text = (storage.foldername(name))[1]);

    -- Allow owner to delete their own files
    CREATE POLICY "tree_photos_delete"
    ON storage.objects FOR DELETE
    TO authenticated
    USING (bucket_id = 'tree-photos' AND auth.uid()::text = (storage.foldername(name))[1]);
  `;

  const response = await fetch(
    `https://api.supabase.com/v1/projects/${PROJECT_ID}/database/query`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${PAT_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: sql }),
    }
  );

  const result = await response.json();
  console.log('Status:', response.status);
  console.log('Result:', JSON.stringify(result, null, 2));

  if (response.ok) {
    console.log('Storage RLS policies added successfully!');
  } else {
    console.error('Failed:', result);
  }
}

fixStoragePolicy().catch(console.error);