const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { mkdirSync } = require('node:fs');

const port = 8787;
const base = 'http://127.0.0.1:' + port;
const fixture = require('./fixtures/clock-browser-mock.cjs') + String.raw`
(() => {
  const original = window.supabase.createClient;
  const row = {quote_number:810,customer_name:'Sample storefront',module:'Commercial',
    status:'open',quote_date:'11/25/2026',total:245,parts:[{desc:'Storefront door panel'}],call_data:{}};
  const photo = {id:'11111111-0000-4000-8000-000000000000',updated_at:'2026-11-25T12:00:00Z'};
  const stop = {id:'22222222-0000-4000-8000-000000000000',updated_at:'2026-11-25T12:00:00Z'};
  const uploads = [];
  const intakes = [];
  const stops = [];
  const replies = [];
  const exceptions = [];
  const snapshot = {quote_number:810,customer:'Sample storefront',expires_at:'2026-12-09T12:00:00Z',
    options:[{label:'Glass panel',description:'Replace the storefront panel',amount:'245'}],replies};
  const modes = JSON.parse(localStorage.getItem('workspaceTestModes') ||
    '{"photo_intake":"off","quote_links":"off","dispatch":"off","job_search":"off"}');
  window.__calls = [];
  window.supabase.createClient = () => {
    const client = original();
    const {from,rpc} = client;
    client.from = table => {
      const rows = {outstanding_quotes:[row],gp_photo_intakes:intakes,gp_dispatch_stops:stops}[table];
      if (!rows) return from(table);
      let offset=0;
      const chain = {select:()=>chain,order:()=>chain,limit:()=>chain,eq:()=>chain,lt:()=>chain,gt:()=>chain,
        range:start=>{offset=start;return chain;},then:(resolve,reject)=>Promise.resolve({data:offset?[]:rows,error:null}).then(resolve,reject)};
      return chain;
    };
    client.rpc = async (name,args) => {
      window.__calls.push({name,args});
      let data;
      switch(name) {
        case 'gp_workspace_permissions':
          if (window.__workspaceMigrationMissing) return {data:null,error:{code:'PGRST202',message:'Could not find the function in the schema cache'}};
          data={features:modes,exceptions,staff:[{id:1,name:'Test Administrator',admin:true}]};break;
        case 'gp_workspace_features': data=Object.fromEntries(Object.entries(modes).map(([key,value])=>[key,value!=='off']));break;
        case 'gp_set_workspace_permission':
          if (args.p_employee_id) {
            const idx=exceptions.findIndex(e=>e.feature===args.p_feature && e.employee_id===args.p_employee_id);
            if(idx>=0) exceptions.splice(idx,1);
            if(args.p_value!=='inherit') exceptions.push({feature:args.p_feature,employee_id:args.p_employee_id,allowed:args.p_value==='allow'});
          } else {
            modes[args.p_feature]=args.p_value;
            localStorage.setItem('workspaceTestModes',JSON.stringify(modes));
          }
          break;
        case 'gp_quote_link_staff': data=[];break;
        case 'gp_publish_quote_link': data='a'.repeat(64);break;
        case 'gp_customer_quote':
          if(args.p_token!=='a'.repeat(64)) { data=null;break; }
          if(args.p_action==='question') replies.push({kind:'question',body:args.p_body,created_at:'2026-11-25T15:00:00Z'});
          if(args.p_action==='approve') replies.push({kind:'approval',body:args.p_body,approved_option:args.p_option,created_at:'2026-11-25T16:00:00Z'});
          data=args.p_action==='photo'?{photo_path:'sample.jpg'}:snapshot;break;
        case 'gp_save_photo_intake': data={...photo,...args.p_fields};intakes.push(data);break;
        case 'gp_save_dispatch_stop': data={...stop,...args.p_fields};stops.push(data);break;
        case 'gp_search_past_jobs': data=[{source:'quote',reference:'810',title:'Storefront door',summary:'Tempered panel',occurred_on:'2026-11-25'}];break;
        default: return rpc(name,args);
      }
      return {data,error:null};
    };
    client.storage={from:()=>({
      upload:async (path,blob)=>{uploads.push(path);window.__photoBlob=blob;return {data:{path},error:null};},
      createSignedUrl:async ()=>({data:{signedUrl:URL.createObjectURL(window.__photoBlob)},error:null}),
      remove:async()=>({data:[],error:null})
    })};
    client.functions={invoke:async ()=>({data:{draft:'Visible panel damage. Ask about the site visit.'},error:null})};
    return client;
  };
})();
`;

