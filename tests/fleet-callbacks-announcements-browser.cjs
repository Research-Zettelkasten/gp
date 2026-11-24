const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const PORT = 8773;
const base = 'http://127.0.0.1:' + PORT;

const fixture = require('./fixtures/clock-browser-mock.cjs') + String.raw`
(() => {
  const original = window.supabase.createClient;
  const sample = {
    fleet_vehicles: [
      {id:12,unit_name:'Shop Truck',make:'Sample',model:'Truck',license_plate:'SHOP-1',current_mileage:120,asset_type:'vehicle'},
      {id:13,unit_name:'Haul Trailer',make:'Sample',model:'Trailer',license_plate:'HAUL-1',asset_type:'trailer',tag_expires_on:'2020-11-19'}
    ],
    outstanding_quotes: [
      {quote_number:876,customer_name:'Synthetic Callback',phone:'(229) 555-0100',has_cell:true,status:'open',module:'Auto',quote_date:'11/18/2026',total:200,contact_attempts:0,call_data:{},parts:[]},
      {quote_number:875,customer_name:'Synthetic Overdue',phone:'(229) 555-0110',status:'follow_up',module:'Auto',quote_date:'11/17/2026',total:350,contact_attempts:1,call_data:{expected_answer_date:'2020-11-18'},parts:[]}
    ]
  };
  const stored = JSON.parse(localStorage.getItem('gpFixtureAnnouncements') || '[]');
  sample.gp_announcements = stored;
  window.__fixture = sample;
  window.__uploads = [];
  window.__pushCalls = [];
  window.supabase.createClient = () => {
    const client = original(), from = client.from.bind(client);
    client.from = table => {
      if (!(table in sample)) return from(table);
      const conditions = [];
      let action, payload, offset = 0;
      const result = one => {
        if (offset > 0) return {data:[],error:null};
        let resultRows = sample[table].filter(row => conditions.every(condition => condition(row)));
        if (action === 'insert') {
          const next = Array.isArray(payload) ? payload : [payload];
          resultRows = next.map(row => ({id:100 + sample[table].length,published_at:'2026-11-20T15:00:00Z',...row}));
          sample[table].push(...resultRows);
        } else if (action === 'update') {
          resultRows.forEach(row => Object.assign(row,payload));
        }
        if (action && table === 'gp_announcements') localStorage.setItem('gpFixtureAnnouncements',JSON.stringify(stored));
        return {data:one ? resultRows[0] || null : resultRows,error:null};
      };
      const chain = {
        select:()=>chain, order:()=>chain, limit:()=>chain,
        or:condition=>{
          if (condition.startsWith('recipient_user_id.')) {
            const recipient = condition.split('recipient_user_id.eq.')[1];
            conditions.push(row=>!row.recipient_user_id || row.recipient_user_id===recipient);
          }
          return chain;
        },
        eq:(key,value)=>{conditions.push(row=>String(row[key])===String(value));return chain;},
        is:(key,value)=>{conditions.push(row=>(row[key]??null)===value);return chain;},
        lte:()=>chain, range:start=>{offset=start;return chain;},
        insert:values=>{action='insert';payload=values;return chain;},
        update:values=>{action='update';payload=values;return chain;},
        single:()=>Promise.resolve(result(true)),
        maybeSingle:()=>Promise.resolve(result(true)),
        then:(resolve,reject)=>Promise.resolve(result(false)).then(resolve,reject)
      };
      return chain;
    };
    const existingRpc = client.rpc.bind(client);
    client.rpc = async (name,args) => {
      if (name === 'gp_save_push_device' || name === 'gp_remove_push_device') {
        window.__pushCalls.push({name,args});
        return {data:null,error:null};
      }
      if (name !== 'gp_request_manager_callback') return existingRpc(name,args);
      const quote = sample.outstanding_quotes.find(row=>row.quote_number===args.p_quote_number);
      quote.status = 'admin_review';
      quote.call_data = {...quote.call_data,manager_close_required:true,manager_note:args.p_note,contact_method:args.p_method};
      return {data:quote,error:null};
    };
    client.functions = {invoke:async (name,{body}) => {
      window.__pushCalls.push({name,body});
      if (body.action === 'config') return {data:{configured:true, publicKey:'B'+ 'A'.repeat(86)},error:null};
      return {data:{accepted:1,queued:0,sending:0,retry:0,unavailable:0},error:null};
    }};
    client.storage = {from:()=>({
      list:async id=>({data:window.__uploads.filter(path=>path.startsWith(id+'/')).map(path=>({id:path,name:path.split('/')[1]})),error:null}),
      upload:async path=>{window.__uploads.push(path);return {data:{path},error:null};},
      createSignedUrls:async paths=>({data:paths.map(path=>({path,signedUrl:'/version.json'})),error:null})
    })};
    return client;
  };
})();
`;

