const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.join(__dirname, '..');
const id = '80000000-0000-0000-0000-000000000001';
function worker(windows = [], notices = []) {
  const events = new Map(), results = [];
  const self = {
    addEventListener(name, callback) { events.set(name, callback); },
    registration:{
      scope:'https://portal.example/ops/',
      async showNotification(title, options) { results.push({title,options}); },
      async getNotifications() { return notices; }
    },
    clients:{
      async matchAll() { return windows; },
      async openWindow(url) { results.push(url); }
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(root,'gp-push-sw.js'),'utf8'),{self,URL});
  return {events,results, async event(name, data) {
    let pending;
    events.get(name)({...data,waitUntil: promise => {pending=promise;}});
    await pending;
  }};
}
test('only a generic notification and an in-app announcement link are exposed', async () => {
  const app = worker();
  await app.event('push',{data:{json:()=>({announcementId:id,body:'Private content',url:'https://elsewhere.example/'})}});
  const notice = app.results[0];
  assert.equal(notice.title,'GLASSPRO');
  assert.equal(notice.options.tag,'gp-announcement-'+id);
  assert.match(notice.options.body,/Open GLASSPRO/);
  assert.doesNotMatch(notice.options.body,/Private content/);
  await app.event('notificationclick',{notification:{data:{announcementId:id},close(){}}});
  assert.equal(app.results[1],'https://portal.example/ops/home.html?announcement='+id+'#gpHomeAnnouncements');
  assert.equal(app.events.has('fetch'),false);
});
test('all shared app pages use fresh static icon files and the same manifest', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root,'glasspro.webmanifest'),'utf8'));
  assert.equal(manifest.display,'standalone');
  assert.equal(manifest.start_url,'./home.html');
  for (const size of [180,192,512]) {
    const bytes = fs.readFileSync(path.join(root,`icons/glasspro-${size}.png`));
    assert.equal(bytes.readUInt32BE(16),size);
    assert.equal(bytes.readUInt32BE(20),size);
  }
  for (const name of ['home','index','safety','fleet','admin','collections','customers','quotes','commissions']) {
    const page = fs.readFileSync(path.join(root,name+'.html'),'utf8');
    assert.match(page,/rel="manifest" href="glasspro\.webmanifest/);
    assert.match(page,/rel="apple-touch-icon" sizes="180x180" href="icons\/glasspro-180\.png/);
  }
});

test('location push only opens the consent prompt on GLASSPRO', async () => {
  const app = worker();
  await app.event('push',{data:{json:()=>({locationRequestId:id, announcementId:id, latitude:30.83, longitude:-83.28,
    preview:{title:'Private',body:'Private content'}})}});
  const notice = app.results[0];
  assert.equal(notice.options.tag,'gp-location-' + id);
  assert.match(notice.options.body,/Open GLASSPRO to respond/);
  assert.doesNotMatch(JSON.stringify(notice),/30\.83|83\.28/);
  assert.doesNotMatch(JSON.stringify(notice),/Private/);
  await app.event('notificationclick',{notification:{data:{locationRequestId:id},close(){}}});
  assert.equal(app.results[1],'https://portal.example/ops/index.html?locationRequest='+id+'#gpLiveLocation');
});

test('optional previews show the announcement title and text and reopen the full message', async () => {
  const app = worker();
  const preview = {title:'Shop opening',body:'Please arrive at 9 a.m. tomorrow.'};
  const expiresAt = Date.now() + 60000;
  await app.event('push',{data:{json:()=>({announcementId:id, preview, expiresAt})}});
  const notice = app.results[0];
  assert.equal(notice.title,preview.title);
  assert.equal(notice.options.body,preview.body);
  assert.equal(notice.options.data.expiresAt,expiresAt);
  await app.event('notificationclick',{notification:{data:notice.options.data,close(){}}});
  assert.equal(app.results[1],'https://portal.example/ops/home.html?announcement='+id+'#gpHomeAnnouncements');
});

test('the worker clears expired announcement banners and skips overdue pushes', async () => {
  const now = Date.now();
  const closed = [];
  const app = worker([], [
    {tag:'gp-announcement-old',data:{expiresAt:now-1000},close:()=>closed.push('expired')},
    {tag:'gp-announcement-active',data:{expiresAt:now+60000},close:()=>closed.push('active')},
    {tag:'gp-location-request',data:{expiresAt:now-1000},close:()=>closed.push('location')}
  ]);
  await app.event('message',{data:{type:'gp-clear-expired-announcements'}});
  assert.deepEqual(closed,['expired']);
  await app.event('push',{data:{json:()=>({announcementId:id, expiresAt:now-1000})}});
  assert.equal(app.results.length,0);
});
