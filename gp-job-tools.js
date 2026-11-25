(() => {
  'use strict';
  const W = window.GP_WORKSPACE;
  const stages = { review: 'Needs review', site_visit: 'Needs site visit', quote_ready: 'Ready to quote' };

  function photoToQuote(client, user, context = {}) {
    const { panel, el } = W.dialog('Photo-to-quote', `
      <div class="gpw-actions"><button type="button" data-new>New intake</button><button type="button" data-refresh>Refresh saved intakes</button></div>
      <ul class="gpw-list" data-list></ul>
      <p class="gpw-status" role="status"></p>
      <form hidden>
        <div class="gpw-grid">
          <label>Job title<input name="title" required maxlength="160" placeholder="Storefront door repair"></label>
          <label>Customer<input name="customer" required maxlength="180"></label>
          <label>Site address<input name="site" maxlength="300" autocomplete="off"></label>
          <label>Next step<select name="next_step"><option value="review">Needs review</option><option value="site_visit">Needs site visit</option><option value="quote_ready">Ready to quote</option></select></label>
          <label>Existing quote #<input name="quote_number" inputmode="numeric" pattern="[0-9]{1,15}"></label>
          <label>Work order #<input name="work_order" maxlength="80"></label>
        </div>
        <label data-file>Site photo<input name="photo" type="file" accept="image/jpeg,image/png,image/webp"></label>
        <label>Marker label<input name="markerLabel" maxlength="100" placeholder="Passenger-side panel"></label>
        <p class="gpw-muted">Enter a label, then click or tap its location on the photo. Use the list to remove a marker.</p>
        <div><div class="gpw-markup" data-markup hidden><img alt="Job site with photo markers"></div></div>
        <ol data-markers class="gpw-list"></ol>
        <label>Observations and questions<textarea name="observations" maxlength="4000" rows="5"></textarea></label>
        <div class="gpw-actions"><button type="button" data-draft>Draft site checklist</button><button type="button" data-ai hidden>Draft from photo with AI</button><button class="gpw-primary" type="submit">Save intake</button></div>
        <p class="gpw-muted">Verify dimensions, glass specifications and pricing before sending a quote. Use the quote and work order fields to connect this intake to an existing record.</p>
      </form>`);
    const find = selector => panel.querySelector(selector);
    const form = find('form');
    const field = key => form.elements.namedItem(key);
    const message = find('[role=status]');
    const markup = find('[data-markup]');
    const image = markup.querySelector('img');
    let record = null;
    let photo;
    let markings = [];
    let objectUrl;
    let editVersion = 0;
    let fileVersion = 0;

    function setPhoto(url) {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = url?.startsWith('blob:') ? url : null;
      if (url) image.src = url;
      else image.removeAttribute('src');
      markup.hidden = !url;
    }
    el.addEventListener('close', () => { editVersion++; fileVersion++; setPhoto(); });

    function renderMarkers() {
      const markerList = find('[data-markers]');
      markerList.replaceChildren();
      markup.querySelectorAll('button').forEach(marker => marker.remove());
      markings.forEach((marker, index) => {
        const pin = W.button(String(index + 1), event => {
          event.stopPropagation();
          markerList.children[index]?.querySelector('button').focus();
        }, 'gpw-marker');
        pin.title = marker.label;
        pin.setAttribute('aria-label', marker.label);
        pin.style.left = (marker.x * 100) + '%';
        pin.style.top = (marker.y * 100) + '%';
        markup.append(pin);
        const row = W.element('li', null, 'gpw-actions');
        row.append(W.element('span', (index + 1) + '. ' + marker.label), W.button('Remove marker', () => {
          markings.splice(index, 1);
          renderMarkers();
        }));
        markerList.append(row);
      });
    }

    async function edit(next) {
      const revision = ++editVersion;
      fileVersion++;
      form.reset();
      record = next;
      photo = null;
      find('[data-ai]').hidden = true;
      setPhoto();
      markings = (next?.markup || []).slice();
      renderMarkers();
      form.hidden = false;
      find('[data-file]').hidden = !!next;
      field('photo').required = !next;
      field('title').value = next?.title || '';
      field('customer').value = next?.customer || context.customer || '';
      field('site').value = next?.site || '';
      field('quote_number').value = next?.quote_number || context.quote || '';
      field('work_order').value = next?.work_order || context.workOrder || '';
      field('next_step').value = next?.next_step || 'review';
      field('observations').value = next?.observations || '';
      if (next) {
        try {
          const src = await W.signedPhoto(client, 'gp-quote-intake', next.photo_path);
          if (revision === editVersion) setPhoto(src);
        } catch (error) {
          if (revision === editVersion) W.status(message, error.message, true);
        }
      }
    }

    async function load() {
      let query = client.from('gp_photo_intakes').select('*').order('updated_at', { ascending: false }).limit(30);
      if (context.quote) query = query.eq('quote_number', context.quote);
      if (context.id) query = query.eq('id', context.id);
      if (context.workOrder) query = query.eq('work_order', context.workOrder);
      const { data, error } = await query;
      if (error) throw Error(error.message);
      const list = find('[data-list]');
      list.replaceChildren();
      if (!data.length) list.append(W.element('li', 'No saved photo intakes here yet.', 'gpw-muted'));
      for (const row of data) {
        const item = W.element('li', null, 'gpw-item');
        item.append(W.button(row.title + ' · ' + stages[row.next_step], () => { void edit(row); }));
        item.append(W.element('p', [row.customer, row.site, row.work_order && 'WO ' + row.work_order].filter(Boolean).join(' · ')));
        list.append(item);
      }
      return data;
    }

    const refresh = find('[data-refresh]');
    refresh.onclick = () => W.action(refresh, message, load);
    find('[data-new]').hidden = !!context.id;
    find('[data-new]').onclick = () => { W.status(message); void edit(null); };
    field('photo').onchange = async () => {
      const current = ++fileVersion;
      photo = null;
      find('[data-ai]').hidden = true;
      setPhoto();
      markings = [];
      renderMarkers();
      if (!field('photo').files[0]) return;
      try {
        const imageFile = await W.jpeg(field('photo').files[0]);
        if (current !== fileVersion) return;
        photo = imageFile;
        find('[data-ai]').hidden = false;
        setPhoto(URL.createObjectURL(imageFile));
        W.status(message);
      } catch (error) {
        if (current === fileVersion) W.status(message, error.message, true);
      }
    };
    image.onclick = event => {
      const label = field('markerLabel').value.trim();
      if (!label) { field('markerLabel').focus(); W.status(message, 'Enter a label for this spot.', true); return; }
      if (markings.length >= 25) { W.status(message, 'Up to 25 markers per photo.', true); return; }
      const rect = image.getBoundingClientRect();
      markings.push({
        x: Number(((event.clientX - rect.left) / rect.width).toFixed(5)),
        y: Number(((event.clientY - rect.top) / rect.height).toFixed(5)),
        label
      });
      field('markerLabel').value = '';
      W.status(message);
      renderMarkers();
    };
    find('[data-draft]').onclick = () => {
      const areas = markings.map(marker => marker.label).join(', ');
      const draft = [
        field('title').value.trim() && 'Reported job: ' + field('title').value.trim(),
        areas && 'Areas marked for review: ' + areas,
        'Confirm the affected opening or vehicle, site access, measurements, glass or part specifications, and when the customer needs service.'
      ].filter(Boolean).join('\n');
      const input = field('observations');
      const merged = [input.value.trim(), draft].filter(Boolean).join('\n\n');
      if (merged.length > 4000) { W.status(message, 'Shorten the observations before inserting the checklist.', true); return; }
      input.value = merged;
      input.focus();
    };
    const ai = find('[data-ai]');
    ai.onclick = () => {
      if (!photo || !confirm('Send this photo to OpenAI to draft suggested observations? Remove visible private information first.')) return;
      void W.action(ai, message, async () => {
        const revision = fileVersion;
        const input = field('observations');
        const { data, error } = await client.functions.invoke('gp-photo-draft', {
          body: photo, headers: {'Content-Type':'image/jpeg'}
        });
        if (revision !== fileVersion) return;
        if (error) {
          const details = await error.context?.json?.().catch(() => null);
          throw Error(details?.error || 'AI photo drafting is unavailable. Use the site checklist.');
        }
        if (!data?.draft) throw Error('No photo draft was returned. Use the site checklist.');
        const next = [input.value.trim(), 'AI draft for staff review:\n' + data.draft].filter(Boolean).join('\n\n');
        if (next.length > 4000) throw Error('Shorten the observations before inserting the draft.');
        input.value = next;
        input.focus();
        W.status(message, 'Draft added. Review and edit before saving.');
      });
    };
    form.onsubmit = event => {
      event.preventDefault();
      void W.action(form.querySelector('[type=submit]'), message, async () => {
        if (!record && !photo) throw Error('Choose a photo and wait for it to open before saving.');
        const current = editVersion;
        const fields = Object.fromEntries(['title','customer','site','observations','next_step','quote_number','work_order']
          .map(key => [key, field(key).value.trim()]));
        const reference = record;
        fields.markup = markings.slice();
        if (!reference) {
          fields.photo_path = user.auth_user_id + '/' + crypto.randomUUID() + '.jpg';
          const { error } = await client.storage.from('gp-quote-intake').upload(fields.photo_path, photo, { contentType: 'image/jpeg' });
          if (error) throw Error(error.message);
        }
        let saved;
        try {
          saved = await W.rpc(client, 'gp_save_photo_intake', {
            p_id: reference?.id || null, p_revision: reference?.updated_at || null, p_fields: fields
          });
        } catch (error) {
          if (fields.photo_path) await client.storage.from('gp-quote-intake').remove([fields.photo_path]);
          throw error;
        }
        if (current === editVersion) await edit(saved);
        W.status(message, 'Intake saved.');
        await load();
      });
    };
    void W.action(refresh, message, async () => {
      const rows = await load();
      if (context.id && rows[0]) await edit(rows[0]);
      if (context.id && !rows.length) W.status(message, 'This intake is unavailable.', true);
    });
  }

  function searchTerms(text) {
    let query = text.trim().replace(/[?]+$/g, '');
    query = query.replace(/^(?:have we (?:ever )?(?:replaced|installed|worked on|repaired|done)|(?:can you )?(?:show me|find|search for))\s+(?:(?:this (?:style|type) of|a|an|the)\s+)?/i, '');
    return query.replace(/\s+(?:before|in the past|previously)$/i, '').trim();
  }

  function search(client, context = {}) {
    const { panel } = W.dialog('Past-job search', `
      <form><label>Search quotes, work orders and photo intakes<input type="search" name="query" required minlength="2" maxlength="280" placeholder="Have we replaced a storefront door before?"></label>
        <button class="gpw-primary">Search</button></form>
      <p class="gpw-status" role="status"></p><ul class="gpw-list" data-results></ul>`);
    const form = panel.querySelector('form');
    const message = panel.querySelector('[role=status]');
    const results = panel.querySelector('[data-results]');
    form.elements.query.value = context.query || '';
    form.onsubmit = event => {
      event.preventDefault();
      void W.action(form.querySelector('button'), message, async () => {
        results.replaceChildren();
        const query = searchTerms(form.elements.query.value);
        if (query.length < 2) throw Error('Enter a work order, quote number, job type or material.');
        const data = await W.rpc(client, 'gp_search_past_jobs', { p_query: query, p_customer: context.customerId || null });
        W.status(message, data.length ? data.length + (data.length === 50 ? '+ matches · first 50 shown' : ' matches') : 'No matching records. Try a job type, part, material or reference number.');
        for (const row of data) {
          const item = W.element('li', null, 'gpw-item');
          const label = row.source === 'quote' ? 'Quote #' + row.reference :
            row.source === 'work_order' ? 'WO #' + row.reference : 'Photo intake';
          item.append(W.element('h3', row.title || label));
          item.append(W.element('p', [label, row.customer_name, row.occurred_on].filter(Boolean).join(' · '), 'gpw-muted'));
          if (row.summary) item.append(W.element('p', row.summary));
          if (row.source === 'quote') item.append(W.link('Open quote', 'quotes.html?quote=' + encodeURIComponent(row.reference)));
          if (row.source === 'intake') item.append(W.link('Open photo and markers', 'quotes.html?intake=' + encodeURIComponent(row.reference)));
          item.querySelectorAll('a').forEach(link => { link.target = '_blank'; link.rel = 'noopener'; });
          results.append(item);
        }
      });
    };
    if (form.elements.query.value) form.requestSubmit();
  }

  window.GP_JOB_TOOLS = { photoToQuote, search };
})();
