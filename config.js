// Default config. Replace with your real Supabase details and credentials.
window.APP_CONFIG = {
  auth: {
    users: [
      { username: 'admin', password: 'admin123' },
      { username: 'nouman', password: 'dawiyat' }
    ]
  },
  supabase: {
    // Provided in ticket (replace with your actual values)
    url: 'https://kbzlougjxfulfofhxqcr.supabase.co',
    anonKey: '', // Insert your full anon public key here
    bucket: "noumanbhatti1991-lgtm" // Replace with your actual public bucket name
  },
  indexFile: 'index.json',
  listFile: 'pdfs.json'
};