(async () => {
  const server = spawn('python3',['-m','http.server',String(PORT),'--bind','127.0.0.1'],{stdio:'ignore'});
  let browser;
  try {
    for (let n=0; n<40; n++) {
      try { await fetch(base+'/home.html'); break; }
      catch { await new Promise(resolve=>setTimeout(resolve,100)); }
    }
    browser = await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
    const context = await browser.newContext();
    await context.addInitScript(() => {
      window.__testRole = 'admin';
      let current = null;
      const endpoint = 'https://web.push.apple.com/synthetic-device';
      const registration = {
        active:{scriptURL:location.origin+'/gp-push-sw.js'},
        pushManager:{
          getSubscription:async () => current,
          subscribe:async options => {
            if (!options.userVisibleOnly || options.applicationServerKey.length !== 65) throw Error('Missing application key');
            if (!navigator.userActivation.isActive) throw Error('Push subscription needs a user interaction');
            current = {
              endpoint,
              toJSON:() => ({endpoint,keys:{p256dh:'A'.repeat(87),auth:'B'.repeat(22)}}),
              unsubscribe:async () => { current = null; return true; }
            };
            return current;
          }
        }
      };
      Object.defineProperty(navigator,'serviceWorker',{value:{
        register:async () => registration,
        getRegistration:async () => registration,
        ready:Promise.resolve(registration)
      }});
    });
    await context.route('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2',route=>route.fulfill({contentType:'application/javascript',body:fixture}));
    await context.route('https://fonts.googleapis.com/**',route=>route.fulfill({contentType:'text/css',body:''}));
    await context.route('https://cdnjs.cloudflare.com/**',route=>route.fulfill({contentType:'application/javascript',body:'window.Papa={parse(){}};'}));
    await context.route('https://unpkg.com/**',route=>route.fulfill({contentType:'application/javascript',body:'window.lucide={createIcons(){}};'}));
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto(base+'/fleet.html#garagePane');
    const truck = page.locator('#fleetGarageTable tr').filter({hasText:'Shop Truck'});
    const trailer = page.locator('#fleetGarageTable tr').filter({hasText:'Haul Trailer'});
    await truck.waitFor();
    assert.match(await trailer.textContent(),/Expired/);
    await page.locator('#fleetAssetFilter').selectOption('trailer');
    assert.equal(await truck.count(),0);
    assert.equal(await page.locator('#garageVehicleSelect option').filter({hasText:'Haul Trailer'}).count(),0);
    await trailer.getByRole('button',{name:'Photos',exact:true}).click();
    await page.locator('#fleetPhotoInput').setInputFiles({name:'fixture.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZioAAAAASUVORK5CYII=','base64')});
    await page.getByRole('button',{name:'Upload photos',exact:true}).click();
    await page.locator('#fleetPhotoStatus').filter({hasText:'1 uploaded'}).waitFor();
    assert.match(await page.evaluate(()=>window.__uploads[0]),/^13\/[a-f0-9-]+\.png$/);
    await page.locator('#fleetPhotoClose').click();
    await trailer.getByRole('button',{name:'Edit',exact:true}).click();
    await page.locator('#garageTagExpiry').fill('2099-11-30');
    await page.getByRole('button',{name:'Save Fleet Unit',exact:true}).click();
    await trailer.filter({hasText:'2099-11-30'}).waitFor();

    await page.goto(base+'/fleet.html#safetyPane');
    await page.waitForURL('**/safety.html',{waitUntil:'domcontentloaded'});
    await page.getByRole('heading',{name:'Workplace safety',exact:true}).waitFor();
    assert.equal(await page.locator('#navLinkSafety').getAttribute('aria-current'),'page');
    assert.equal(await page.locator('#fleetGarageTable').count(),0);

    await page.goto(base+'/quotes.html');
    const rows = page.locator('#quoteTableBody tr');
    await rows.filter({hasText:'Synthetic Callback'}).waitFor();
    assert.match(await rows.first().textContent(),/Synthetic Overdue/);
    await page.locator('#callbackDue').selectOption('overdue');
    assert.equal(await rows.count(),1);
    await page.locator('#callbackResetFilters').click();
    await rows.filter({hasText:'Synthetic Callback'}).click();
    assert.equal(await page.locator('#callbackCall').getAttribute('href'),'tel:2295550100');
    assert.match(await page.locator('#callbackText').getAttribute('href'),/^sms:2295550100\?body=/);
    await page.locator('#callbackEmailAddress').fill('sample@example.test');
    assert.match(await page.locator('#callbackEmail').getAttribute('href'),/^mailto:sample@example.test\?/);
    await page.locator('#callbackScript').selectOption('manager');
    assert.match(await page.locator('#callbackScriptText').textContent(),/manager to review/);
    await page.locator('#callbackManagerNotes').fill('Confirm revised price and preferred call time.');
    await page.locator('#callbackUsedMethod').selectOption('phone');
    await page.locator('#callbackSendToManager').click();
    await page.locator('#callbackModal').waitFor({state:'hidden'});
    assert.equal(await page.evaluate(()=>window.__fixture.outstanding_quotes[0].status),'admin_review');
    await page.locator('#boardStatusFilter').selectOption('MANAGER');
    assert.match(await rows.first().textContent(),/Manager close requested/);

    await page.goto(base+'/admin.html#adminOverviewPane');
    await page.locator('#gpAnnouncementForm [name=title]').fill('Synthetic staff announcement');
    await page.locator('#gpAnnouncementForm [name=body]').fill('An example of a pinned team update.');
    await page.locator('#gpAnnouncementForm [name=pinned]').check();
    await page.getByText('Notify opted-in devices',{exact:true}).waitFor();
    await page.locator('#gpAnnouncementForm [name=notify]').check();
    await page.locator('#gpAnnouncementForm [name=includePreview]').check();
    await page.locator('#gpAnnouncementSave').click();
    await page.locator('#gpAnnouncementStatus').filter({hasText:'1 accepted by push services'}).waitFor();
    const teamPush=await page.evaluate(()=>window.__pushCalls.find(call=>call.body?.action==='send').body);
    assert.equal(teamPush.announcementId,100);
    assert.equal(teamPush.includePreview,true);
    const adminId='11111111-1111-4111-8111-111111111111';
    await page.getByRole('combobox',{name:'Audience',exact:true}).selectOption(adminId);
    await page.locator('#gpAnnouncementForm [name=title]').fill('Synthetic directed announcement');
    await page.locator('#gpAnnouncementForm [name=body]').fill('A message only for this employee.');
    await page.locator('#gpAnnouncementForm [name=notify]').check();
    assert.equal(await page.locator('#gpAnnouncementForm [name=includePreview]').isChecked(),false);
    await page.locator('#gpAnnouncementSave').click();
    await page.locator('#gpAnnouncementList').getByText('Synthetic directed announcement',{exact:true}).waitFor();
    await page.waitForFunction(()=>window.__pushCalls.some(call=>call.body?.announcementId===101));
    assert.equal(await page.evaluate(()=>window.__fixture.gp_announcements.find(item=>item.id===101).recipient_user_id),adminId);
    assert.equal(await page.evaluate(()=>window.__pushCalls.find(call=>call.body?.announcementId===101).body.includePreview),false);
    await page.evaluate(()=>localStorage.setItem('gpFixtureAnnouncements',JSON.stringify([
      ...window.__fixture.gp_announcements,
      {id:102,title:'Different recipient',body:'Another employee only.',recipient_user_id:'22222222-2222-4222-8222-222222222222',published_at:'2026-11-20T15:00:00Z'},
      {id:103,title:'Already expired',body:'Retire this from the Home feed.',expires_at:'2026-11-21T15:00:00Z',published_at:'2026-11-20T15:00:00Z'}
    ])));
    await page.goto(base+'/home.html');
    const announcement = page.locator('#gpHomeAnnouncements');
    await announcement.getByText('Synthetic staff announcement',{exact:true}).waitFor();
    const directed = announcement.locator('article').filter({hasText:'Synthetic directed announcement'});
    await directed.getByText('Just for you',{exact:false}).waitFor();
    assert.equal(await announcement.getByText('Different recipient',{exact:true}).count(),0);
    assert.equal(await announcement.getByText('Already expired',{exact:true}).count(),0);
    assert.match(await announcement.textContent(),/Pinned/);
    await page.getByRole('button',{name:'Enable notifications'}).click();
    await page.getByRole('button',{name:'Disable notifications'}).waitFor();
    assert.equal(await page.evaluate(()=>window.__pushCalls.find(call=>call.name==='gp_save_push_device').args.p_endpoint),
      'https://web.push.apple.com/synthetic-device');
    await page.getByRole('button',{name:'Disable notifications'}).click();
    await page.getByRole('button',{name:'Enable notifications'}).waitFor();
    assert.equal(await page.evaluate(()=>window.__pushCalls.find(call=>call.name==='gp_remove_push_device').args.p_endpoint),
      'https://web.push.apple.com/synthetic-device');
    await page.goto(base+'/index.html');
    const invite = page.locator('#gpClockNotifications');
    await invite.getByRole('button',{name:'Enable notifications',exact:true}).waitFor();
    assert.equal(await invite.evaluate(panel=>panel.open),true,'Time Clock opens the opt-in for a device that has not subscribed');
    assert.equal(await page.evaluate(()=>window.__pushCalls.some(call=>call.name==='gp_save_push_device')),false,
      'loading the invitation does not subscribe the device');
    await invite.getByRole('button',{name:'Enable notifications',exact:true}).click();
    await invite.getByRole('button',{name:'Disable notifications',exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>window.__pushCalls.some(call=>call.name==='gp_save_push_device')),true,'the opt-in click enrolls the device');
    assert.deepEqual(errors,[]);
    console.log('PASS: fleet, Safety, callbacks, announcement push, enrollment and opt-out');
  } finally { await browser?.close(); server.kill(); }
})().catch(error=>{ console.error(error); process.exitCode=1; });
