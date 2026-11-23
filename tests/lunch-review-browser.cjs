const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const fs=require('node:fs');
const base='http://127.0.0.1:8770';
const mock=require('./fixtures/clock-browser-mock.cjs')+String.raw`
(()=>{
 const create=window.supabase.createClient;
 window.__lunchWrites=[];
 const shift=(id,work_date,lunch_review_status)=>({id,work_date,lunch_review_status,
   auth_user_id:'22222222-2222-4222-8222-222222222222',employee_name:'Sam Employee',
   department:'Operations',clock_in:'08:00',clock_out:'16:00',decimal_hours:'8.00',
   break_minutes:0,no_lunch_reason:'Synthetic review explanation',lunch_review_note:''});
 window.__lunchRows=[shift(1,'2026-11-20','pending'),shift(2,'2026-11-22','rejected'),
   shift(3,'2026-11-23','pending'),shift(4,'2026-11-13','pending'),
   shift(5,'2026-11-18','approved'),shift(6,'','pending')];
 window.__lunchRows[1].clock_in='18:30';window.__lunchRows[1].clock_out='07:30';
 window.__lunchRows[1].lunch_review_note='Synthetic Sunday overnight exception';
 window.supabase.createClient=()=>{
   const client=create(),from=client.from;
   client.from=table=>{
     if(table!=='time_logs')return from(table);
     let start=0,end=499;
     const q={select(){return q;},order(){return q;},eq(){return q;},
       gte(){return q;},lte(){return q;},range(a,b){start=a;end=b;return q;},
       update(value){window.__lunchWrites.push(['update',value]);return q;},
       insert(value){window.__lunchWrites.push(['insert',value]);return q;},
       delete(){window.__lunchWrites.push(['delete']);return q;},
       then(a,b){return Promise.resolve({data:window.__lunchRows.slice(start,end+1),error:null}).then(a,b);}};
     return q;
   };
   return client;
 };
})();`;
const pause=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 const server=spawn('python3',['-m','http.server','8770','--bind','127.0.0.1'],{stdio:'ignore'});
 let browser,page;
 try{
   for(let n=0;n<40;n++){try{await fetch(base+'/admin.html');break;}catch{await pause(100);}}
   browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
   const context=await browser.newContext({viewport:{width:1440,height:1000},timezoneId:'America/Los_Angeles'});
   await context.route('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2',r=>r.fulfill({contentType:'application/javascript',body:mock}));
   await context.route('https://fonts.googleapis.com/**',r=>r.fulfill({contentType:'text/css',body:''}));
   await context.route('https://cdnjs.cloudflare.com/**',r=>r.fulfill({contentType:'application/javascript',body:'window.Papa={parse(){}};'}));
   page=await context.newPage();const errors=[];
   page.on('pageerror',e=>errors.push(e.message));
   await page.addInitScript(()=>window.__testRole='admin');
   await page.clock.install({time:new Date('2026-11-22T23:59:30-05:00')});
   await page.goto(base+'/admin.html#adminTimePane');
   const label=page.locator('#gpLunchWeekLabel'),rows=page.locator('#lunchReviewRows tr');
   await label.filter({hasText:'Nov 16, 2026'}).waitFor();
   assert.equal(await rows.count(),2,'only the selected Monday-Sunday unresolved items appear');
   assert.match(await page.locator('#lunchReviewRows').textContent(),/2026-11-22/,'Sunday overnight belongs to its original work date');
   await page.clock.fastForward(60000);
   assert.match(await label.textContent(),/Nov 16, 2026/,'Monday retains the previous review week');
   assert.equal(await page.locator('#lunchPendingCount').textContent(),'1 pending');
   assert.match(await page.locator('#gpLunchWeekSummary').textContent(),/1 need correction.*3 outstanding outside/);
   await page.evaluate(()=>{window.__lunchRowNode=document.querySelector('#lunchReviewRows tr');renderLunchApprovalQueue();});
   assert.equal(await page.evaluate(()=>window.__lunchRowNode===document.querySelector('#lunchReviewRows tr')),true,'unchanged refresh preserves the existing rows');
   await page.locator('#gpLunchPrev').click();
   assert.match(await label.textContent(),/Nov 9, 2026/);assert.equal(await rows.count(),1);
   await page.locator('#gpLunchNext').click();await page.locator('#gpLunchNext').click();
   assert.match(await label.textContent(),/Nov 23, 2026/,'Monday submissions can be opened before the Tuesday rollover');
   assert.equal(await rows.count(),1);assert.equal(await page.locator('#gpLunchNext').isDisabled(),true);
   await page.locator('#gpLunchCurrent').click();
   await page.locator('#gpLunchWeekPicker').fill('2026-11-10');await page.locator('#gpLunchWeekPicker').dispatchEvent('change');
   assert.match(await label.textContent(),/Nov 9, 2026/);
   await page.locator('#gpLunchPrev').click();assert.match(await page.locator('#lunchReviewRows').textContent(),/for this week/);
   await page.locator('#gpLunchCurrent').click();
   await page.locator('#gpPayrollWeekPicker').fill('2026-11-10');await page.locator('#gpPayrollWeekPicker').dispatchEvent('change');
   assert.match(await label.textContent(),/Nov 16, 2026/,'payroll navigation does not override the lunch review period');
   await page.locator('#gpLunchAll').click();
   assert.equal(await rows.count(),5,'all outstanding includes older, Monday, rejected and undated exceptions');
   assert.equal(await page.locator('#gpLunchWeekPicker').isDisabled(),true);
   assert.match(await page.locator('#gpLunchWeekSummary').textContent(),/4 pending · 1 need correction across all weeks/);
   await page.locator('#gpLunchCurrent').click();
   await page.clock.setSystemTime(new Date('2026-11-23T23:59:30-05:00'));
   await page.clock.fastForward(60000);
   await label.filter({hasText:'Nov 23, 2026'}).waitFor();
   assert.equal(await rows.count(),1,'the current view advances automatically on Eastern Tuesday while the browser is still Monday');
   assert.equal(await page.locator('#lunchPendingCount').textContent(),'1 pending');
   await page.locator('#gpLunchPrev').click();assert.equal(await rows.count(),2,'old pending and rejected reviews remain available');
   await page.clock.setSystemTime(new Date('2026-12-01T00:00:30-05:00'));
   await page.clock.fastForward(15000);
   assert.match(await label.textContent(),/Nov 16, 2026/,'an explicitly selected historical week remains selected');
   await page.locator('#gpLunchCurrent').click();assert.match(await label.textContent(),/Nov 30, 2026/);
   await page.locator('#gpLunchAll').click();assert.equal(await rows.count(),5);
   assert.deepEqual(await page.evaluate(()=>window.__lunchWrites),[],'rollover and filters never approve, reject, or delete timecards');
   assert.deepEqual(await page.evaluate(()=>window.__lunchRows.map(r=>r.lunch_review_status)),['pending','rejected','pending','pending','approved','pending']);
   await page.locator('#gpLunchCurrent').click();
   await page.locator('#gpLunchWeekPicker').fill('2026-11-18');await page.locator('#gpLunchWeekPicker').dispatchEvent('change');
   await page.locator('#gpWidgetLunchReview').scrollIntoViewIfNeeded();
   fs.mkdirSync('test-results',{recursive:true});
   await page.locator('#gpWidgetLunchReview').screenshot({path:'test-results/lunch-review-week-desktop.png',animations:'disabled'});
   await page.evaluate(()=>GP_UX.setTheme('dark',false));
   await page.setViewportSize({width:390,height:844});
   await page.waitForFunction(()=>document.documentElement.scrollWidth<=innerWidth&&parseFloat(getComputedStyle(document.body).paddingLeft)===0);
   await page.locator('#gpWidgetLunchReview').screenshot({path:'test-results/lunch-review-week-mobile-dark.png',animations:'disabled'});
   assert.deepEqual(errors,[]);
   console.log('PASS: Tuesday Eastern rollover, Monday weekend follow-up, independent weekly navigation, retained outstanding statuses and responsive lunch reviews.');
 }catch(e){if(page){fs.mkdirSync('test-results',{recursive:true});await page.screenshot({path:'test-results/lunch-review-failure.png',fullPage:true}).catch(()=>{});}throw e;}
 finally{await browser?.close();server.kill();}
})().catch(e=>{console.error(e);process.exitCode=1;});
