// Copy this file to config.js and fill in your details
window.APP_CONFIG = {
  auth: {
    // Simple username/password list (for demo only). Replace with your own.
    users: [
      { username: 'admin', password: 'admin123' },
      { username: 'nouman', password: 'dawiyat' }
    ]
  },
  supabase: {
    url: 'https://YOUR-PROJECT-REF.supabase.co',
    anonKey: 'YOUR-ANON-KEY',
    bucket: 'your-public-bucket' // must be a public bucket
  },
  // Optional: if you maintain a prebuilt search index JSON in the bucket root
  // e.g., index.json -> { "D0309420201": [{"file":"map1.pdf","page":2,"rect":[x,y,w,h]}], ... }
  indexFile: 'index.json',
  // Optional fallback manifest listing PDFs if storage list is not available
  listFile: 'pdfs.json'
};
