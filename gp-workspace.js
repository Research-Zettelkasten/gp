(() => {
  'use strict';
  const features = {
    photo_intake: ['Photo-to-quote', 'Quote Call-Backs'],
    quote_links: ['Customer quote links', 'Quote Call-Backs'],
    dispatch: ['Dispatch map', 'Work Orders & Commissions'],
    job_search: ['Past-job search', 'Quotes or Work Orders']
  };

  function element(tag, text, className) {
    const el = document.createElement(tag);
    if (text != null) el.textContent = text;
    if (className) el.className = className;
    return el;
  }

  function button(text, handler, className = '') {
    const el = element('button', text, className);
    el.type = 'button';
    el.onclick = handler;
    return el;
  }

  function link(text, href) {
    const el = element('a', text);
    el.href = href;
    return el;
  }

  function dialog(title, body, wide = false) {
    const el = element('dialog', null, 'gpw-dialog' + (wide ? ' gpw-wide' : ''));
    const head = element('div', null, 'gpw-head');
    const heading = element('h2', title);
    heading.id = 'gpw-' + crypto.randomUUID();
    el.setAttribute('aria-labelledby', heading.id);
    head.append(heading, button('Close', () => el.close()));
    const panel = element('div');
    panel.innerHTML = body;
    el.append(head, panel);
    el.addEventListener('close', () => el.remove(), { once: true });
    document.body.append(el);
    el.showModal();
    return { el, panel };
  }

  function status(el, message = '', error = false) {
    el.textContent = message;
    el.dataset.error = String(error);
  }

  async function rpc(client, name, args) {
    const { data, error } = await client.rpc(name, args);
    if (error) throw Error(error.message || 'Request failed. Try again.');
    return data;
  }

  async function access(client) {
    try { return (await rpc(client, 'gp_workspace_features')) || {}; }
    catch { return {}; }
  }

  function bindGates(client, controls) {
    let revision = 0;
    async function refresh() {
      const current = ++revision;
      const allowed = await access(client);
      if (current !== revision) return;
      for (const [el, key] of controls) {
        const nodes = typeof el === 'function' ? el() : [el];
        for (const node of nodes) if (node) node.hidden = allowed[key] !== true;
      }
    }
    void refresh();
    window.addEventListener('focus', refresh);
  }

  async function action(control, message, callback) {
    control.disabled = true;
    status(message);
    try { await callback(); }
    catch (error) { status(message, error.message, true); }
    finally { control.disabled = false; }
  }

  async function jpeg(file) {
    if (!file || !['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 20 * 1024 * 1024) {
      throw Error('Choose a JPG, PNG or WebP photo under 20 MB.');
    }
    let image;
    try { image = await createImageBitmap(file); }
    catch { throw Error('This photo could not be opened. Try a JPG or PNG.'); }
    const canvas = document.createElement('canvas');
    const scale = Math.min(1, 1800 / Math.max(image.width, image.height));
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    image.close();
    return new Promise((resolve, reject) => canvas.toBlob(blob => {
      if (!blob || blob.size > 5 * 1024 * 1024) reject(Error('Could not prepare the photo.'));
      else resolve(blob);
    }, 'image/jpeg', 0.86));
  }

  async function signedPhoto(client, bucket, path) {
    const { data, error } = await client.storage.from(bucket).createSignedUrl(path, 120);
    if (error) throw Error(error.message);
    return data.signedUrl;
  }

  function mountPermissions(client) {
    const root = document.getElementById('gpWorkspacePermissions');
    if (!root) return;
    root.hidden = false;
    const message = root.querySelector('[role=status]');
    const modeArea = root.querySelector('[data-modes]');
    const form = root.querySelector('form');
    const field = key => form.elements.namedItem(key);
    let snapshot;
    function showOverride() {
      const match = snapshot?.exceptions.find(row => row.feature === field('feature').value &&
        String(row.employee_id) === field('employee').value);
      field('override').value = match ? (match.allowed ? 'allow' : 'deny') : 'inherit';
      const person = snapshot?.staff.find(row => String(row.id) === field('employee').value);
      const key = field('feature').value;
      const eligible = person?.admin || (key === 'dispatch' ? person?.commission :
        key === 'job_search' ? (person?.quotes || person?.commission) : person?.quotes);
      root.querySelector('[data-eligibility]').textContent = person && !eligible
        ? 'This employee also needs access to the parent workspace.' : '';
    }
    async function load() {
      snapshot = await rpc(client, 'gp_workspace_permissions');
      const currentEmployee = field('employee').value;
      field('employee').replaceChildren(...snapshot.staff.map(person => new Option(
        [person.name, person.department].filter(Boolean).join(' · '), person.id)));
      if (snapshot.staff.some(person => String(person.id) === currentEmployee)) field('employee').value = currentEmployee;
      field('save').disabled = !snapshot.staff.length;
      modeArea.replaceChildren(...Object.entries(features).map(([key, [name, parent]]) => {
        const row = element('div', null, 'gpw-form-row gpw-grid');
        const label = element('label', name);
        const select = element('select');
        [['off','Hidden for everyone'],['admins','Administrators only'],['pilot','Administrators and selected staff'],['workspace','Everyone with workspace access']]
          .forEach(([value, text]) => select.add(new Option(text, value)));
        select.value = snapshot.features[key];
        const parentNote = element('div', parent, 'gpw-muted');
        const save = button('Save release mode', () => action(save, message, async () => {
          const mode = select.value;
          await rpc(client, 'gp_set_workspace_permission', { p_feature: key, p_value: mode });
          await load();
          status(message, name + ' release mode saved.');
        }));
        label.append(select, parentNote);
        const actions = element('div', null, 'gpw-actions');
        actions.append(save);
        row.append(label, actions);
        return row;
      }));
      showOverride();
    }

    for (const [key, [label]] of Object.entries(features)) field('feature').add(new Option(label, key));
    field('feature').onchange = field('employee').onchange = showOverride;
    form.onsubmit = event => {
      event.preventDefault();
      void action(field('save'), message, async () => {
        await rpc(client, 'gp_set_workspace_permission', {
          p_feature: field('feature').value, p_value: field('override').value, p_employee_id: field('employee').value
        });
        await load();
        status(message, 'Employee override saved.');
      });
    };
    const refresh = root.querySelector('[data-refresh]');
    refresh.onclick = () => action(refresh, message, load);
    void action(refresh, message, load);
  }

  window.GP_WORKSPACE = { element, button, link, dialog, status, rpc, access, bindGates, action, jpeg, signedPhoto, mountPermissions };
})();
