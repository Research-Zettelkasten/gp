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
    if (error) throw Object.assign(new Error(error.message || 'Request failed. Try again.'), { code: error.code });
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
    const message = root.querySelector('[role=status]');
    const settings = root.querySelector('[data-settings]');
    const modeArea = root.querySelector('[data-modes]');
    const form = root.querySelector('form');
    const employeeHint = root.querySelector('[data-employee]');
    const eligibility = root.querySelector('[data-eligibility]');
    const refresh = root.querySelector('[data-refresh]');
    const controls = root.querySelectorAll('[data-controls]');
    const field = key => form.elements.namedItem(key);
    const modes = [
      ['off', 'Hidden for everyone'], ['admins', 'Administrators only'],
      ['pilot', 'Administrators and selected staff'], ['workspace', 'Everyone with workspace access']
    ];
    let snapshot;
    let selectedEmployee;
    let busy = false;

    function tell(text = '', error = false) {
      message.hidden = !text;
      status(message, text, error);
    }

    function currentEmployee() {
      return selectedEmployee && snapshot?.staff.find(person => String(person.id) === String(selectedEmployee.id));
    }

    function renderEmployee() {
      const person = currentEmployee();
      form.hidden = !person;
      if (!selectedEmployee) {
        employeeHint.textContent = 'Select Edit beside an employee in the roster, or save a new employee account.';
        return;
      }
      if (!person) {
        employeeHint.textContent = selectedEmployee.employee_name + ' must have an active saved account to edit feature access.';
        return;
      }
      employeeHint.textContent = 'Editing feature access for ' + person.name + '. Eligibility uses their saved base workspace access.';
      const key = field('feature').value;
      const match = snapshot.exceptions.find(row => row.feature === key && String(row.employee_id) === String(person.id));
      field('override').value = match ? (match.allowed ? 'allow' : 'deny') : 'inherit';

      const mode = snapshot.features[key];
      const eligible = person.admin || (key === 'dispatch' ? person.commission :
        key === 'job_search' ? (person.quotes || person.commission) : person.quotes);
      const modeLabel = modes.find(([value]) => value === mode)?.[1] || '';
      let access = 'Available to this employee.';
      if (mode === 'off') access = 'Hidden company-wide.';
      else if (match?.allowed === false) access = 'Blocked for this employee.';
      else if (!eligible) access = 'The employee needs base access to ' + features[key][1] + '.';
      else if (mode === 'admins' && !person.admin) access = 'Only administrators have access.';
      else if (mode === 'pilot' && !person.admin && match?.allowed !== true) access = 'This employee needs a pilot override.';
      eligibility.textContent = 'Saved release mode: ' + modeLabel + '. ' + access;
    }

    async function run(callback) {
      if (busy) return;
      busy = true;
      refresh.disabled = true;
      controls.forEach(control => { control.disabled = true; });
      tell();
      try {
        await callback();
      } catch (error) {
        const missing = error.code === 'PGRST202' || error.code === '42883';
        tell(missing
          ? 'Workspace Permissions needs the Supabase update 20261125152759_workspace_features.sql. Run it in the GLASSPRO project, then select Reload settings.'
          : error.message, true);
      } finally {
        busy = false;
        refresh.disabled = false;
        controls.forEach(control => { control.disabled = false; });
      }
    }

    async function load() {
      try {
        snapshot = await rpc(client, 'gp_workspace_permissions');
        if (!snapshot?.features) throw Error('Workspace settings could not be loaded. Select Reload settings to try again.');
      } catch (error) {
        snapshot = null;
        settings.hidden = true;
        throw error;
      }
      settings.hidden = false;
      modeArea.replaceChildren(...Object.entries(features).map(([key, [name, parent]]) => {
        const row = element('div', null, 'gpw-form-row gpw-grid');
        const label = element('label', name + ' release mode');
        const select = element('select');
        modes.forEach(([value, text]) => select.add(new Option(text, value)));
        select.value = snapshot.features[key];
        const parentNote = element('div', parent, 'gpw-muted');
        const save = button('Save release mode', () => run(async () => {
          await rpc(client, 'gp_set_workspace_permission', { p_feature: key, p_value: select.value });
          await load();
          tell(name + ' release mode saved.');
        }));
        label.append(select, parentNote);
        const actions = element('div', null, 'gpw-actions');
        actions.append(save);
        row.append(label, actions);
        return row;
      }));
      renderEmployee();
    }

    for (const [key, [label]] of Object.entries(features)) field('feature').add(new Option(label, key));
    field('feature').onchange = renderEmployee;
    form.onsubmit = event => {
      event.preventDefault();
      const person = currentEmployee();
      if (!person) return;
      const key = field('feature').value;
      const override = field('override').value;
      void run(async () => {
        await rpc(client, 'gp_set_workspace_permission', { p_feature: key, p_value: override, p_employee_id: person.id });
        await load();
        tell('Feature override saved for ' + person.name + '.');
      });
    };
    refresh.onclick = () => run(load);
    root.addEventListener('toggle', () => {
      if (root.open) void run(load);
    });
    root.hidden = false;

    return {
      setEmployee(user) {
        selectedEmployee = user;
        if (snapshot) renderEmployee();
        if (root.open) void run(load);
      }
    };
  }

  window.GP_WORKSPACE = { element, button, link, dialog, status, rpc, access, bindGates, action, jpeg, signedPhoto, mountPermissions };
})();
