(function () {
  'use strict';
  const byId = id => document.getElementById(id);
  const format = value => new Date(value).toLocaleString([], {
    dateStyle:'medium', timeStyle:'short', timeZone:'America/New_York'
  });
  function mount(client, admin = false) {
    const host = byId('gpAnnouncementList');
    if (!host) return null;
    const form = byId('gpAnnouncementForm');
    const status = byId('gpAnnouncementStatus');
    let loading, writing = false, editingId = null;
    const table = () => client.from('gp_announcements');
    const sort = query => query.order('pinned',{ascending:false}).order('published_at',{ascending:false}).order('id');
    function setStatus(text) { status.textContent = text; }
    function reset() { form.reset(); editingId = null; byId('gpAnnouncementSave').textContent = 'Publish announcement'; }
    function render(rows) {
      host.replaceChildren();
      if (!rows.length) host.textContent = 'No announcements.';
      for (const row of rows) {
        const entry = document.createElement('article');
        entry.className = 'gp-announcement-entry';
        const title = document.createElement('h4');
        title.textContent = row.title;
        const meta = document.createElement('div');
        meta.className = 'gp-operations-note';
        meta.textContent = [row.pinned ? 'Pinned' : null, format(row.published_at) + ' ET',
          row.archived_at ? 'Archived' : row.expires_at ? (Date.parse(row.expires_at) <= Date.now() ? 'Expired' : 'Expires ' + format(row.expires_at) + ' ET') : null].filter(Boolean).join(' · ');
        const body = document.createElement('p');
        body.textContent = row.body;
        entry.append(title, meta, body);
        if (admin && !row.archived_at) {
          const edit = document.createElement('button');
          edit.textContent = 'Edit';
          edit.onclick = () => {
            editingId = row.id;
            form.elements.title.value = row.title;
            form.elements.body.value = row.body;
            form.elements.pinned.checked = row.pinned;
            form.elements.expires.value = row.expires_at ? GP_CLOCK.localInput(Date.parse(row.expires_at)) : '';
            byId('gpAnnouncementSave').textContent = 'Save announcement';
            form.elements.title.focus();
          };
          const archive = document.createElement('button');
          archive.textContent = 'Archive';
          archive.onclick = async () => {
            if (writing || !confirm('Archive this announcement for staff?')) return;
            writing = true;
            archive.disabled = true;
            try {
              const response = await table().update({archived_at:new Date().toISOString()}).eq('id',row.id).select('id').single();
              if (response.error) throw response.error;
              if (editingId === row.id) reset();
              await refreshAfterWrite();
              setStatus('Announcement archived.');
            } catch (error) { setStatus(error.message); }
            finally { writing = false; archive.disabled = false; }
          };
          const actions = document.createElement('div');
          actions.className = 'gp-operations-controls';
          actions.append(edit, archive);
          entry.append(actions);
        }
        host.append(entry);
      }
    }
    function load() {
      if (loading) return loading;
      loading = (async () => {
        try {
          let query = table().select('id,title,body,pinned,published_at,expires_at,archived_at');
          if (!admin) {
            const now = new Date().toISOString();
            query = query.is('archived_at',null).lte('published_at',now).or('expires_at.is.null,expires_at.gt.' + now);
          }
          const {data, error} = await sort(query).limit(50);
          if (error) throw error;
          render(data || []);
          setStatus('');
        } catch (error) {
          const missing = ['42P01','PGRST205'].includes(error.code);
          setStatus(missing ? (admin ? 'Install the fleet, callbacks and announcements SQL to publish announcements.' : 'Announcements are not set up yet.') : 'Could not load announcements. Use Refresh to retry.');
        }
      })().finally(() => { loading = null; });
      return loading;
    }
    async function refreshAfterWrite() {
      if (loading) await loading;
      return load();
    }
    if (admin) {
      byId('gpAnnouncementRefresh').onclick = load;
      byId('gpAnnouncementReset').onclick = reset;
      form.onsubmit = async event => {
        event.preventDefault();
        if (writing) return;
        const title = form.elements.title.value.trim(), body = form.elements.body.value.trim();
        const expiry = form.elements.expires.value;
        if (!title || !body) { setStatus('Enter a title and message.'); return; }
        if (expiry && !(new Date(expiry).getTime() > Date.now())) { setStatus('Choose a future expiration.'); return; }
        const values = {title, body, pinned:form.elements.pinned.checked, expires_at:expiry ? new Date(expiry).toISOString() : null};
        writing = true;
        const submit = byId('gpAnnouncementSave');
        submit.disabled = true;
        try {
          const write = editingId ? table().update(values).eq('id',editingId).is('archived_at',null) : table().insert(values);
          const response = await write.select('id').single();
          if (response.error) throw response.error;
          reset();
          await refreshAfterWrite();
          setStatus('Announcement saved.');
        } catch(error) { setStatus('Could not save announcement. ' + error.message); }
        finally { writing = false; submit.disabled = false; }
      };
    }
    return load;
  }
  window.GP_ANNOUNCEMENTS = {mount};
})();
