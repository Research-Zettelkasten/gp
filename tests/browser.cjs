const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const fs=require('node:fs');
const base='http://127.0.0.1:8765';
const fakeSupabase=require('./fixtures/clock-browser-mock.cjs');
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
    await page.waitForFunction(()=>document.querySelector('.gp-home-outer').getBoundingClientRect().left>=document.querySelector('.gp-sidebar').getBoundingClientRect().right);
    assert.equal(await page.evaluate(()=>document.querySelector('.gp-home-outer').getBoundingClientRect().left>=document.querySelector('.gp-sidebar').getBoundingClientRect().right),true,'desktop content clears the fixed navigation');
    const nameContrast=await page.locator('#activeUserName').evaluate(el=>{
      const c=getComputedStyle(el),luminance=value=>{const v=value.match(/[\d.]+/g).slice(0,3).map(Number).map(n=>{n/=255;return n<=.04045?n/12.92:((n+.055)/1.055)**2.4;});return .2126*v[0]+.7152*v[1]+.0722*v[2];};
      const fg=luminance(c.color),bg=luminance(c.backgroundColor);return(Math.max(fg,bg)+.05)/(Math.min(fg,bg)+.05);
    });
    assert.ok(nameContrast>=4.5,'username label remains legible against its light header pill');
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
    await page.getByRole('button',{name:'Display preferences',exact:true}).click();
    await page.getByRole('button',{name:'Switch to dark mode',exact:true}).click();
    assert.equal(await page.locator('html').getAttribute('data-gp-theme'),'dark');
    await page.getByRole('searchbox',{name:'Find a workspace or Management section'}).fill('time');
    assert.equal(await page.locator('.gp-side-link-row:visible').count(),1,'navigation search filters permitted modules');
    await page.getByRole('searchbox').fill('');
    await page.setViewportSize({width:390,height:844});
    await page.waitForFunction(()=>parseFloat(getComputedStyle(document.body).paddingLeft)===0&&document.querySelector('.gp-sidebar').getBoundingClientRect().right<=0);
    await page.waitForFunction(()=>document.documentElement.scrollWidth<=window.innerWidth,{},{timeout:3000}).catch(async error=>{
      console.error('Mobile overflow details:',await page.evaluate(()=>[...document.querySelectorAll('body *')].map(el=>({tag:el.tagName,id:el.id,className:String(el.className),right:el.getBoundingClientRect().right,width:el.getBoundingClientRect().width})).filter(x=>x.right>innerWidth+1).slice(0,15)));
      throw error;
    });
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true,'mobile home has no horizontal overflow');
    await page.getByRole('button',{name:'Open GLASSPRO navigation'}).click();
    await page.getByRole('button',{name:'Close menu',exact:true}).waitFor({state:'visible'});
    assert.equal(await page.locator('body').evaluate(el=>el.classList.contains('gp-nav-open')),true);
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('button',{name:'Open GLASSPRO navigation'}).evaluate(el=>el===document.activeElement),true,'mobile Escape restores focus');
    fs.mkdirSync('test-results',{recursive:true});
    await page.screenshot({path:'test-results/home-mobile-dark.png',fullPage:true,animations:'disabled'});
    await page.setViewportSize({width:1440,height:1000});await page.getByRole('button',{name:'Switch to light mode',exact:true}).click();
    await page.waitForFunction(()=>parseFloat(getComputedStyle(document.body).paddingLeft)>=257);
    await page.screenshot({path:'test-results/home-desktop-light.png',fullPage:true,animations:'disabled'});

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