(async () => {
  const server = spawn('python3',['-m','http.server',String(port),'--bind','127.0.0.1'],{stdio:'ignore'});
  let browser;
  try {
    for (let attempt=0;attempt<40;attempt++) {
      try { await fetch(base+'/review-quote.html'); break; }
      catch { await new Promise(resolve=>setTimeout(resolve,100)); }
    }
    browser = await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
    const context = await browser.newContext({viewport:{width:1350,height:900}});
    await context.addInitScript(()=>{window.__testRole='admin';});
    await context.route('https://**/*',route=>{
      if (route.request().url().includes('@supabase/supabase-js@2')) return route.fulfill({contentType:'application/javascript',body:fixture});
      if (route.request().url().includes('tile.openstreetmap.org')) return route.fulfill({
        contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZioAAAAASUVORK5CYII=','base64')
      });
      return route.fulfill({contentType:'application/javascript',body:'window.lucide={createIcons(){}};window.tailwind={};window.Papa={parse(){}};'});
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror',error=>errors.push(error.message));
    page.on('dialog',dialog=>dialog.accept());
    await page.goto(base+'/quotes.html?quote=810');
    await page.locator('#modalQuoteNumber').filter({hasText:'#810'}).waitFor();
    assert.equal(await page.locator('#gpCallbackQuoteLink').isVisible(),false);
    assert.equal(await page.locator('#gpCallbackPhotoIntake').isVisible(),false);

    await page.goto(base+'/admin.html#adminUsersPane');
    const settings = page.locator('#gpWidgetUserEditor #gpWorkspacePermissions');
    await settings.locator(':scope > summary').waitFor();
    assert.equal(await settings.getAttribute('open'),null);
    await page.evaluate(()=>{window.__workspaceMigrationMissing=true;});
    await settings.locator(':scope > summary').click();
    await settings.getByRole('status').filter({hasText:'20261125152759_workspace_features.sql'}).waitFor();
    assert.equal(await settings.getByRole('heading',{name:'Employee override'}).isVisible(),false);

    await page.evaluate(()=>{window.__workspaceMigrationMissing=false;});
    await settings.getByRole('button',{name:'Reload settings'}).click();
    await settings.getByText('Select Edit beside an employee', {exact:false}).waitFor();
    assert.equal(await settings.getByRole('button',{name:'Save employee override'}).isVisible(),false);
    await page.locator('#adminUsersTable tr').filter({hasText:'Test Administrator'}).getByRole('button',{name:'Edit',exact:true}).click();
    await settings.getByText('Editing feature access for Test Administrator.',{exact:false}).waitFor();
    assert.equal(await settings.locator('select[name=employee]').count(),0);
    await settings.getByLabel('Access',{exact:true}).selectOption('deny');
    await settings.getByRole('button',{name:'Save employee override'}).click();
    await settings.getByRole('status').filter({hasText:'Feature override saved for Test Administrator.'}).waitFor();
    const override = await page.evaluate(()=>window.__calls.find(call=>call.name==='gp_set_workspace_permission').args);
    assert.deepEqual(override,{p_feature:'photo_intake',p_value:'deny',p_employee_id:1});
    await settings.getByLabel('Access',{exact:true}).selectOption('inherit');
    await settings.getByRole('button',{name:'Save employee override'}).click();
    await settings.getByRole('status').filter({hasText:'Feature override saved for Test Administrator.'}).waitFor();
    await page.getByRole('button',{name:'Save Employee Account',exact:true}).click();
    await page.getByText('Employee Auth profile updated',{exact:true}).waitFor();
    await settings.getByText('Editing feature access for Test Administrator.',{exact:false}).waitFor();
    await settings.getByText('Company-wide feature release',{exact:true}).click();
    for (const feature of ['Photo-to-quote','Customer quote links','Dispatch map','Past-job search']) {
      const featureRow = settings.locator('.gpw-form-row').filter({hasText:feature});
      await featureRow.locator('select').selectOption('admins');
      await featureRow.getByRole('button').click();
      await settings.getByRole('status').filter({hasText:feature+' release mode saved.'}).waitFor();
    }
    mkdirSync('test-results',{recursive:true});
    await settings.screenshot({path:'test-results/workspace-permissions.png'});
    await page.getByRole('button',{name:'Clear Form',exact:true}).click();
    await settings.getByText('Select Edit beside an employee',{exact:false}).waitFor();
    assert.equal(await settings.getByRole('button',{name:'Save employee override'}).isVisible(),false);

    await page.goto(base+'/quotes.html?quote=810');
    await page.locator('#gpCallbackQuoteLink').click();
    let modal = page.locator('dialog[open]').last();
    await modal.getByLabel('Description for customer').fill('Replace the storefront door panel');
    await modal.getByRole('button',{name:'Publish link'}).click();
    const url = await modal.getByLabel('Customer link').inputValue();
    assert.equal(url,base+'/review-quote.html#'+'a'.repeat(64));
    await modal.getByRole('button',{name:'Close',exact:true}).click();

    await page.locator('#gpCallbackPhotoIntake').click();
    modal = page.locator('dialog[open]').last();
    await modal.getByRole('button',{name:'New intake'}).click();
    const imgBytes = await page.evaluate(()=>{
      const canvas=document.createElement('canvas');
      canvas.width=400;canvas.height=230;
      const ctx=canvas.getContext('2d');
      ctx.fillStyle='#778899';ctx.fillRect(0,0,400,230);
      ctx.strokeStyle='white';ctx.beginPath();ctx.moveTo(40,30);ctx.lineTo(320,190);ctx.stroke();
      return canvas.toDataURL('image/png').split(',')[1];
    });
    const image = {name:'sample.png',mimeType:'image/png',buffer:Buffer.from(imgBytes,'base64')};
    await modal.getByLabel('Job title').fill('Storefront repair');
    await modal.getByLabel('Site photo').setInputFiles(image);
    await modal.getByLabel('Marker label').fill('Driver-side pane');
    await modal.getByRole('img').click({position:{x:110,y:76}});
    await modal.getByRole('button',{name:'Draft site checklist'}).click();
    await modal.getByRole('button',{name:'Draft from photo with AI'}).click();
    await modal.getByRole('status').filter({hasText:'Draft added'}).waitFor();
    assert.match(await modal.getByLabel('Observations and questions').inputValue(),/Driver-side pane/);
    await modal.getByRole('button',{name:'Save intake'}).click();
    await modal.getByRole('status').filter({hasText:'Intake saved'}).waitFor();
    const saved = await page.evaluate(()=>window.__calls.find(call=>call.name==='gp_save_photo_intake').args.p_fields);
    assert.equal(saved.markup[0].label,'Driver-side pane');

    await page.goto(base+'/commissions.html');
    await page.getByRole('button',{name:'Search past jobs'}).click();
    modal = page.locator('dialog[open]').last();
    await modal.getByRole('searchbox').fill('Have we replaced a storefront door before?');
    await modal.getByRole('button',{name:'Search',exact:true}).click();
    await modal.getByText('Tempered panel').waitFor();
    assert.equal(await page.evaluate(()=>window.__calls.find(call=>call.name==='gp_search_past_jobs').args.p_query),'storefront door');
    await modal.getByRole('button',{name:'Close',exact:true}).click();
    await page.getByRole('button',{name:'Dispatch map'}).click();
    modal = page.locator('dialog[open]').last();
    await modal.getByRole('button',{name:'Schedule a stop'}).click();
    await modal.getByLabel('Job or stop title').fill('Emergency site check');
    await modal.getByLabel('Site address').fill('Synthetic Valdosta site');
    await modal.getByLabel('Crew',{exact:true}).fill('North');
    await modal.getByLabel('Stop type').selectOption('emergency');
    await modal.locator('.gpw-map').click({position:{x:150,y:100}});
    await modal.getByRole('button',{name:'Save stop'}).click();
    await modal.getByRole('status').filter({hasText:'Dispatch stop saved.'}).waitFor();
    await modal.getByRole('heading',{name:/Emergency site check/}).waitFor();

    const customer = await context.newPage();
    await customer.setViewportSize({width:390,height:844});
    customer.on('pageerror',error=>errors.push(error.message));
    customer.on('dialog',dialog=>dialog.accept());
    await customer.goto(url);
    await customer.getByRole('heading',{name:'Quote #810'}).waitFor();
    await customer.getByLabel('Your question').fill('Can you install next week?');
    await customer.getByRole('button',{name:'Send question'}).click();
    await customer.getByText('Can you install next week?').waitFor();
    await customer.getByLabel('Option to approve').selectOption('0');
    await customer.getByLabel('Your full name').fill('Example Customer');
    await customer.getByRole('button',{name:'Approve selected option'}).click();
    await customer.getByText('Approval received for Glass panel.',{exact:false}).waitFor();
    await customer.getByLabel('Send a photo of the job site or damage').setInputFiles(image);
    await customer.getByRole('button',{name:'Upload photo'}).click();
    await customer.getByRole('status').filter({hasText:'Your photo was sent.'}).waitFor();
    assert(await customer.evaluate(()=>document.documentElement.scrollWidth <= innerWidth));
    await customer.screenshot({path:'test-results/customer-quote-mobile.png',fullPage:true});
    assert.deepEqual(errors,[]);
    console.log('PASS: employee gates, release controls, photo intake, customer quote, dispatch and past-job search');
  } finally {
    await browser?.close();
    server.kill();
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
