(function (root) {
  'use strict';
  const ownerKey = 'gp_push_owner';
  const workerUrl = 'gp-push-sw.js';
  const functionName = 'gp-announcement-push';

  async function request(client, body) {
    const { data, error } = await client.functions.invoke(functionName, {body});
    if (error) {
      const response = await error.context?.json?.().catch(() => null);
      throw Error(response?.error || 'Could not reach the notification service.');
    }
    return data;
  }

  async function readConfig(client) {
    if (!client?.functions?.invoke) return {configured:false};
    try { return await request(client, {action:'config'}); }
    catch { return {configured:false}; }
  }

  async function send(client, announcementId, includePreview = false) {
    let summary;
    for (let batch = 0; batch < 20; batch++) {
      summary = await request(client, {action:'send', announcementId, includePreview});
      if (!summary.queued) return summary;
    }
    return summary;
  }

  function sendLocation(client, requestId) {
    return request(client, {action:'location', requestId});
  }

  function clearExpired(worker = navigator.serviceWorker?.controller) {
    worker?.postMessage?.({type:'gp-clear-expired-announcements'});
  }

  async function detach(client, subscription) {
    if (!subscription) return;
    const results = await Promise.allSettled([
      (async () => {
        const {error} = await client.rpc('gp_remove_push_device', {p_endpoint:subscription.endpoint});
        if (error) throw error;
      })(),
      (async () => {
        if (await subscription.unsubscribe() === false) throw Error('The browser did not confirm removal.');
      })()
    ]);
    if (results.every(result => result.status === 'rejected')) {
      throw Error('Could not turn off push on this device. Try again.');
    }
    try { localStorage.removeItem(ownerKey); } catch { /* Storage may be unavailable. */ }
  }

  async function beforeSignOut(client) {
    if (!navigator.serviceWorker) return;
    const registration = await navigator.serviceWorker.getRegistration();
    if (!registration?.active?.scriptURL.endsWith('/' + workerUrl)) return;
    await detach(client, await registration.pushManager?.getSubscription());
  }

  function applicationKey(encoded) {
    const normalized = encoded.replace(/-/g, '+').replace(/_/g, '/');
    return Uint8Array.from(atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')), value => value.charCodeAt(0));
  }

  async function mount(client, user) {
    const button = document.getElementById('gpPushToggle');
    const status = document.getElementById('gpPushStatus');
    if (!button || !status || !user?.auth_user_id) return;
    const setStatus = message => { status.textContent = message; };
    const panel = button.closest('#gpClockNotifications');
    const showInvitation = () => { if (panel) panel.open = true; };
    const isAppleMobile = /iPhone|iPad|iPod/.test(navigator.userAgent) ||
      (/Mac/.test(navigator.platform) && navigator.maxTouchPoints > 1);
    if (isAppleMobile && !navigator.standalone && !matchMedia('(display-mode: standalone)').matches) {
      showInvitation();
      setStatus('To enable push on iPhone or iPad, add GLASSPRO to your Home Screen in Safari and open it from that icon.');
      return;
    }
    if (!root.isSecureContext || !navigator.serviceWorker || !root.PushManager || !root.Notification) {
      setStatus('This browser does not support Web Push here.');
      return;
    }
    const config = await readConfig(client);
    if (!config?.configured || !config.publicKey) {
      showInvitation();
      setStatus('Device notifications are awaiting GLASSPRO server setup.');
      return;
    }
    try {
      const key = applicationKey(config.publicKey);
      const pending = await navigator.serviceWorker.register(workerUrl);
      const registration = pending.active ? pending : await navigator.serviceWorker.ready;
      clearExpired(registration.active);
      let subscription = await registration.pushManager.getSubscription();
      const storedKey = subscription?.options?.applicationServerKey;
      const changedKey = storedKey && (storedKey.byteLength !== key.length || new Uint8Array(storedKey).some((byte,index) => byte !== key[index]));
      const currentOwner = localStorage.getItem(ownerKey);
      if (subscription && (changedKey || (currentOwner && currentOwner !== user.auth_user_id))) {
        await detach(client, subscription);
        subscription = null;
      }
      let enabled = Boolean(subscription && Notification.permission === 'granted' && currentOwner === user.auth_user_id);
      function showState(message) {
        button.hidden = false;
        button.textContent = enabled ? 'Disable notifications' : 'Enable notifications';
        button.disabled = !enabled && Notification.permission === 'denied';
        setStatus(message || (button.disabled
          ? 'Permission is blocked. Allow notifications in your browser or device settings, then reopen GLASSPRO.'
          : enabled ? 'GLASSPRO notifications are enabled on this device.' : 'Choose Enable notifications, then Allow, to receive team announcements and location requests here.'));
      }
      showState();
      if (!enabled) showInvitation();
      let busy = false;
      button.onclick = async () => {
        if (busy) return;
        busy = true;
        button.disabled = true;
        try {
          if (enabled) {
            await detach(client, subscription);
            subscription = null;
            enabled = false;
            showState('GLASSPRO notifications are off on this device.');
            return;
          }
          if (!subscription) {
            // Begin within the click so Safari can show the permission prompt.
            subscription = await registration.pushManager.subscribe({userVisibleOnly:true, applicationServerKey:key});
          }
          const data = subscription.toJSON();
          const {error} = await client.rpc('gp_save_push_device', {
            p_endpoint:data.endpoint, p_p256dh:data.keys?.p256dh, p_auth_key:data.keys?.auth
          });
          if (error) {
            if (error.code === 'PGRST202') throw Error('The Web Push SQL update is required.');
            throw Error(error.message);
          }
          localStorage.setItem(ownerKey,user.auth_user_id);
          enabled = true;
          showState();
        } catch (error) {
          showState(Notification.permission === 'denied' ? undefined : error.message || 'Notification setup failed. Try again.');
        } finally { busy = false; }
      };
    } catch {
      showInvitation();
      setStatus('Could not prepare notifications on this device. Refresh to try again.');
    }
  }

  root.GP_PUSH = Object.freeze({mount, readConfig, send, sendLocation, beforeSignOut, clearExpired});
})(window);
