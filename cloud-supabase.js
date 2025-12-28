// cloud-supabase.js

window.CloudSupabase = (() => {
  if (!window.supabase) {
    console.error('Supabase SDK not loaded');
    return null;
  }

  const client = supabase.createClient(
    window.BM_SUPABASE_URL,
    window.BM_SUPABASE_ANON_KEY,
    {
      auth: {
        persistSession: true,
        autoRefreshToken: true
      }
    }
  );

  return {
    client,

    getUser() {
      return client.auth.getUser();
    },

    async signIn(email, password) {
      return await client.auth.signInWithPassword({ email, password });
    },

    async signUp(email, password) {
      return await client.auth.signUp({ email, password });
    },

    async signOut() {
      return await client.auth.signOut();
    }
  };
})();
