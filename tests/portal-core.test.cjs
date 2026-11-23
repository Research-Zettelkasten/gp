const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const root=path.join(__dirname,'..');
const sandbox={Date,setTimeout,clearTimeout,console};
vm.runInNewContext(fs.readFileSync(path.join(root,'gp-clock.js'),'utf8'),sandbox);
vm.runInNewContext(fs.readFileSync(path.join(root,'gp-home-core.js'),'utf8'),sandbox);
const clock=sandbox.GP_CLOCK,home=sandbox.GP_HOME_CORE;
const navigation=require('../gp-sidebar-core.js');
test('personal menus ignore unknown IDs and never turn preferences into permissions',()=>{const p=navigation.normalize({order:['navLinkAdmin','evil','navLinkAdmin'],hidden:['evil'],favorites:['navLinkAdmin','evil'],hiddenSections:['admin:adminUsersPane','evil']});assert.equal(p.order.length,navigation.items.length);assert.equal(new Set(p.order).size,p.order.length);assert.deepEqual(p.hidden,[]);assert.deepEqual(p.hiddenSections,['admin:adminUsersPane']);assert.equal(navigation.allowed({active:true,perm_time:true}).some(i=>i.id==='navLinkAdmin'),false);assert.equal(navigation.allowed({active:false,perm_admin:true}).length,0);});
test('menu hiding, favorites and current-page recovery preserve access to the active workspace',()=>{const p=navigation.normalize({hidden:['navLinkTime'],favorites:['navLinkQuotes'],favoritesOnly:true});assert.equal(navigation.visible(p,'navLinkTime','navLinkTime'),true);assert.equal(navigation.visible(p,'navLinkComm','navLinkTime'),false);assert.equal(navigation.visible(p,'navLinkQuotes','navLinkTime'),true);assert.equal(navigation.visible(p,'navLinkComm','navLinkTime',true),true,'search may reveal a personally hidden but permitted tool');});
test('menu reordering follows permitted peers without moving items into another category',()=>{const p=navigation.move({},'navLinkCustomers',-1,['navLinkTime','navLinkCustomers','navLinkAdmin']);assert.equal(p.order[0],'navLinkCustomers');assert.equal(p.order.at(-1),'navLinkAdmin');assert.deepEqual(navigation.move(p,'navLinkAdmin',-1,['navLinkTime','navLinkCustomers','navLinkAdmin']).order,p.order);});
test('unknown and unassigned permissions do not create home links',()=>assert.equal(home.allowed({active:true}).length,0));
test('inactive administrators have no assigned modules',()=>assert.equal(home.allowed({active:false,perm_admin:true}).length,0));
test('safety-only users see Safety without Fleet',()=>assert.equal(home.allowed({active:true,perm_safety:true}).map(x=>x.id).join(','),'safety'));
test('saved layout removes unknown IDs and duplicates',()=>{const p=home.normalize({layout:'bad',hidden:['time','bad','time'],order:['admin','bad','admin']});assert.equal(p.layout,'two');assert.equal(p.hidden.join(','),'time');assert.equal(p.order.length,8);assert.equal(p.order[0],'admin');});
test('weekly totals exclude other weeks and malformed dates',()=>{const p=home.weekly([{work_date:'2026-11-16',decimal_hours:'8',lunch_review_status:'pending'},{work_date:'2026-11-22',decimal_hours:'7'},{work_date:'2026-11-15',decimal_hours:'100'},{work_date:'bad',decimal_hours:'100'}],new Date('2026-11-18T12:00:00'));assert.equal(p.hours,15);assert.equal(p.shifts,2);assert.equal(p.pending,1);});
const now=Date.parse('2026-11-16T22:00:00Z'),start=Date.parse('2026-11-16T14:00:00Z'),uid='22222222-2222-4222-8222-222222222222';
test('employee end time comes from the server',()=>assert.equal(clock.validate({startedAtMs:start},now).p_ended_at,null));
test('employees cannot supply a historical clock-out',()=>assert.throws(()=>clock.validate({startedAtMs:start,endedAt:'2026-11-16T21:00:00Z'},now)));
test('administrator reason cannot be blank or short',()=>assert.throws(()=>clock.validate({startedAtMs:start,employeeId:uid,reason:'short'},now)));
test('future times and shifts of 24 hours or longer are rejected',()=>{assert.throws(()=>clock.validate({startedAtMs:start,employeeId:uid,reason:'Employee forgot to clock out',endedAt:'2026-11-17T22:00:00Z'},now));assert.throws(()=>clock.validate({startedAtMs:start-86400000},now));});
test('an administrator can finish a stale punch at its actual historical end',()=>assert.equal(clock.validate({startedAtMs:start-86400000,employeeId:uid,reason:'Employee forgot to clock out',endedAt:'2026-11-15T22:00:00Z'},now).p_ended_at,'2026-11-15T22:00:00.000Z'));
test('completed lunch is deducted from the preview',()=>{const p=clock.preview({started_at_ms:start,lunch_out_at:'2026-11-16T17:00:00Z',lunch_in_at:'2026-11-16T17:30:00Z'},now);assert.equal(p.breakMinutes,30);assert.equal(p.hours,7.5);});
test('approved clock-in affects elapsed time while the original session token is retained',()=>{const session={started_at_ms:start,approved_clock_in_at:new Date(start-1800000).toISOString(),lunch_out_at:'2026-11-16T17:00:00Z',lunch_in_at:'2026-11-16T17:30:00Z'};assert.equal(clock.preview(session,now).hours,8);assert.equal(session.started_at_ms,start);assert.equal(clock.validate({startedAtMs:start,effectiveStartedAtMs:start-1800000,employeeId:uid,reason:'Verified actual earlier shift end',endedAt:new Date(start-60000).toISOString()},now).p_expected_start_ms,start);});
test('open lunch remains unpaid through administrator clock-out',()=>{const p=clock.preview({started_at_ms:start,lunch_out_at:'2026-11-16T21:00:00Z'},now);assert.equal(p.breakMinutes,60);assert.equal(p.hours,7);assert.equal(p.onLunch,true);});
test('clock-out requires a successful server confirmation',async()=>{await assert.rejects(clock.finishShift({rpc:async()=>({data:{ok:false}})},{startedAtMs:Date.now()-3600000}));const p=await clock.finishShift({rpc:async()=>({data:{ok:true,already_closed:true}})},{startedAtMs:Date.now()-3600000});assert.equal(p.already_closed,true);});
test('missing SQL update provides actionable installation guidance',async()=>{await assert.rejects(clock.finishShift({rpc:async()=>({error:{code:'PGRST202',message:'missing'}})},{startedAtMs:Date.now()-3600000}),/migration first/);});
test('failed session reads never look like an absent session',async()=>{await assert.rejects(clock.readActive({from:()=>({select:()=>({eq:()=>({maybeSingle:async()=>({error:Error('offline')})})})})},uid));});
test('all frontend scripts parse and local assets exist',()=>{
  const files=fs.readdirSync(root);
  for(const file of files.filter(f=>f.endsWith('.js')))new vm.Script(fs.readFileSync(path.join(root,file),'utf8'),{filename:file});
  for(const file of files.filter(f=>f.endsWith('.html'))){
    const html=fs.readFileSync(path.join(root,file),'utf8');
    for(const script of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi))
      if(!/\bsrc=/.test(script[1])&&!/application\/(?:ld\+)?json/.test(script[1]))new vm.Script(script[2],{filename:file});
    const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);
    assert.equal(new Set(ids).size,ids.length,file+' has duplicate IDs');
    for(const match of html.matchAll(/<(?:script|link)\b[^>]*(?:src|href)=["']([^"']+)["']/gi)){
      const ref=match[1].split('?')[0];if(/^(https?:|data:|#)/.test(ref)||!ref)continue;
      assert.ok(fs.existsSync(path.join(root,ref)),file+' missing '+ref);
    }
  }
});

