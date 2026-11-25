(() => {
  'use strict';
  const W = window.GP_WORKSPACE;
  const T = window.GP_TIME;
  const store = { latitude: 30.832, longitude: -83.280 };
  const kinds = { install: 'Install', service: 'Service call', pickup: 'Pickup', emergency: 'Emergency' };
  const statuses = { scheduled: 'Scheduled', in_progress: 'In progress', done: 'Done', cancelled: 'Cancelled' };
  const formatTime = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: T.zone });
  const timeLabel = ms => formatTime.format(new Date(ms));
  const localValue = value => {
    const p = T.parts(new Date(value));
    return p.year + '-' + p.month + '-' + p.day + 'T' + p.hour + ':' + p.minute;
  };
  const utc = local => {
    const [day, time] = local.split('T');
    if (!T.validDay(day) || !/^\d{2}:\d{2}$/.test(time || '')) throw Error('Enter a valid Eastern date and time.');
    const value = new Date(T.wallTime(day, time)).toISOString();
    if (localValue(value) !== local) throw Error('This time falls in the Eastern daylight-saving jump. Pick another time.');
    return value;
  };

  function pixel(point, zoom) {
    const { latitude, longitude } = point;
    const scale = 256 * 2 ** zoom;
    const sin = Math.sin(Math.max(-85, Math.min(85, latitude)) * Math.PI / 180);
    return { x: scale * (longitude + 180) / 360, y: scale * (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) };
  }

  function coords(x, y, zoom) {
    const scale = 256 * 2 ** zoom;
    return {
      latitude: Math.max(-85, Math.min(85, Math.atan(Math.sinh(Math.PI * (1 - 2 * y / scale))) * 180 / Math.PI)),
      longitude: ((x / scale * 360 % 360) + 360) % 360 - 180
    };
  }

  function map(panel, onPick, onStop) {
    const field = panel.querySelector('.gpw-map');
    const layer = field.querySelector('[data-layer]');
    let center = store;
    let zoom = 13;
    let rows = [];
    let selected = null;
    let picking = false;
    function render() {
      const width = field.clientWidth;
      const height = field.clientHeight;
      const origin = pixel(center, zoom);
      const left = Math.round(origin.x - width / 2);
      const top = Math.round(origin.y - height / 2);
      const max = 2 ** zoom;
      const tiles = [];
      for (let y = Math.floor(top / 256); y <= Math.floor((top + height) / 256); y++) {
        if (y < 0 || y >= max) continue;
        for (let x = Math.floor(left / 256); x <= Math.floor((left + width) / 256); x++) {
          const img = W.element('img');
          img.src = 'https://tile.openstreetmap.org/' + zoom + '/' + ((x % max + max) % max) + '/' + y + '.png';
          img.alt = '';
          img.draggable = false;
          img.style.left = (x * 256 - left) + 'px';
          img.style.top = (y * 256 - top) + 'px';
          tiles.push(img);
        }
      }
      const pins = [];
      for (const [index, row] of [...rows, ...(selected ? [selected] : [])].entries()) {
        const p = pixel(row, zoom);
        const x = ((p.x - origin.x + 128 * max) % (256 * max) + 256 * max) % (256 * max) - 128 * max + width / 2;
        const y = p.y - top;
        if (x < 0 || x > width || y < 0 || y > height) continue;
        const pin = W.button(row === selected ? '+' : index + 1, event => {
          if (picking) return;
          event.stopPropagation();
          if (row !== selected) onStop(row);
        }, 'gpw-marker');
        pin.title = row.title || 'Selected job site';
        pin.setAttribute('aria-label', pin.title);
        pin.dataset.kind = row === selected ? 'selected' : row.kind;
        pin.style.left = x + 'px';
        pin.style.top = y + 'px';
        pins.push(pin);
      }
      layer.replaceChildren(...tiles, ...pins);
    }
    panel.querySelectorAll('[data-move]').forEach(button => {
      button.onclick = () => {
        const move = button.dataset.move;
        if (move === 'in' || move === 'out') zoom = Math.min(18, Math.max(5, zoom + (move === 'in' ? 1 : -1)));
        else {
          const p = pixel(center, zoom);
          const delta = { north: [0,-130], south: [0,130], west: [-130,0], east: [130,0] }[move];
          center = coords(p.x + delta[0], p.y + delta[1], zoom);
        }
        render();
      };
    });
    field.onclick = event => {
      if (!picking || event.target.closest('a')) return;
      const p = pixel(center, zoom);
      const box = field.getBoundingClientRect();
      const point = coords(p.x + event.clientX - box.left - box.width / 2, p.y + event.clientY - box.top - box.height / 2, zoom);
      onPick(point);
    };
    const size = new ResizeObserver(render);
    size.observe(field);
    return {
      rows(next) { rows = next; render(); },
      center(point) { center = point; render(); },
      select(point) { selected = point; render(); },
      picking(value) { picking = value; field.style.cursor = value ? 'crosshair' : ''; },
      destroy() { size.disconnect(); }
    };
  }

  function open(client) {
    const { el, panel } = W.dialog('Dispatch map', `
      <div class="gpw-grid">
        <label>Dispatch date (Eastern)<input type="date" data-date></label>
        <label>Crew filter<select data-crew><option value="">All crews</option></select></label>
      </div>
      <div class="gpw-tools">
        <button type="button" data-new>Schedule a stop</button><button type="button" data-refresh>Refresh stops</button>
      </div>
      <p class="gpw-status" role="status"></p>
      <div class="gpw-tools" aria-label="Map controls">
        <button type="button" data-move="in" aria-label="Zoom in">+</button><button type="button" data-move="out" aria-label="Zoom out">−</button>
        <button type="button" data-move="north" aria-label="Pan north">↑</button><button type="button" data-move="south" aria-label="Pan south">↓</button>
        <button type="button" data-move="west" aria-label="Pan west">←</button><button type="button" data-move="east" aria-label="Pan east">→</button>
      </div>
      <div class="gpw-map" aria-label="Scheduled stops map">
        <div data-layer></div>
        <a class="gpw-map-credit" href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap contributors</a>
      </div>
      <form hidden>
        <div class="gpw-grid">
          <label>Job or stop title<input name="title" required maxlength="160"></label>
          <label>Site address<input name="site" required maxlength="300"></label>
          <label>Crew<input name="crew" list="gpw-dispatch-crews" maxlength="100" placeholder="Unassigned"><datalist id="gpw-dispatch-crews"></datalist></label>
          <label>Work order #<input name="work_order" maxlength="80"></label>
          <label>Starts (Eastern)<input type="datetime-local" name="starts_at" required></label>
          <label>Ends (Eastern)<input type="datetime-local" name="ends_at" required></label>
          <label>Stop type<select name="kind"><option value="install">Install</option><option value="service">Service call</option><option value="pickup">Pickup</option><option value="emergency">Emergency</option></select></label>
          <label>Status<select name="status"><option value="scheduled">Scheduled</option><option value="in_progress">In progress</option><option value="done">Done</option><option value="cancelled">Cancelled</option></select></label>
          <label>Site latitude<input type="number" name="latitude" min="-85" max="85" step="any" required></label>
          <label>Site longitude<input type="number" name="longitude" min="-180" max="180" step="any" required></label>
        </div>
        <p class="gpw-muted">After verifying the address, click the map to drop a pin or enter the coordinates above.</p>
        <p data-availability class="gpw-muted"></p>
        <label>Dispatch notes<textarea name="notes" rows="3" maxlength="4000"></textarea></label>
        <div class="gpw-actions"><button class="gpw-primary" type="submit">Save stop</button><button type="button" data-cancel>Close stop editor</button></div>
      </form>
      <ul class="gpw-list" data-stops></ul>`, true);
    const find = selector => panel.querySelector(selector);
    const message = find('[role=status]');
    const day = find('[data-date]');
    const crew = find('[data-crew]');
    const form = find('form');
    const field = key => form.elements.namedItem(key);
    const refresh = find('[data-refresh]');
    let all = [];
    let current = null;
    let loadVersion = 0;
    day.value = T.day();
    const board = map(panel, point => {
      field('latitude').value = point.latitude.toFixed(6);
      field('longitude').value = point.longitude.toFixed(6);
      showPin();
    }, row => edit(row));
    el.addEventListener('close', () => board.destroy());

    function showPin() {
      const latitude = field('latitude').valueAsNumber;
      const longitude = field('longitude').valueAsNumber;
      board.select(field('latitude').checkValidity() && field('longitude').checkValidity() ? { latitude, longitude } : null);
    }

    function availability() {
      const label = find('[data-availability]');
      if (!field('starts_at').value || !field('ends_at').value) { label.textContent = ''; return; }
      try {
        const start = Date.parse(utc(field('starts_at').value));
        const end = Date.parse(utc(field('ends_at').value));
        if (T.day(start) !== day.value || T.day(end - 1) !== day.value) {
          label.textContent = 'Crew conflicts across dates will be checked when you save.';
          return;
        }
        const crews = [...new Set(all.map(row => row.crew).filter(Boolean))];
        const available = crews.filter(name => !all.some(row => row.id !== current?.id &&
          row.crew.toLowerCase() === name.toLowerCase() && ['scheduled','in_progress'].includes(row.status) &&
          Date.parse(row.starts_at) < end && Date.parse(row.ends_at) > start));
        label.textContent = available.length ? 'Scheduled crews free in this time window: ' + available.join(', ') :
          'No crew with a stop on this board is free in that window.';
      } catch (error) { label.textContent = error.message; }
    }
    function edit(row) {
      current = row;
      form.hidden = false;
      form.reset();
      for (const key of ['title','site','crew','work_order','kind','status','latitude','longitude','notes']) {
        if (row?.[key] != null) field(key).value = row[key];
      }
      field('starts_at').value = row ? localValue(row.starts_at) : day.value + 'T09:00';
      field('ends_at').value = row ? localValue(row.ends_at) : day.value + 'T10:00';
      board.picking(true);
      if (row) board.center(row);
      showPin();
      availability();
      field('title').focus({ preventScroll: true });
      form.scrollIntoView({ block: 'nearest' });
    }
    function closeEditor() {
      form.hidden = true;
      current = null;
      board.select(null);
      board.picking(false);
    }
    function render(center = false) {
      const rows = all.filter(row => !crew.value || row.crew === crew.value);
      const list = find('[data-stops]');
      list.replaceChildren();
      if (!rows.length) list.append(W.element('li', 'No stops scheduled for this view.', 'gpw-muted'));
      const plotted = rows.filter(row => row.status !== 'cancelled');
      if (center) board.center(plotted[0] || store);
      board.rows(plotted);
      for (const row of rows) {
        const li = W.element('li', null, 'gpw-item');
        const pin = plotted.indexOf(row);
        li.append(W.element('h3', (pin < 0 ? '' : (pin + 1) + '. ') + row.title), W.element('p', row.site));
        li.append(W.element('p', [kinds[row.kind], statuses[row.status], row.crew || 'Unassigned',
          timeLabel(row.starts_at) + '–' + timeLabel(row.ends_at), row.work_order && 'WO ' + row.work_order].filter(Boolean).join(' · '), 'gpw-muted'));
        if (row.notes) li.append(W.element('p', row.notes));
        const actions = W.element('div', null, 'gpw-actions');
        const directions = W.link('Directions', 'https://www.google.com/maps/dir/?api=1&destination=' + encodeURIComponent(row.latitude + ',' + row.longitude));
        directions.rel = 'noopener noreferrer';
        directions.target = '_blank';
        actions.append(W.button('Edit stop', () => edit(row)), W.button('Center on map', () => board.center(row)), directions);
        li.append(actions);
        list.append(li);
      }
      if (!form.hidden) availability();
    }

    async function load(center = false) {
      const version = ++loadVersion;
      if (!T.validDay(day.value)) throw Error('Choose a valid dispatch date.');
      const start = utc(day.value + 'T00:00');
      const end = utc(T.addDays(day.value, 1) + 'T00:00');
      const { data, error } = await client.from('gp_dispatch_stops').select('*')
        .lt('starts_at', end).gt('ends_at', start).order('starts_at', { ascending: true }).limit(300);
      if (version !== loadVersion) return;
      if (error) throw Error(error.message);
      all = data.sort((a, b) => Number(b.kind === 'emergency') - Number(a.kind === 'emergency') ||
        Date.parse(a.starts_at) - Date.parse(b.starts_at));
      const crews = [...new Set(all.map(row => row.crew).filter(Boolean))].sort();
      const selection = crew.value;
      crew.replaceChildren(new Option('All crews', ''), ...crews.map(name => new Option(name, name)));
      crew.value = crews.includes(selection) ? selection : '';
      find('datalist').replaceChildren(...crews.map(name => new Option(name, name)));
      render(center);
    }
    find('[data-new]').onclick = () => edit(null);
    find('[data-cancel]').onclick = closeEditor;
    field('latitude').oninput = field('longitude').oninput = showPin;
    field('starts_at').oninput = field('ends_at').oninput = availability;
    refresh.onclick = () => W.action(refresh, message, () => load());
    day.onchange = () => { closeEditor(); return W.action(refresh, message, () => load(true)); };
    crew.onchange = () => render(true);
    form.onsubmit = event => {
      event.preventDefault();
      void W.action(form.querySelector('[type=submit]'), message, async () => {
        const body = Object.fromEntries(['title','site','crew','kind','status','work_order','notes'].map(key => [key, field(key).value.trim()]));
        body.starts_at = utc(field('starts_at').value);
        body.ends_at = utc(field('ends_at').value);
        body.latitude = field('latitude').valueAsNumber;
        body.longitude = field('longitude').valueAsNumber;
        if (Date.parse(body.ends_at) <= Date.parse(body.starts_at)) throw Error('The stop must end after it starts.');
        const saved = await W.rpc(client, 'gp_save_dispatch_stop', {
          p_id: current?.id || null, p_revision: current?.updated_at || null, p_fields: body
        });
        day.value = T.day(Date.parse(saved.starts_at));
        closeEditor();
        await load();
        board.center(saved);
        W.status(message, 'Dispatch stop saved.');
      });
    };
    void W.action(refresh, message, () => load(true));
  }

  window.GP_DISPATCH = { open };
})();
