document.addEventListener('DOMContentLoaded', () => {
  const message = document.querySelector('[role=status]');
  if (!window.supabase) {
    GP_WORKSPACE.status(message, 'Could not load the quote. Try refreshing this page.', true);
    return;
  }
  const client = window.supabase.createClient(
    'https://ohddwksazinynqlynycm.supabase.co',
    'sb_publishable_9x19th40YQMjftz2HgbH5Q_rDS4Fw2j',
    { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }
  );
  void GP_QUOTE_LINKS.customer(client, location.hash.slice(1));
});
