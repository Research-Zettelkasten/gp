const {chromium}=require('playwright'),assert=require('node:assert/strict'),fs=require('node:fs'),{spawn}=require('node:child_process');
const base='http://127.0.0.1:8771';
const mock=require('./fixtures/clock-browser-mock.cjs')+String.raw`
(()=>{
 const create=window.supabase.createClient;
 const uid=window.__testRole==='admin'?'11111111-1111-4111-8111-111111111111':'22222222-2222-4222-8222-222222222222';
 const locationId='50000000-0000-4000-8000-000000000001',locationKey='__live_location',lunchKey='__employee_lunch_request';
 window.__menuWrites=[];window.__directCorrections=[];window.__lunchCorrections=[];
 window.supabase.createClient=()=>{
  const client=create(),from=client.from,rpc=client.rpc;
  client.from=table=>{
   if(table==='gp_lunch_requests'){
    const current=JSON.parse(localStorage.getItem(lunchKey)||'null');
    let status;
    const q={select(){return q;},eq(key,value){if(key==='status')status=value;return q;},order(){return q;},async limit(){
      return {data:current && (!status || current.status===status)?[current]:[],error:null};
    }};return q;
   }
   if(table==='gp_live_location_requests'){
    const q={select(){return q;},eq(){return q;},async maybeSingle(){
      return {data:JSON.parse(localStorage.getItem(locationKey)||'null'),error:null};
    }};return q;
   }
   if(table!=='gp_navigation_preferences')return from(table);
   const q={select(){return q;},eq(){return q;},async maybeSingle(){
    if(window.__deferNavRead){await new Promise(resolve=>window.__releaseNavRead=resolve);}
    const prefs=JSON.parse(localStorage.getItem('__menuCloud_'+uid)||'null');
    return{data:prefs?{preferences:prefs}:null,error:null};
   }};return q;
  };
  client.rpc=async(name,args)=>{
   if(name==='gp_request_lunch_change'){
    const {employee_name,started_at,lunch_out_at,lunch_in_at,break_minutes}=window.__active;
    localStorage.setItem(lunchKey,JSON.stringify({id:700,employee_name,shift_start:started_at,
      previous_lunch:{out:lunch_out_at,back:lunch_in_at,minutes:break_minutes},
      requested_out:args.p_lunch_out,requested_back:args.p_lunch_back,reason:args.p_reason,status:'pending'}));
    return{data:700,error:null};
   }
   if(name==='gp_review_lunch_change'){
    const request=JSON.parse(localStorage.getItem(lunchKey));
    request.status=args.p_approve?'approved':'rejected';request.review_note=args.p_note;
    localStorage.setItem(lunchKey,JSON.stringify(request));
    return{error:null};
   }
   if(name==='gp_request_live_location'){
    localStorage.setItem(locationKey,JSON.stringify({id:locationId,
      session_started_at_ms:args.p_expected_start_ms,requester_name:'Test Administrator',
      requested_at:new Date().toISOString(),expires_at:new Date(Date.now()+600000).toISOString(),status:'pending'}));
    return{data:{id:locationId,created:true},error:null};
   }
   if(name==='gp_respond_live_location'){
    const current=JSON.parse(localStorage.getItem(locationKey));
    if(current?.id!==args.p_request_id)return{error:{message:'Request changed'}};
    Object.assign(current,{status:args.p_share?'shared':'declined',responded_at:new Date().toISOString(),
      latitude:args.p_latitude,longitude:args.p_longitude,accuracy_m:args.p_accuracy_m});
    localStorage.setItem(locationKey,JSON.stringify(current));
    return{error:null};
   }
   if(name==='gp_save_navigation_preferences'){
    if(window.__offlineMenu)return{data:null,error:{code:'PGRST202',message:'Synthetic unavailable sync'}};
    window.__menuWrites.push(args);localStorage.setItem('__menuCloud_'+uid,JSON.stringify(args.p_preferences));
    return{data:args.p_preferences,error:null};
   }
   if(name==='gp_admin_correct_live_clock_in'){
    if(window.__failLiveCorrection)return{data:null,error:{message:'Synthetic correction save failure'}};
    window.__directCorrections.push(args);window.__active.approved_clock_in_at=args.p_requested_at;
    return{data:{applied_to:'active_shift',request_id:700},error:null};
   }
   if(name==='gp_admin_correct_live_lunch'){
    if(window.__failLunchCorrection)return{data:null,error:{message:'Lunch punches changed while you were editing.'}};
    window.__lunchCorrections.push(args);
    Object.assign(window.__active,{lunch_out_at:args.p_lunch_out,lunch_in_at:args.p_lunch_back,break_minutes:0});
    const minutes=GP_CLOCK.preview(window.__active).breakMinutes;
    if(args.p_lunch_back)window.__active.break_minutes=minutes;
    return{data:{ok:true,break_minutes:window.__active.break_minutes},error:null};
   }
   return rpc(name,args);
  };
  client.functions={invoke:async (name,{body})=>{
   window.__lastNotification=body;
   return{data:body.action==='location'?{accepted:1}:{configured:false},error:null};
  }};
  return client;
 };
})();`;
const pause=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 const server=spawn('python3',['-m','http.server','8771','--bind','127.0.0.1'],{stdio:'ignore'});let browser,page;
 try{
  for(let n=0;n<40;n++){try{await fetch(base+'/home.html');break;}catch{await pause(100);}}
  browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  const context=await browser.newContext({viewport:{width:1440,height:1100},timezoneId:'America/New_York'});
  await context.addInitScript(()=>{
    let next;
    Object.defineProperty(navigator,'geolocation',{value:{
      watchPosition(success){
        window.__gpsReadings=(window.__gpsReadings||0)+1;
        next=setTimeout(()=>success({timestamp:Date.now(),coords:{latitude:30.83344,longitude:-83.28877,accuracy:14}}),10);
        return next;
      },
      clearWatch(id){clearTimeout(id);}
    }});
  });
  await context.route('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2',r=>r.fulfill({contentType:'application/javascript',body:mock}));
  await context.route('https://fonts.googleapis.com/**',r=>r.fulfill({contentType:'text/css',body:''}));
  await context.route('https://cdnjs.cloudflare.com/**',r=>r.fulfill({contentType:'application/javascript',body:'window.Papa={parse(){}};'}));
  const errors=[];page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base+'/home.html');await page.locator('body.gp-shell-active').waitFor();
  const editor=page.locator('#gpMenuEditor');
  await page.getByRole('button',{name:'Customize menu',exact:true}).click();
  assert.equal(await editor.locator('[data-menu-item]').count(),3,'only assigned employee tools can be customized');
  assert.equal(await editor.locator('[data-menu-item="navLinkAdmin"]').count(),0);
  await editor.getByRole('button',{name:'Move Safety up',exact:true}).click();
  await editor.locator('[data-menu-control="show-navLinkComm"]').uncheck();
  await editor.locator('[data-menu-control="favorite-navLinkTime"]').check();
  await editor.locator('[data-menu-control="favorite-navLinkSafety"]').check();
  await editor.getByRole('button',{name:'Save menu',exact:true}).click();await editor.waitFor({state:'hidden'});
  await page.locator('#gpNavSaveStatus').filter({hasText:'saved to your account'}).waitFor();
  assert.equal(await page.locator('#navLinkComm').isVisible(),false);
  assert.deepEqual(await page.locator('.gp-side-favorites .gp-side-title').allTextContents(),['Time Clock','Safety']);
  assert.equal(await page.evaluate(()=>window.__menuWrites.at(-1).p_expected_user),'22222222-2222-4222-8222-222222222222');
  await page.reload();await page.locator('body.gp-shell-active').waitFor();assert.equal(await page.locator('#navLinkComm').isVisible(),false,'hidden choice survives reload');
  await page.goto(base+'/index.html');await page.locator('#btnClockOut').waitFor({state:'visible'});
  assert.equal(await page.locator('#navLinkComm').isVisible(),false,'personal menu follows navigation between pages');
  await page.getByRole('button',{name:'Customize menu',exact:true}).click();
  await editor.locator('[data-menu-control="show-navLinkTime"]').uncheck();await editor.locator('[data-menu-setting="favoritesOnly"]').check();
  await editor.getByRole('button',{name:'Save menu',exact:true}).click();await editor.waitFor({state:'hidden'});
  assert.equal(await page.locator('#navLinkTime').isVisible(),true,'current tool remains available even when hidden');
  await page.getByRole('searchbox').fill('commissions');assert.equal(await page.locator('#navLinkComm').isVisible(),true,'search can reveal a hidden permitted tool');
  await page.getByRole('searchbox').fill('nothing matches');await page.locator('.gp-search-no-results').waitFor({state:'visible'});
  await page.getByRole('searchbox').fill('');assert.equal(await page.locator('#navLinkComm').isVisible(),false);
  await page.getByRole('button',{name:'Customize menu',exact:true}).click();await editor.getByRole('button',{name:'Restore defaults',exact:true}).click();await editor.getByRole('button',{name:'Cancel',exact:true}).click();
  assert.equal(await page.locator('#navLinkComm').isVisible(),false,'cancel does not save draft menu changes');
  await page.getByRole('button',{name:'Customize menu',exact:true}).click();await editor.getByRole('button',{name:'Restore defaults',exact:true}).click();await editor.getByRole('button',{name:'Save menu',exact:true}).click();
  assert.equal(await page.locator('#navLinkComm').isVisible(),true,'defaults recover hidden tools');

  const admin=await context.newPage();admin.on('pageerror',e=>errors.push(e.message));await admin.addInitScript(()=>window.__testRole='admin');
  await admin.goto(base+'/admin.html#adminTimePane');await admin.locator('[data-correct-clock-user]').first().waitFor({state:'visible'});
  assert.equal(await admin.locator('#navLinkComm').isVisible(),true,'administrator has independent menu preferences');
  assert.equal(await admin.locator('#navLinkAdmin .gp-side-title').textContent(),'Team Management');
  assert.equal(await admin.locator('#gpTeamTabs button').count(),4);
  assert.equal(await admin.locator('.gp-sidebar [data-pane="adminUsersPane"]').count(),0,'four management workflows are consolidated inside the page');
  await admin.locator('#gpTeamTabs').getByRole('button',{name:'People & Access',exact:true}).click();await admin.locator('#adminUsersPane').waitFor({state:'visible'});
  assert.equal(await admin.locator('#navLinkAdmin').getAttribute('aria-current'),'page');
  await admin.locator('#gpTeamTabs').getByRole('button',{name:'Time & Attendance',exact:true}).click();
  const original=await admin.evaluate(()=>window.__active.started_at_ms),beforeHours=Number(await admin.locator('[data-live-hours]').textContent());
  await admin.locator('[data-correct-clock-user]').first().click();await admin.locator('#gpLiveCorrectionApply:not(:disabled)').waitFor();
  await admin.locator('#gpLiveCorrectionTime').fill(await admin.evaluate(()=>GP_CLOCK.localInput(window.__active.started_at_ms-1800000)));
  await admin.locator('#gpLiveCorrectionReason').fill('Verified actual earlier arrival with employee and supervisor.');
  fs.mkdirSync('test-results',{recursive:true});await admin.locator('#gpLiveCorrectionDialog').screenshot({path:'test-results/admin-live-correction-dialog.png',animations:'disabled'});
  await admin.evaluate(()=>window.__failLiveCorrection=true);await admin.getByRole('button',{name:'Apply correction now',exact:true}).click();
  await admin.locator('#gpLiveCorrectionStatus').filter({hasText:'Synthetic correction save failure'}).waitFor();
  assert.equal(await admin.locator('#gpLiveCorrectionReason').inputValue(),'Verified actual earlier arrival with employee and supervisor.');
  assert.equal(await admin.evaluate(()=>window.__active.approved_clock_in_at==null),true);
  await admin.evaluate(()=>window.__failLiveCorrection=false);await admin.getByRole('button',{name:'Apply correction now',exact:true}).click();await admin.locator('#gpLiveCorrectionDialog').waitFor({state:'hidden'});
  assert.equal(await admin.evaluate(()=>window.__directCorrections[0].p_expected_start_ms),original);assert.equal(await admin.evaluate(()=>window.__active.started_at_ms),original);
  await admin.waitForFunction(before=>Number(document.querySelector('[data-live-hours]').textContent)>=before+.49,beforeHours);
  const lunch=admin.locator('#gpLiveLunchDialog'),lunchButton=admin.getByRole('button',{name:'Correct Lunch',exact:true});
  const lunchBefore=await admin.evaluate(()=>({out:window.__active.lunch_out_at,back:window.__active.lunch_in_at}));
  await lunchButton.click();await lunch.locator('#gpLiveLunchApply:not(:disabled)').waitFor();
  assert.equal(await lunch.locator('#gpLiveLunchMode').inputValue(),'complete');
  assert.equal(await lunch.locator('#gpLiveLunchOut').inputValue(),await admin.evaluate(iso=>GP_CLOCK.localInput(Date.parse(iso)),lunchBefore.out));
  const correctedBack=await admin.evaluate(iso=>GP_CLOCK.localInput(Date.parse(iso)+900000),lunchBefore.back);
  await lunch.locator('#gpLiveLunchBack').fill(correctedBack);
  await lunch.locator('.gp-live-correction-preview').filter({hasText:'45 unpaid lunch minutes'}).waitFor();
  await lunch.getByLabel('Reason for correction').fill('Verified the actual return from lunch with the employee.');
  await admin.evaluate(()=>window.__failLunchCorrection=true);await lunch.getByRole('button',{name:'Apply correction now'}).click();
  await lunch.getByRole('status').filter({hasText:'changed while you were editing'}).waitFor();
  assert.equal(await lunch.locator('#gpLiveLunchBack').inputValue(),correctedBack);
  await admin.evaluate(()=>window.__failLunchCorrection=false);await lunch.getByRole('button',{name:'Apply correction now'}).click();
  await lunch.waitFor({state:'hidden'});await admin.locator('#adminActiveTimeTable').getByText('Lunch: 45m').waitFor();
  const lunchSaved=await admin.evaluate(()=>window.__lunchCorrections[0]);
  assert.equal(lunchSaved.p_expected_start_ms,original);
  assert.equal(lunchSaved.p_expected_lunch_back,lunchBefore.back);
  assert.equal(lunchSaved.p_lunch_out,lunchBefore.out);
  assert.equal(await admin.evaluate(()=>window.__active.started_at_ms),original);
  await lunchButton.click();await lunch.locator('#gpLiveLunchApply:not(:disabled)').waitFor();
  await lunch.getByLabel('Lunch status').selectOption('none');
  assert.equal(await lunch.getByLabel('Lunch Out',{exact:true}).isVisible(),false);
  await lunch.getByLabel('Reason for correction').fill('Verified both lunch punches were entered by mistake.');
  await lunch.getByRole('button',{name:'Apply correction now'}).click();await lunch.waitFor({state:'hidden'});
  await admin.locator('#adminActiveTimeTable').getByText('No lunch yet').waitFor();
  await admin.getByRole('button',{name:'Request Location',exact:true}).click();
  const locationDialog=admin.locator('#gpLocationRequestDialog');
  await locationDialog.getByRole('button',{name:'Send request',exact:true}).click();
  await locationDialog.getByRole('status').filter({hasText:'Push alert accepted'}).waitFor();
  const sent=await admin.evaluate(()=>window.__lastNotification);
  assert.equal(sent.action,'location');
  await page.goto(base+'/index.html?locationRequest='+sent.requestId+'#gpLiveLocation');
  const locationPanel=page.locator('#gpLiveLocation');
  await locationPanel.getByText('Test Administrator requested your location.',{exact:false}).waitFor();
  assert.equal(await page.evaluate(()=>window.__gpsReadings||0),0,'no reading before employee consent');
  await locationPanel.getByRole('button',{name:'Share my location',exact:true}).click();
  await locationPanel.getByRole('status').filter({hasText:'Good (±46 ft)'}).waitFor();
  await locationDialog.getByRole('button',{name:'Refresh status',exact:true}).click();
  assert.match(await locationDialog.getByRole('link',{name:'View shared location on map'}).getAttribute('href'),/30.833440%2C-83.288770$/);
  await locationDialog.getByRole('button',{name:'Close',exact:true}).click();
  const requestPane=page.locator('#timeLivePane #gpClockInChange + #gpLunchCorrection');
  const requestToggle=requestPane.locator('summary');
  assert.equal(await requestPane.locator('form').isVisible(),false);
  await requestToggle.click();
  await requestPane.getByLabel('Shift',{exact:true}).selectOption({label:await requestPane.locator('option').first().textContent()});
  assert.equal(await page.locator('#btnClockOut').isVisible(),true);
  assert.equal(await page.locator('#recentTimeTable').isVisible(),true);
  await requestPane.getByLabel('Actual Lunch Back').fill(await page.evaluate(()=>GP_CLOCK.localInput(Date.parse(window.__active.lunch_in_at)+600000)));
  await requestPane.getByLabel('Reason for correction').fill('I returned ten minutes after the recorded time.');
  await requestPane.getByRole('button',{name:'Send Request',exact:true}).click();
  await requestPane.getByText('Pending manager review',{exact:true}).waitFor();
  const lunchReviews=admin.locator('#gpLunchRequestReview');
  await lunchReviews.getByRole('button',{name:'Refresh Requests',exact:true}).click();
  await lunchReviews.getByLabel('Manager review note').fill('Confirmed the actual return time with the employee.');
  await lunchReviews.getByRole('button',{name:'Approve',exact:true}).click();
  await lunchReviews.getByRole('status').filter({hasText:'Approved.'}).waitFor();
  await requestToggle.click();
  await requestToggle.click();
  await requestPane.getByText('Approved · Confirmed the actual return time with the employee.',{exact:true}).waitFor();
  await admin.getByRole('button',{name:'Customize menu',exact:true}).click();
  await admin.locator('[data-menu-control="show-adminMOSPane"]').uncheck();
  const team=admin.locator('[data-menu-item="navLinkAdmin"]');await team.locator('summary').click();await team.getByLabel('Activity History',{exact:true}).uncheck();
  await admin.getByRole('button',{name:'Save menu',exact:true}).click();
  assert.equal(await admin.locator('#gpNav-adminMOSPane').isVisible(),false);assert.equal(await admin.locator('#gpTeamTabs [data-team-pane="adminFleetPane"]').count(),0);
  await admin.getByRole('searchbox').fill('audit');await admin.locator('#navLinkAdmin').click();await admin.locator('#adminFleetPane').waitFor({state:'visible'});
  assert.equal(await admin.locator('#gpTeamTabs [data-team-pane="adminFleetPane"]').getAttribute('aria-pressed'),'true','search can recover a hidden team tab');
  await admin.getByRole('searchbox').fill('');await admin.goto(base+'/admin.html#adminTimePane');await admin.locator('#gpTeamManagement').waitFor({state:'visible'});
  fs.mkdirSync('test-results',{recursive:true});await admin.evaluate(()=>window.scrollTo({top:0,behavior:'instant'}));
  await admin.screenshot({path:'test-results/personal-sidebar-team-desktop.png',fullPage:true,animations:'disabled'});
  await admin.getByRole('button',{name:'Customize menu',exact:true}).click();assert.equal(await admin.locator('.gp-menu-editor-body').evaluate(e=>e.scrollTop),0,'reopening customization starts at its settings');await admin.locator('#gpMenuEditor').screenshot({path:'test-results/personal-menu-editor.png',animations:'disabled'});
  await admin.getByRole('button',{name:'Close menu customization',exact:true}).click();
  await admin.evaluate(()=>GP_UX.setTheme('dark',false));await admin.setViewportSize({width:390,height:844});
  await admin.getByRole('button',{name:'Open GLASSPRO navigation',exact:true}).click();await admin.getByRole('button',{name:'Customize menu',exact:true}).click();
  assert.equal(await admin.locator('body').evaluate(e=>e.classList.contains('gp-nav-open')),false,'mobile menu customization releases the navigation focus trap');
  await admin.locator('#gpMenuEditor').screenshot({path:'test-results/personal-menu-mobile-dark.png',animations:'disabled'});
  await admin.keyboard.press('Escape');assert.equal(await admin.getByRole('button',{name:'Open GLASSPRO navigation',exact:true}).evaluate(e=>e===document.activeElement),true);
  await admin.locator('[data-correct-clock-user]').first().click();await admin.locator('#gpLiveCorrectionApply:not(:disabled)').waitFor();await admin.locator('#gpLiveCorrectionDialog').screenshot({path:'test-results/admin-live-correction-mobile-dark.png',animations:'disabled'});await admin.getByRole('button',{name:'Cancel',exact:true}).click();
  await lunchButton.click();await lunch.locator('#gpLiveLunchApply:not(:disabled)').waitFor();
  assert.equal(await lunch.evaluate(dialog=>dialog.getBoundingClientRect().width<=window.innerWidth),true);
  await lunch.screenshot({path:'test-results/admin-live-lunch-mobile-dark.png',animations:'disabled'});
  await lunch.getByRole('button',{name:'Cancel',exact:true}).click();

  // An old account response must not replace a menu edited while its request was pending.
  const late=await context.newPage();late.on('pageerror',e=>errors.push(e.message));await late.addInitScript(()=>window.__deferNavRead=true);
  await late.goto(base+'/home.html');await late.getByRole('button',{name:'Customize menu',exact:true}).click();
  await late.locator('[data-menu-control="show-navLinkComm"]').uncheck();await late.getByRole('button',{name:'Save menu',exact:true}).click();
  await late.locator('#gpNavSaveStatus').filter({hasText:'saved to your account'}).waitFor();await late.evaluate(()=>window.__releaseNavRead());
  await late.waitForFunction(()=>document.querySelector('#navLinkComm').closest('.gp-side-link-row').classList.contains('gp-personal-hidden'));
  assert.equal(await late.locator('#navLinkComm').isVisible(),false);
  await late.evaluate(()=>window.__offlineMenu=true);await late.getByRole('button',{name:'Customize menu',exact:true}).click();await late.locator('[data-menu-control="show-navLinkComm"]').check();await late.getByRole('button',{name:'Save menu',exact:true}).click();
  await late.locator('#gpNavSaveStatus').filter({hasText:'sync unavailable'}).waitFor();assert.equal(await late.locator('#navLinkComm').isVisible(),true,'browser preferences work before SQL or while offline');
  assert.deepEqual(errors,[]);console.log('PASS: personal menu controls, saved ownership, current-page recovery, team consolidation, direct live correction, failure recovery and responsive focus behavior.');
 }catch(error){if(page){fs.mkdirSync('test-results',{recursive:true});await page.screenshot({path:'test-results/personal-navigation-failure.png',fullPage:true}).catch(()=>{});}throw error;}
 finally{await browser?.close();server.kill();}
})().catch(e=>{console.error(e);process.exitCode=1;});
