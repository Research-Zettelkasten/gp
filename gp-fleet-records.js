(function (root) {
  'use strict';
  const bucketName = 'gp-fleet-photos';
  const imageTypes = {'image/jpeg':'jpg', 'image/png':'png', 'image/webp':'webp'};
  const statusLabels = {expired:'Expired', soon:'Due in 30 days', upcoming:'Due in 31–60 days', current:'Current', missing:'No date'};
  const field = id => document.getElementById(id);
  function tagStatus(expires, today) {
    if (!expires) return 'missing';
    const days = (Date.parse(expires) - Date.parse(today)) / 86400000;
    if (days < 0) return 'expired';
    if (days <= 30) return 'soon';
    if (days <= 60) return 'upcoming';
    return Number.isFinite(days) ? 'current' : 'missing';
  }
  function tagBadge(asset, today) {
    const status = tagStatus(asset.tag_expires_on, today);
    const color = status === 'expired' ? 'issue' : ['soon','upcoming'].includes(status) ? 'warn' : 'navy';
    return `<span class="badge badge-${color}">${statusLabels[status]}</span>`;
  }
  function mountPhotos(client, admin) {
    const dialog = field('fleetPhotosDialog');
    const list = field('fleetPhotoList');
    const status = field('fleetPhotoStatus');
    const input = field('fleetPhotoInput');
    const button = field('fleetPhotoUpload');
    let assetId = '', generation = 0, busy = false;
    const bucket = () => client.storage.from(bucketName);
    input.closest('label').hidden = button.hidden = !admin;
    field('fleetPhotoClose').onclick = () => dialog.close();
    dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
    dialog.addEventListener('close', () => { generation++; list.replaceChildren(); });
    function setBusy(value) {
      busy = value;
      button.disabled = field('fleetPhotoClose').disabled = value;
      list.querySelectorAll('button').forEach(control => { control.disabled = value; });
    }
    async function refresh() {
      const id = assetId, version = ++generation;
      status.textContent = 'Loading photos…';
      list.replaceChildren();
      try {
        const {data, error} = await bucket().list(id, {limit:100, sortBy:{column:'created_at',order:'desc'}});
        if (error) throw error;
        if (version !== generation) return;
        const paths = data.filter(file => file.id).map(file => id + '/' + file.name);
        if (!paths.length) { status.textContent = 'No photos attached.'; return; }
        const signed = await bucket().createSignedUrls(paths, 300);
        if (signed.error) throw signed.error;
        if (version !== generation) return;
        const photos = signed.data.filter(photo => photo.signedUrl);
        status.textContent = photos.length === paths.length ? `${photos.length} photos` : 'Some photos could not be loaded.';
        for (const [index, photo] of photos.entries()) {
          const figure = document.createElement('figure');
          const link = document.createElement('a');
          link.href = photo.signedUrl;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          const img = document.createElement('img');
          img.src = photo.signedUrl;
          img.alt = 'Fleet photo ' + (index + 1);
          img.loading = 'lazy';
          link.append(img);
          figure.append(link);
          if (admin) {
            const remove = document.createElement('button');
            remove.textContent = 'Remove photo';
            remove.disabled = busy;
            remove.onclick = async () => {
              if (busy || !confirm('Remove this fleet photo?')) return;
              setBusy(true);
              try {
                const result = await bucket().remove([photo.path]);
                if (result.error) throw result.error;
                await refresh();
              } catch (error) { status.textContent = 'Could not remove photo. ' + error.message; }
              finally { setBusy(false); }
            };
            figure.append(remove);
          }
          list.append(figure);
        }
      } catch (error) {
        if (version === generation) status.textContent = 'Could not load photos. ' + error.message;
      }
    }
    button.onclick = async () => {
      if (busy || !admin) return;
      const files = [...input.files];
      if (!files.length || files.length > 5 || files.some(file => !imageTypes[file.type] || !file.size || file.size > 5242880)) {
        status.textContent = 'Choose 1–5 JPEG, PNG or WebP photos, up to 5 MB each.';
        return;
      }
      setBusy(true);
      status.textContent = 'Uploading photos…';
      let saved = 0, failure = '';
      try {
        for (const file of files) {
          const path = assetId + '/' + crypto.randomUUID() + '.' + imageTypes[file.type];
          const {error} = await bucket().upload(path, file, {contentType:file.type, cacheControl:'60', upsert:false});
          if (error) throw error;
          saved++;
        }
      } catch (error) { failure = error.message; }
      finally {
        input.value = '';
        await refresh();
        status.textContent = failure ? `${saved} uploaded. Upload stopped. ${failure}` : `${saved} uploaded. ${status.textContent}`;
        setBusy(false);
      }
    };
    return asset => {
      assetId = String(asset.id);
      field('fleetPhotosTitle').textContent = 'Photos · ' + asset.unit_name;
      input.value = '';
      dialog.showModal();
      void refresh();
    };
  }
  const api = {tagStatus, tagBadge, mountPhotos};
  if (typeof module === 'object') module.exports = api;
  else root.GP_FLEET_RECORDS = api;
})(globalThis);
