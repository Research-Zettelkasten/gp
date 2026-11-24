const {chromium}=require('playwright'),assert=require('node:assert/strict'),{spawn}=require('node:child_process'),fs=require('node:fs');
const base='http://127.0.0.1:8768',mock=require('./fixtures/clock-browser-mock.cjs')+String.raw`
(()=>{const make=window.supabase.createClient;window.__recoveryCalls=[];
 const employee='22222222-2222-4222-8222-222222222222',legacy={id:501,auth_user_id:employee,employee_name:'Sam Employee',department:'Operations',work_date:'2026-11-19',clock_in:'07:51 AM',clock_out:'05:00 PM',decimal_hours:'8.13',break_minutes:61,notes:'Existing saved timecard',lunch_review_status:'approved'};
 const own=Array.from({length:12},(_,n)=>({id:n+1,auth_user_id:employee,employee_name:'Sam Employee',work_date:n<6?'2026-11-18':'2026-11-19',clock_in:'08:00',clock_out:'09:15',decimal_hours:'1.25',break_minutes:0,lunch_review_status:'not_required'}));own.push({id:80,auth_user_id:employee,employee_name:'Sam Employee',work_date:'2026-11-09',clock_in:'08:00',clock_out:'16:00',decimal_hours:'7.50',break_minutes:30},{id:81,auth_user_id:'33333333-3333-4333-8333-333333333333',employee_name:'Sam Employee',work_date:'2026-11-18',decimal_hours:99});
 if(window.__testRole==='admin'){window.__active={auth_user_id:employee,employee_name:'Sam Employee',department:'Operations',started_at_ms:Date.parse('2026-11-19T07:51:00-05:00'),started_at:'2026-11-19T07:51:00-05:00',clock_in_location:'Synthetic shop',lunch_out_at:'2026-11-19T12:00:00-05:00',lunch_in_at:'2026-11-19T13:01:00-05:00'};}
 if(window.__dashboardFixture){
  window.__dashboardData={
   time_logs:[legacy,{...legacy,id:502,work_date:'2026-11-21',decimal_hours:'14'},{...legacy,id:503,work_date:'2026-11-22',decimal_hours:'14'},{...legacy,id:504,work_date:'2026-11-23',decimal_hours:'4.50'},
    ...[
     ['Jordan Baker Jr.','2026-11-15'],
     ['Elaine Wingert-Toliver','2026-11-15'],
     ['Zoe Adams','2026-11-13'],
     ['BAKER, Asha','2026-11-15'],
     ['Zoe Adams','2026-11-15']
    ].map(([employee_name,work_date],i)=>({...legacy,id:510+i,employee_name,work_date}))],
   commission_logs:[
    {id:11,wo_number:'P1',work_date:'2026-11-17',job_amount:'100'},
    {id:12,wo_number:'P2',work_date:'2026-11-22',job_amount:'200'},
    {id:13,wo_number:'C1',work_date:'2026-11-23',job_amount:'75'}
   ],
   fleet_vehicles:[{id:60,unit_name:'Open Fleet Flag',license_plate:'FLAG-60',status:'Flagged',last_inspected_date:'2026-10-14'},
    {id:61,unit_name:'Resolved Fleet Flag',license_plate:'FLAG-61',status:'Passed',last_inspected_date:'2026-10-28'}],
   vehicle_inspections:[
    {id:202,license_plate:'FLAG-61',issues_count:2,discrepancies:'Resolved fault'},
    {id:201,license_plate:'FLAG-60',issues_count:1,discrepancies:'Still open'},
    {id:200,license_plate:'FLAG-60',issues_count:2,discrepancies:'Older duplicate flag'}
   ]
  };
 }
 let reviews=[{id:90,employee_name:'Sam Employee',auth_user_id:employee,session_started_at_ms:Date.parse('2026-11-19T07:51:00-05:00'),due_at:'2026-11-20T00:01:00-05:00',default_ended_at:'2026-11-19T17:00:00-05:00',emergency:false,time_log_id:501,status:'pending',reason:'Automatic regular cutoff; existing timecard retained for review.',session_snapshot:{started_at:'2026-11-19T07:51:00-05:00'},candidate_time_log_ids:[501]},{id:91,employee_name:'Sam Employee',auth_user_id:employee,session_started_at_ms:Date.parse('2026-11-07T08:07:35-05:00'),due_at:'2026-11-08T00:01:00-05:00',default_ended_at:'2026-11-07T17:00:00-05:00',emergency:false,time_log_id:null,status:'pending',reason:'No default timecard. Lunch punches extend beyond the default end.',session_snapshot:{started_at:'2026-11-07T08:07:35-05:00',lunch_out_at:'2026-11-07T17:19:46-05:00'},candidate_time_log_ids:[]}];
 window.supabase.createClient=()=>{const c=make(),from=c.from,rpc=c.rpc;c.from=table=>{if(!['time_logs','gp_shift_close_reviews'].includes(table)&&!window.__dashboardData?.[table])return from(table);let start=0,end=499;const q={select(){return q;},order(){return q;},eq(){return q;},gte(){return q;},lte(){return q;},limit(n){end=n-1;return q;},range(a,b){start=a;end=b;return q;},then(a,b){return Promise.resolve({data:(window.__dashboardData?.[table]||(table==='gp_shift_close_reviews'?reviews:window.__testRole==='admin'?[legacy]:own)).slice(start,end+1),error:null}).then(a,b);}};return q;};
 if(window.__dashboardFixture){
  window.__dashboardUpdates={};
  c.channel=()=>{const channel={on(event,options,callback){window.__dashboardUpdates[options.table]=callback;return channel;},subscribe(callback){callback('SUBSCRIBED');return channel;}};return channel;};
 }
 c.rpc=async(name,args)=>{if(name==='gp_saved_timecards_for_session')return{data:[legacy],error:null};if(name==='gp_clear_saved_active_shift'){window.__recoveryCalls.push(args);window.__active=null;return{data:{ok:true,reused_timecard:true,shift_id:501},error:null};}if(name==='gp_review_auto_clock_out'){window.__reviewArgs=args;reviews=reviews.filter(row=>row.id!==args.p_review_id);return{data:null,error:null};}if(name==='gp_missed_clock_out_candidates')return{data:[],error:null};if(name==='gp_resolve_missed_clock_out'){window.__resolved=args;reviews=reviews.filter(row=>row.id!==args.p_review_id);return{data:502,error:null};}return rpc(name,args);};return c;};})();`;
