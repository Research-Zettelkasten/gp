/* Team notification delivery. The worker deliberately has no fetch handler. */
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

const home = new URL('home.html', self.registration.scope);
const icon = new URL('icons/glasspro-192.png', self.registration.scope).href;
const announcementId = value => typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value) ? value : '';

self.addEventListener('push', event => {
  let payload;
  try { payload = event.data?.json(); } catch { /* Display the generic notice. */ }
  const id = announcementId(payload?.announcementId);
  event.waitUntil(self.registration.showNotification('GLASSPRO', {
    body: 'A new team announcement is available. Open GLASSPRO to read it.',
    icon,
    tag: id ? 'gp-announcement-' + id : 'gp-announcement',
    data: {announcementId:id}
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = new URL(home);
  target.hash = 'gpHomeAnnouncements';
  const id = announcementId(event.notification.data?.announcementId);
  if (id) target.searchParams.set('announcement',id);
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({type:'window', includeUncontrolled:true});
    const existing = windows.find(client => {
      const current = new URL(client.url);
      return current.origin === home.origin && current.pathname === home.pathname;
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
