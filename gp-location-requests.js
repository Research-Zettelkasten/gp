(() => {
  'use strict';
  const stamp = value => new Date(value).toLocaleTimeString([], {hour:'numeric', minute:'2-digit'});
  const requestFields = 'id,session_started_at_ms,requester_name,requested_at,expires_at,status,responded_at,latitude,longitude,accuracy_m';

  async function readRequest(client, employeeId) {
    const {data, error} = await client.from('gp_live_location_requests').select(requestFields).eq('employee_id', employeeId).maybeSingle();
    if (error) throw error;
    return data;
  }

  function mountEmployee({client, getUser}) {
    const panel = document.getElementById('gpLiveLocation');
    if (!panel) return;
    if (panel.refreshLocationRequest) { void panel.refreshLocationRequest(); return; }
    panel.innerHTML = `
      <h3>Location request</h3>
      <p data-location-prompt></p>
      <p data-location-status role="status"></p>
      <div class="gp-location-actions">
        <button class="btn-outline" type="button" data-location-share>Share my location</button>
        <button class="btn-outline" type="button" data-location-decline>Decline</button>
      </div>`;
    const prompt = panel.querySelector('[data-location-prompt]');
    const status = panel.querySelector('[data-location-status]');
    const share = panel.querySelector('[data-location-share]');
    const decline = panel.querySelector('[data-location-decline]');
    const actions = panel.querySelector('.gp-location-actions');
    let current, ownerId, busy = false, loading = false;
    const hasLink = new URLSearchParams(location.search).has('locationRequest');
    let reveal = hasLink;

    async function refresh() {
      const employeeId = getUser()?.auth_user_id;
      if (!employeeId || document.hidden || busy || loading) return;
      if (ownerId !== employeeId) {
        ownerId = employeeId;
        current = null;
        actions.hidden = panel.hidden = true;
        status.textContent = '';
      }
      loading = true;
      try {
        const request = await readRequest(client, employeeId);
        if (employeeId !== getUser()?.auth_user_id || busy) return;
        const pending = request?.status === 'pending' && Date.parse(request.expires_at) > Date.now();
        if (!pending && !hasLink && !current) { panel.hidden = true; return; }
        if (pending && request.id !== current?.id) status.textContent = '';
        current = pending ? request : null;
        panel.hidden = false;
        if (reveal) { panel.scrollIntoView({block:'start'}); reveal = false; }
        actions.hidden = !current;
        prompt.textContent = current
          ? `${current.requester_name} requested your location. You can share one current reading or decline.`
          : request?.status === 'shared' ? 'You shared your location.' : request?.status === 'declined' ? 'You declined this request.' : 'There is no pending location request for your current shift.';
      } catch {
        if (hasLink) {
          panel.hidden = false;
          actions.hidden = true;
          status.textContent = 'Could not load location requests. Refresh GLASSPRO to try again.';
        }
      } finally { loading = false; }
    }

    async function respond(allow) {
      if (busy || !current) return;
      const employeeId = getUser()?.auth_user_id;
      if (!employeeId) return;
      const id = current.id;
      busy = share.disabled = decline.disabled = true;
      status.textContent = allow ? 'Getting a fresh location…' : 'Saving your response…';
      try {
        const parameters = {p_request_id:id, p_share:allow};
        if (allow) {
          const position = await GP_GEO.capture();
          if (position.status !== 'available') throw Error(GP_GEO.messages[position.status] + '. Try again or decline.');
          Object.assign(parameters, {p_latitude:position.latitude, p_longitude:position.longitude, p_accuracy_m:position.accuracy});
        }
        if (employeeId !== getUser()?.auth_user_id) return;
        const {error} = await client.rpc('gp_respond_live_location', parameters);
        if (error) throw error;
        current = null;
        status.textContent = allow ? `Location shared · ${GP_GEO.accuracyLabel(parameters.p_accuracy_m)}` : 'Request declined.';
        actions.hidden = true;
        prompt.textContent = '';
      } catch (error) {
        status.textContent = error.message || 'Could not send your response. Try again.';
      } finally { busy = share.disabled = decline.disabled = false; }
    }

    share.onclick = () => respond(true);
    decline.onclick = () => respond(false);
    panel.refreshLocationRequest = refresh;
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('focus', refresh);
    setInterval(refresh, 60000);
    void refresh();
  }

  function mountAdmin({client, getUser}) {
    const dialog = document.createElement('dialog');
    dialog.id = 'gpLocationRequestDialog';
    dialog.className = 'gp-live-correction-dialog';
    dialog.setAttribute('aria-labelledby', 'gpLocationRequestHeading');
    dialog.innerHTML = `
      <h2 id="gpLocationRequestHeading">Request current location</h2>
      <strong data-employee></strong>
      <p>The employee can share one current reading or decline. Requests expire after 10 minutes.</p>
      <p data-result></p>
      <a class="map-link" data-map target="_blank" rel="noopener noreferrer" hidden>View shared location on map</a>
      <p class="gp-live-correction-status" data-status role="status"></p>
      <div class="gp-clock-dialog-actions gp-location-actions">
        <button type="button" data-refresh>Refresh status</button>
        <button type="button" data-close>Close</button>
        <button type="button" data-send class="gp-live-correction-apply">Send request</button>
      </div>`;
    document.body.append(dialog);
    const status = dialog.querySelector('[data-status]');
    const result = dialog.querySelector('[data-result]');
    const link = dialog.querySelector('[data-map]');
    const send = dialog.querySelector('[data-send]');
    const refreshButton = dialog.querySelector('[data-refresh]');
    const closeButton = dialog.querySelector('[data-close]');
    let selected, busy = false;

    async function refresh() {
      const shown = selected;
      send.disabled = refreshButton.disabled = true;
      try {
        const current = await readRequest(client, shown.employeeId);
        if (selected !== shown) return;
        const request = Number(current?.session_started_at_ms) === shown.shiftStart ? current : null;
        const pending = request?.status === 'pending' && Date.parse(request.expires_at) > Date.now();
        const locked = Date.parse(request?.requested_at) > Date.now() - 120000;
        link.hidden = request?.status !== 'shared';
        if (request?.status === 'shared') {
          link.href = 'https://www.google.com/maps?q=' + encodeURIComponent(GP_GEO.coordinates(request));
          result.textContent = `Shared at ${stamp(request.responded_at)} · ${GP_GEO.accuracyLabel(request.accuracy_m)}`;
        } else if (request?.status === 'declined') {
          result.textContent = `Declined at ${stamp(request.responded_at)}.`;
        } else {
          result.textContent = pending ? `Awaiting response · expires at ${stamp(request.expires_at)}`
            : request ? 'The last request expired.' : 'No location request for this shift.';
        }
        send.disabled = busy || pending || locked;
      } catch (error) {
        if (selected === shown) status.textContent = error.code === '42P01' || error.code === 'PGRST205'
          ? 'Run the live location requests SQL update first.' : error.message || 'Could not refresh the request.';
      } finally { if (selected === shown) refreshButton.disabled = false; }
    }

    closeButton.onclick = () => dialog.close();
    dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
    dialog.addEventListener('close', () => { selected = null; });
    refreshButton.onclick = () => refresh();
    send.onclick = async () => {
      if (!selected || busy || getUser()?.perm_admin !== true) return;
      const shown = selected;
      busy = send.disabled = closeButton.disabled = refreshButton.disabled = true;
      status.textContent = 'Sending the request…';
      try {
        const {data, error} = await client.rpc('gp_request_live_location',
          {p_employee_id:shown.employeeId, p_expected_start_ms:shown.shiftStart});
        if (error) throw error;
        status.textContent = data.created ? 'Request posted in GLASSPRO.' : 'A request is already waiting for a response.';
        if (data.created) {
          try {
            const receipt = await GP_PUSH.sendLocation(client, data.id);
            status.textContent += receipt.accepted > 0 ? ' Push alert accepted by the notification service.' :
              ' Push was unavailable on the employee’s devices.';
          } catch { status.textContent += ' The push alert could not be sent.'; }
        }
      } catch (error) {
        status.textContent = error.message || 'The request could not be sent.';
      } finally {
        busy = closeButton.disabled = false;
        if (selected === shown) await refresh();
      }
    };
    setInterval(() => { if (selected && !busy && !document.hidden && !refreshButton.disabled) void refresh(); }, 60000);
    document.addEventListener('click', event => {
      const button = event.target.closest('[data-location-request-user]');
      if (!button || busy || dialog.open || getUser()?.perm_admin !== true) return;
      selected = {employeeId:button.dataset.locationRequestUser, shiftStart:Number(button.dataset.locationRequestStart)};
      dialog.querySelector('[data-employee]').textContent = button.closest('tr').cells[0].textContent;
      link.hidden = true;
      result.textContent = 'Checking the last request…';
      status.textContent = '';
      dialog.showModal();
      void refresh();
    });
  }

  window.GP_LOCATION_REQUESTS = Object.freeze({mountEmployee, mountAdmin});
})();