const pause=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{const server=spawn('python3',['-m','http.server','8768','--bind','127.0.0.1'],{stdio:'ignore'});let browser,page;try{
 for(let n=0;n<40;n++){try{await fetch(base+'/index.html',{method:'HEAD'});break;}catch{await pause(100);}}
 browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});const context=await browser.newContext({viewport:{width:1440,height:1000},timezoneId:'America/Los_Angeles'});
 await context.route('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2',r=>r.fulfill({contentType:'application/javascript',body:mock}));await context.route('https://fonts.googleapis.com/**',r=>r.fulfill({contentType:'text/css',body:''}));await context.route('https://cdnjs.cloudflare.com/**',r=>r.fulfill({contentType:'application/javascript',body:'window.Papa={parse(){}};'}));
 page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.clock.install({time:new Date('2026-11-22T23:59:30-05:00')});await page.goto(base+'/index.html');await page.locator('#empWeekHours').filter({hasText:'15.00 hrs'}).waitFor();assert.equal(await page.locator('#recentTimeTable tr').count(),12,'all selected-week shifts appear');assert.equal(await page.locator('#empWeekFooter').textContent(),'15.00');
 await page.locator('#empWeekPrevious').click();assert.equal(await page.locator('#empWeekHours').textContent(),'7.50 hrs');await page.locator('#empWeekCurrent').click();await page.clock.fastForward(60000);await page.locator('#empWeekRange').filter({hasText:'Nov 23, 2026'}).waitFor();assert.equal(await page.locator('#empWeekHours').textContent(),'0.00 hrs','Eastern Monday starts a fresh current week while browser is still Sunday');assert.match(await page.locator('#empOvertimeText').textContent(),/00\.00/);await page.locator('#empWeekPrevious').click();assert.equal(await page.locator('#empWeekHours').textContent(),'15.00 hrs','previous week remains intact');
 await page.locator('#empWeekDate').fill('2026-11-10');await page.locator('#empWeekDate').dispatchEvent('change');assert.equal(await page.locator('#empWeekHours').textContent(),'7.50 hrs');await page.locator('#empWeekCurrent').click();await page.locator('#empWeekPrevious').click();fs.mkdirSync('test-results',{recursive:true});await page.screenshot({path:'test-results/employee-week-desktop.png',fullPage:true,animations:'disabled'});await page.setViewportSize({width:390,height:844});await page.waitForFunction(()=>document.documentElement.scrollWidth<=innerWidth&&parseFloat(getComputedStyle(document.body).paddingLeft)===0);await page.screenshot({path:'test-results/employee-week-mobile.png',fullPage:true,animations:'disabled'});
 const admin=await context.newPage();admin.on('pageerror',e=>errors.push(e.message));await admin.addInitScript(()=>window.__testRole='admin');await admin.goto(base+'/admin.html#adminTimePane');await admin.locator('button[data-clock-user]').first().click();await admin.locator('#gpClockExisting').waitFor({state:'visible'});assert.match(await admin.locator('#gpClockSavedDetails').textContent(),/8\.13 paid hours/);await admin.locator('#gpClockReason').fill('Verified saved timecard and clearing the leftover active clock.');await admin.getByRole('button',{name:'Keep timecard & clear active clock',exact:true}).click();await admin.locator('#gpClockDialog').waitFor({state:'hidden'});assert.equal(await admin.evaluate(()=>window.__recoveryCalls.length),1);assert.equal(await admin.evaluate(()=>window.__recoveryCalls[0].p_time_log_id),'501');await admin.getByText('No employees are currently clocked in.',{exact:true}).waitFor();await admin.locator('[data-review="90"] [data-review-note]').fill('Verified original timecard hours and lunch with employee.');await admin.getByRole('button',{name:'Mark clock-out reviewed',exact:true}).click();await admin.locator('[data-review="90"]').waitFor({state:'hidden'});assert.equal(await admin.evaluate(()=>window.__reviewArgs.p_review_id),90);
 const unresolved=admin.locator('[data-review="91"]');
 await unresolved.getByRole('button',{name:'Resolve clock-out',exact:true}).click();
 assert.equal(await unresolved.getByLabel('Actual Lunch Out',{exact:true}).inputValue(),'2026-11-07T14:19');
 assert.equal(await unresolved.getByLabel('Actual Lunch Back',{exact:true}).inputValue(),'');
 await unresolved.getByLabel('Actual clock-out',{exact:true}).fill('2026-11-07T14:22');
 await unresolved.getByLabel('Actual Lunch Back',{exact:true}).fill('2026-11-07T14:21');
 await unresolved.getByLabel('Manager verification / correction note',{exact:true}).fill('Confirmed clock-out and exact break with the employee.');
 await unresolved.getByRole('button',{name:'Save and approve review',exact:true}).click();
 await admin.getByText('No automatic clock-outs awaiting review.',{exact:true}).waitFor();
 const submitted=await admin.evaluate(()=>window.__resolved);
 assert.equal(submitted.p_review_id,91);
 assert.equal(submitted.p_ended_at,'2026-11-07T22:22:00.000Z');
 assert.equal(submitted.p_lunch_out,'2026-11-07T17:19:46-05:00');
 assert.equal(submitted.p_lunch_back,'2026-11-07T22:21:00.000Z');
 assert.equal(submitted.p_no_lunch,false);
 const kpis=await context.newPage();
 kpis.on('pageerror',e=>errors.push(e.message));
 await kpis.addInitScript(()=>{
  window.__testRole='admin';
  window.__dashboardFixture=true;
  window.__kpiAnimations=[];
  const animate=Element.prototype.animate;
  Element.prototype.animate=function(...args){if(this.matches('.kpi-value'))window.__kpiAnimations.push(this.id);return animate.apply(this,args);};
 });
 await kpis.clock.install({time:new Date('2026-11-22T23:59:30-05:00')});
 await kpis.goto(base+'/admin.html#adminOverviewPane');
 await kpis.locator('#statTotalHours').filter({hasText:'36.13'}).waitFor();
 await kpis.waitForFunction(()=>window.__dashboardUpdates?.fleet_vehicles);
 assert.equal(await kpis.locator('#statOtAlerts').textContent(),'1');
 assert.equal(await kpis.locator('#statTotalCommissions').textContent(),'2');
 assert.equal(await kpis.locator('#statFlaggedVehicles').textContent(),'1','duplicate historical inspections count as one current flag');
 await kpis.clock.fastForward(61000);
 await kpis.locator('#statTotalHours').filter({hasText:'04.50'}).waitFor();
 assert.equal(await kpis.locator('#statOtAlerts').textContent(),'0');
 assert.equal(await kpis.locator('#statTotalCommissions').textContent(),'1');
 assert.equal(await kpis.locator('#statTotalCommVolume').textContent(),'$75.00 logged volume');
 assert.equal(await kpis.locator('#statFlaggedVehicles').textContent(),'1','unresolved fleet flags survive the new week');
 assert.match(await kpis.locator('#mosExceptionQueueTable').textContent(),/Open Fleet Flag/);
 assert.doesNotMatch(await kpis.locator('#mosExceptionQueueTable').textContent(),/Resolved Fleet Flag/);
 await kpis.evaluate(()=>{
  choosePayrollWeek('2026-11-16');
  window.__unchangedWatchRow=document.querySelector('#adminOtWatchlistTable tr');
  window.__unchangedHours=document.querySelector('#statTotalHours').firstChild;
  window.__unchangedCard=document.querySelector('#statTotalCommissions').parentElement;
  window.__kpiAnimations.length=0;
  window.__dashboardData.commission_logs.push({id:14,wo_number:'C2',work_date:'2026-11-23',job_amount:'50'});
  window.__dashboardUpdates.commission_logs();
 });
 await kpis.locator('#statTotalCommissions').filter({hasText:'2'}).waitFor();
 assert.equal(await kpis.locator('#statTotalHours').textContent(),'04.50','selecting an old payroll week does not change Command Center totals');
 assert.deepEqual(await kpis.evaluate(()=>({
  animation:window.__kpiAnimations,
  stableWatch:window.__unchangedWatchRow===document.querySelector('#adminOtWatchlistTable tr'),
  stableHours:window.__unchangedHours===document.querySelector('#statTotalHours').firstChild,
  stableCard:window.__unchangedCard===document.querySelector('#statTotalCommissions').parentElement
 })),{animation:['statTotalCommissions'],stableWatch:true,stableHours:true,stableCard:true});
 await kpis.evaluate(()=>{window.__dashboardData.fleet_vehicles[0].status='Passed';window.__dashboardUpdates.fleet_vehicles();});
 await kpis.locator('#statFlaggedVehicles').filter({hasText:'0'}).waitFor();
 assert.doesNotMatch(await kpis.locator('#mosExceptionQueueTable').textContent(),/Open Fleet Flag/);
 await kpis.evaluate(()=>choosePayrollWeek('2026-11-09'));
 const timeGroups=kpis.locator('#adminTimeGroups .time-group');
 assert.deepEqual(await timeGroups.evaluateAll(rows=>rows.map(row=>row.dataset.employee)),
  ['zoe adams','baker, asha','jordan baker jr.','elaine wingert-toliver']);
 assert.deepEqual(await timeGroups.first().locator('tbody tr td:first-child').allTextContents(),
  ['2026-11-15','2026-11-13'],'the order of shifts within an employee is still newest first');
 assert.deepEqual(errors,[]);console.log('PASS: Eastern weekly rollover, live Command Center cards, stable updates, fleet resolution, saved-timecard recovery and automatic review workflow');
 }catch(e){if(page){fs.mkdirSync('test-results',{recursive:true});await page.screenshot({path:'test-results/time-week-failure.png',fullPage:true}).catch(()=>{});}throw e;}finally{await browser?.close();server.kill();}})().catch(e=>{console.error(e);process.exitCode=1;});
