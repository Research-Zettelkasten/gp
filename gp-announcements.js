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
    let pushReady = false;
    const pushChoice = byId('gpAnnouncementPushChoice');
    const pushConfig = admin ? window.GP_PUSH.readConfig(client).then(config => {
      pushReady = config?.configured === true;
      pushChoice.hidden = !pushReady;
      byId('gpAnnouncementPushSetup').hidden = pushReady;
    }) : null;
    const table = () => client.from('gp_announcements');
    const sort = query => query.order('pinned',{ascending:false}).order('published_at',{ascending:false}).order('id');
    function setStatus(text) { status.textContent = text; }
    function reset() {
      form.reset();
      editingId = null;
      pushChoice.hidden = !pushReady;
      byId('gpAnnouncementSave').textContent = 'Publish announcement';
    }
    async function notify(id) {
      setStatus('Sending announcement notifications…');
      try {
        const result = await window.GP_PUSH.send(client, id);
        const incomplete = result.retry + result.queued + result.sending;
        if (!result.accepted && !result.unavailable && !incomplete) return 'No opted-in devices found.';
        const counts = [`${result.accepted} accepted by push services`];
        if (result.unavailable) counts.push(`${result.unavailable} unavailable`);
        if (incomplete) counts.push(`${incomplete} pending. Use Notify devices again in five minutes.`);
        return counts.join(' · ');
      } catch (error) {
        return (error.message || 'Push could not be confirmed.') + ' Use Notify devices to retry.';
      }
    }
    const requested = new URLSearchParams(location.search).get('announcement');
    let notificationOpened = false;
    function render(rows) {
      host.replaceChildren();
      if (!rows.length) host.textContent = 'No announcements.';
      for (const row of rows) {
        const entry = document.createElement('article');
        entry.className = 'gp-announcement-entry';
        if (row.id === requested) entry.id = 'gpRequestedAnnouncement';
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
            pushChoice.hidden = true;
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
          if (pushReady && Date.parse(row.published_at) <= Date.now() &&
              (!row.expires_at || Date.parse(row.expires_at) > Date.now())) {
            const push = document.createElement('button');
            push.textContent = 'Notify devices';
            push.onclick = async () => {
              if (writing) return;
              writing = true;
              push.disabled = true;
              try { setStatus(await notify(row.id)); }
              finally { writing = false; push.disabled = false; }
            };
            actions.append(push);
          }
          entry.append(actions);
        }
        host.append(entry);
      }
      if (!admin && requested && !notificationOpened) {
        notificationOpened = true;
        (byId('gpRequestedAnnouncement') || byId('gpHomeAnnouncements'))?.scrollIntoView();
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
          await pushConfig;
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
        const sendPush = !editingId && pushReady && form.elements.notify.checked;
        writing = true;
        const submit = byId('gpAnnouncementSave');
        submit.disabled = true;
        try {
          const write = editingId ? table().update(values).eq('id',editingId).is('archived_at',null) : table().insert(values);
          const response = await write.select('id').single();
          if (response.error) throw response.error;
          reset();
          await refreshAfterWrite();
          setStatus(sendPush ? 'Announcement published. ' + await notify(response.data.id) : 'Announcement saved.');
        } catch(error) { setStatus('Could not save announcement. ' + error.message); }
        finally { writing = false; submit.disabled = false; }
      };
    }
    return load;
  }
  window.GP_ANNOUNCEMENTS = {mount};
})();
