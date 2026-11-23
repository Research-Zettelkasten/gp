/* Team notification delivery. The worker deliberately has no fetch handler. */
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

const home = new URL('home.html', self.registration.scope);
const clock = new URL('index.html', self.registration.scope);
const icon = new URL('icons/glasspro-192.png', self.registration.scope).href;
const validId = value => typeof value === 'string' && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value) ? value : '';

self.addEventListener('push', event => {
  let payload;
  try { payload = event.data?.json(); } catch { /* Display the generic notice. */ }
  const requestId = validId(payload?.locationRequestId);
  const id = validId(payload?.announcementId);
  event.waitUntil(self.registration.showNotification('GLASSPRO', {
    body: requestId ? 'A location request is waiting. Open GLASSPRO to respond.' : 'A new team announcement is available. Open GLASSPRO to read it.',
    icon,
    tag: requestId ? 'gp-location-' + requestId : id ? 'gp-announcement-' + id : 'gp-announcement',
    data: requestId ? {locationRequestId:requestId} : {announcementId:id}
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const requestId = validId(event.notification.data?.locationRequestId);
  const target = new URL(requestId ? clock : home);
  const id = validId(event.notification.data?.announcementId);
  target.hash = requestId ? 'gpLiveLocation' : 'gpHomeAnnouncements';
  if (requestId) target.searchParams.set('locationRequest',requestId);
  else if (id) target.searchParams.set('announcement',id);
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({type:'window', includeUncontrolled:true});
    const existing = windows.find(client => {
      const current = new URL(client.url);
      return current.origin === target.origin && current.pathname === target.pathname;
    });
    if (existing) {
      try {
        const tab = await existing.navigate(target.href);
        if (tab) return await tab.focus();
      } catch { /* Open a new window if the previous tab closed. */ }
    }
    return self.clients.openWindow(target.href);
  })());
});
