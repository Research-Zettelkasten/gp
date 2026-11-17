const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const fs=require('node:fs');
const base='http://127.0.0.1:8765';
const fakeSupabase="(function fakeSupabase(){\n  const admin='11111111-1111-4111-8111-111111111111',employee='22222222-2222-4222-8222-222222222222';\n  const isAdmin=window.__testRole==='admin';\n  const profile={id:isAdmin?1:2,auth_user_id:isAdmin?admin:employee,employee_name:isAdmin?'Test Administrator':'Sam Employee',auth_email:'fixture@example.invalid',department:'Operations',pin_code:isAdmin?'1101':'2202',employment_type:'Full-Time',active:true,perm_time:true,perm_admin:isAdmin,perm_quotes:isAdmin,perm_collections:isAdmin,perm_commission:true,perm_vehicle_view:false,perm_vehicle_submit:false,perm_safety:true};\n  const start=Math.floor((Date.now()-8*3600000)/60000)*60000;\n  window.__active={auth_user_id:employee,employee_name:'Sam Employee',employee_pin:'2202',department:'Operations',started_at_ms:start,started_at:new Date(start).toISOString(),clock_in_location:'Test shop',clock_in_coords:'',break_minutes:30,lunch_out_at:new Date(start+3*3600000).toISOString(),lunch_in_at:new Date(start+3.5*3600000).toISOString()};\n  window.__clockCalls=[];window.__prefs=JSON.parse(localStorage.getItem('__test_prefs')||'{}');\n  const date=new Date(),day=new Date(date.getFullYear(),date.getMonth(),date.getDate());\n  const stamp=day.getFullYear()+'-'+String(day.getMonth()+1).padStart(2,'0')+'-'+String(day.getDate()).padStart(2,'0');\n  const rows=[{id:1,auth_user_id:profile.auth_user_id,employee_name:profile.employee_name,department:'Operations',work_date:stamp,decimal_hours:7.5,break_minutes:30,clock_in:'08:00',clock_out:'16:00',lunch_review_status:'not_required'}];\n  function from(table){\n    let eq={},rangeStart=0;\n    const query={\n      select(){return query;},order(){return query;},gte(){return query;},lte(){return query;},limit(){return query;},\n      eq(key,value){eq[key]=value;return query;},is(){return query;},in(){return query;},range(offset){rangeStart=offset;return query;},\n      insert(){return query;},update(){return query;},delete(){return query;},upsert(){return query;},\n      maybeSingle(){return Promise.resolve({data:result(true),error:null});},\n      single(){return query.maybeSingle();},\n      then(resolve,reject){return Promise.resolve({data:result(false),error:null}).then(resolve,reject);}\n    };\n    function result(single){\n      if(rangeStart>0)return [];\n      if(table==='app_users')return single?profile:[profile];\n      if(table==='portal_preferences')return single?{ui_preferences:window.__prefs,dashboard_prefs:{}}:[];\n      if(table==='active_time_sessions')return single?window.__active:(window.__active?[window.__active]:[]);\n      if(table==='time_logs')return single?rows[0]:rows;\n      return single?null:[];\n    }\n    return query;\n  }\n  const channel={on(){return channel;},subscribe(fn){fn?.('SUBSCRIBED');return channel;}};\n  const client={\n    from,channel:()=>channel,removeChannel:async()=>null,\n    auth:{\n      getUser:async()=>({data:{user:{id:profile.auth_user_id,email:profile.auth_email,user_metadata:{}}},error:null}),\n      getSession:async()=>({data:{session:{access_token:'fixture-token',user:{id:profile.auth_user_id}}},error:null}),\n      onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}}),signOut:async()=>({error:null})\n    },\n    rpc:async(name,args)=>{\n      if(name==='gp_save_ui_preferences'){Object.assign(window.__prefs,args.p_preferences);localStorage.setItem('__test_prefs',JSON.stringify(window.__prefs));return{data:{ok:true},error:null};}\n      if(name==='gp_finish_active_shift'){window.__clockCalls.push(args);window.__active=null;return{data:{ok:true,already_closed:false,shift_id:'99',decimal_hours:7.5},error:null};}\n      if(name==='gp_employee_directory')return{data:[profile],error:null};\n      return{data:null,error:null};\n    }\n  };\n  window.supabase={createClient:()=>client};\n})();";
const pause=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  const server=spawn('python3',['-m','http.server','8765','--bind','127.0.0.1'],{stdio:'ignore'});
  let browser;
  try{
    for(let i=0;i<40;i++){try{await fetch(base+'/home.html');break;}catch{await pause(100);}}
    browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{})});
    const context=await browser.newContext({viewport:{width:1440,height:1000}});
    await context.route('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2',route=>route.fulfill({contentType:'application/javascript',body:fakeSupabase}));
    await context.route('https://cdnjs.cloudflare.com/**',route=>route.fulfill({contentType:'application/javascript',body:'window.Papa={parse(){}};'}));
    await context.route('https://fonts.googleapis.com/**',route=>route.fulfill({contentType:'text/css',body:''}));
    const page=await context.newPage(),errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.goto(base+'/home.html');await page.getByRole('heading',{name:/Good (morning|afternoon|evening), Sam/}).waitFor();
    await page.getByText('Updated ',{exact:false}).first().waitFor();
    assert.equal(await page.locator('.gp-home-tool').count(),3,'permission-aware module cards');
    assert.equal(await page.locator('.gp-home-tool[href="admin.html"]').count(),0);
    assert.equal(await page.locator('a[aria-current="page"][href="home.html"]').count(),1,'home is active in navigation');
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true,'desktop has no horizontal overflow');
    await page.getByRole('button',{name:'Customize home',exact:true}).click();
    await page.locator('#gp2Columns').selectOption('one');
    await page.getByRole('button',{name:'Move Vehicle Check & Safety up',exact:true}).click();
    await page.getByRole('button',{name:'Save layout',exact:true}).click();
    await page.getByText('Your layout is saved.',{exact:true}).waitFor();
    assert.equal(await page.locator('.gp2-home-cards.gp2-one').count(),1);
    await page.reload();await page.getByRole('heading',{name:/Good (morning|afternoon|evening), Sam/}).waitFor();
    await page.locator('.gp2-home-cards.gp2-one').waitFor();
    assert.equal(await page.locator('.gp-home-tool h3').nth(1).textContent(),'Vehicle Check & Safety','card order survives refresh');
    await page.getByRole('button',{name:'Account & PIN',exact:true}).click();
    await page.getByRole('heading',{name:'Your Quick PIN',exact:true}).waitFor();
    await page.locator('#gp-pin-close').click();
    await page.getByRole('button',{name:/Dark mode/}).click();
    assert.equal(await page.locator('html').getAttribute('data-gp-theme'),'dark');
    await page.getByRole('searchbox',{name:'Find a workspace or Management section'}).fill('time');
    assert.equal(await page.locator('.gp-side-link-row:not(.gp-search-hidden)').count(),1,'navigation search filters modules');
    await page.getByRole('searchbox').fill('');
    await page.setViewportSize({width:390,height:844});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true,'mobile home has no horizontal overflow');
    await page.getByRole('button',{name:'Open GLASSPRO navigation'}).click();
    await page.getByRole('button',{name:'Close menu',exact:true}).waitFor({state:'visible'});
    assert.equal(await page.locator('body').evaluate(el=>el.classList.contains('gp-nav-open')),true);
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('button',{name:'Open GLASSPRO navigation'}).evaluate(el=>el===document.activeElement),true,'mobile Escape restores focus');
    fs.mkdirSync('test-results',{recursive:true});
    await page.screenshot({path:'test-results/home-mobile-dark.png',fullPage:true});
    await page.setViewportSize({width:1440,height:1000});await page.getByRole('button',{name:/Light mode/}).click();
    await page.screenshot({path:'test-results/home-desktop-light.png',fullPage:true});

    // The employee clock rechecks the authoritative session on visibility changes.
    await page.goto(base+'/index.html');
    await page.locator('#btnClockOut').waitFor({state:'visible'});
    await page.evaluate(()=>{window.__active=null;document.dispatchEvent(new Event('visibilitychange'));});
    await page.locator('#btnClockIn').waitFor({state:'visible'});
    assert.equal(await page.locator('#punchStatusText').textContent(),'Off Clock');

    const admin=await context.newPage();await admin.addInitScript(()=>window.__testRole='admin');
    admin.on('pageerror',e=>errors.push(e.message));
    await admin.goto(base+'/admin.html#adminTimePane');
    await admin.locator('button[data-clock-user]').first().waitFor({state:'visible'});
    await admin.locator('button[data-clock-user]').first().click();
    await admin.locator('#gpClockReason:not(:disabled)').waitFor();
    await admin.locator('#gpClockReason').fill('Employee left work and forgot to clock out.');
    await admin.locator('#gpClockConfirm').click();
    await admin.locator('#gpClockDialog').waitFor({state:'hidden'});
    assert.equal(await admin.evaluate(()=>window.__clockCalls.length),1);
    assert.equal(await admin.evaluate(()=>window.__clockCalls[0].p_employee_id),'22222222-2222-4222-8222-222222222222');
    await admin.getByText('No employees are currently clocked in.',{exact:true}).waitFor();
    assert.deepEqual(errors,[],'no browser runtime errors');
    console.log('Browser checks passed: home, card ordering, dark mode, responsive navigation, remote clock clearing, and admin clock-out.');
  }finally{await browser?.close();server.kill();}
})().catch(e=>{console.error(e);process.exitCode=1;});

