/* Synthetic browser integration. No sample customer or employee records are published. */
const {chromium}=require('playwright'),assert=require('node:assert/strict'),fs=require('node:fs'),{spawn}=require('node:child_process'),zlib=require('node:zlib');
const base='http://127.0.0.1:8766';
function workbook(rows){
 const escape=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;');
 const files={'xl/workbook.xml':'<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView WindowWidth="1234"/></bookViews><sheets><sheet name="Report" sheetId="1" r:id="r1"/></sheets></workbook>',
 'xl/_rels/workbook.xml.rels':'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Target="worksheets/sheet1.xml"/></Relationships>',
 'xl/worksheets/sheet1.xml':'<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'+rows.map((r,i)=>`<row r="${i+1}">`+r.map((v,j)=>`<c r="${String.fromCharCode(65+j)}${i+1}" t="inlineStr"><is><t>${escape(v)}</t></is></c>`).join('')+'</row>').join('')+'</sheetData></worksheet>'};
 const parts=[],dir=[];let offset=0;for(const [name,text]of Object.entries(files)){const n=Buffer.from(name),raw=Buffer.from(text),data=zlib.deflateRawSync(raw),local=Buffer.alloc(30),central=Buffer.alloc(46);local.writeUInt32LE(0x04034b50);local.writeUInt16LE(8,8);local.writeUInt32LE(data.length,18);local.writeUInt32LE(raw.length,22);local.writeUInt16LE(n.length,26);central.writeUInt32LE(0x02014b50);central.writeUInt16LE(8,10);central.writeUInt32LE(data.length,20);central.writeUInt32LE(raw.length,24);central.writeUInt16LE(n.length,28);central.writeUInt32LE(offset,42);parts.push(local,n,data);dir.push(central,n);offset+=30+n.length+data.length;}
 const directory=Buffer.concat(dir),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(Object.keys(files).length,8);end.writeUInt16LE(Object.keys(files).length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...parts,directory,end]);
}
const mock=`(()=>{
 const uid='11111111-1111-4111-8111-111111111111';window.__rpc=[];window.__failQuotes=false;
 const profile={auth_user_id:uid,auth_email:'fixture@example.invalid',employee_name:'Fixture Admin',department:'Admin',active:true,perm_admin:true,perm_collections:true,perm_quotes:true};
 const imp=(id,source,kind,day)=>({id,source,report_kind:kind,report_scope:'full',report_as_of:day,status:'complete',completed_at:day+'T12:00:00Z',created_at:day+'T12:00:00Z',file_name:id+'.csv',row_count:1});
 const key='INV|EXAMPLE CUSTOMER|100',legacy='GQ|INV101';
 window.__tables={app_users:[profile],collection_imports:[imp('verify','qbo','invoice_verification','2026-11-18'),imp('open','qbo','open_invoices','2026-11-17'),imp('quest','glassquest','legacy_baseline','2026-11-01')],
 collection_cases:[{id:'case1',case_key:key,customer_name:'Example Customer',normalized_customer:'EXAMPLE CUSTOMER',invoice_number:'100',invoice_date:'2026-01-01',status:'open',qbo_import_id:'verify',qbo_balance:0,mainstreet_balance:null,glassquest_import_id:'quest',glassquest_balance:50,glassquest_case_key:'GQ|100',qbo_days_past_due:300},{id:'legacy',case_key:legacy,customer_name:'GlassQuest · customer not provided',normalized_customer:'GLASSQUEST CUSTOMER NOT PROVIDED',invoice_number:'INV101',invoice_date:'2020-01-01',status:'open',legacy_unmatched:true,glassquest_import_id:'quest',glassquest_balance:25,qbo_balance:null,mainstreet_balance:null}],
 collection_source_rows:[{id:1,import_id:'verify',source:'qbo',case_key:key,customer_name:'Example Customer',normalized_customer:'EXAMPLE CUSTOMER',invoice_number:'100',transaction_type:'invoice',transaction_date:'2026-01-01',original_amount:50,open_balance:0,raw:{balance_present:true,ar_paid:'Paid'}},{id:2,import_id:'quest',source:'glassquest',case_key:legacy,customer_name:'GlassQuest · customer not provided',normalized_customer:'GLASSQUEST CUSTOMER NOT PROVIDED',invoice_number:'INV101',transaction_type:'invoice',transaction_date:'2020-01-01',original_amount:25,open_balance:25,raw:{balance_present:true,customer_missing:true}}],
 collection_actions:[{id:1,case_id:'case1',action_type:'note',note:'Call accounts payable; reference CHECK-101.',details:{contact_person:'Example AP'},recorded_by:uid,created_at:'2026-11-18T13:00:00Z'}],
 collection_account_notes:[{id:1,customer_name:'Example Customer',normalized_customer:'EXAMPLE CUSTOMER',category:'instructions',subject:'AP instructions',note:'Email statements to the verified AP contact.',recorded_by:uid,created_at:'2026-11-18T14:00:00Z'}],
 outstanding_quotes:[{quote_number:101,customer_name:'Example Customer',quote_date:'11/01/2026',status:'open',total:50,module:'Auto',parts:[],original_csr:'Fixture Admin',call_data:{}}],quote_competitors:[],quote_customer_exemptions:[]};
 function from(table){let filters=[],offset=0,end=499,insert=null;
  const q={select(){return q;},order(){return q;},limit(n){end=n-1;return q;},range(a,b){offset=a;end=b;return q;},eq(k,v){filters.push(r=>r[k]===v);return q;},neq(k,v){filters.push(r=>r[k]!==v);return q;},in(k,vs){filters.push(r=>vs.includes(r[k]));return q;},lt(k,v){filters.push(r=>r[k]<v);return q;},gte(){return q;},lte(){return q;},gt(){return q;},insert(v){insert=v;return q;},upsert(v){insert=v;return q;},update(){return q;},
   maybeSingle(){return Promise.resolve(result(true));},single(){return q.maybeSingle();},then(ok,no){return Promise.resolve(result(false)).then(ok,no);}};
  function result(single){if(table==='outstanding_quotes'&&window.__failQuotes)return{data:null,error:{message:'Synthetic connection failure'}};if(insert){window.__tables[table]??=[];window.__tables[table].push(...insert);insert=null;}const rows=(window.__tables[table]||[]).filter(r=>filters.every(f=>f(r))).slice(offset,end+1);return{data:single?(rows[0]||null):rows,error:null};}return q;
 }
 const channel={on(){return channel;},subscribe(){return channel;}};
 const client={from,channel:()=>channel,removeChannel:async()=>null,auth:{getUser:async()=>({data:{user:{id:uid,email:profile.auth_email}}}),getSession:async()=>({data:{session:{user:{id:uid},access_token:'fixture'}}}),onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}}),signOut:async()=>({})},rpc:async(name,args)=>{window.__rpc.push({name,args});
  if(name==='gp_collections_clear_verified'){const c=window.__tables.collection_cases.find(c=>c.id===args.p_case_id);c.status='reconciled';c.cleared_at='2026-11-18T15:00:00Z';return{data:null,error:null};}
  if(name==='gp_collections_begin_snapshot')return{data:'staging',error:null};
  if(name==='gp_collections_commit_snapshot')return{data:{rows:1,historical_only:false},error:null};
  if(name==='gp_import_quote_callbacks'){let added=0;for(const r of args.p_rows)if(!window.__tables.outstanding_quotes.some(q=>q.quote_number===r.quote_number)){window.__tables.outstanding_quotes.push({...r,status:'open'});added++;}return{data:{added,duplicates:args.p_rows.length-added},error:null};}
  return{data:null,error:null};}};
 window.supabase={createClient:()=>client};
})();`;
const pause=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{const server=spawn('python3',['-m','http.server','8766','--bind','127.0.0.1'],{stdio:'ignore'});let browser;try{
 for(let n=0;n<40;n++){try{await fetch(base+'/collections.html');break;}catch{await pause(100);}}
 browser=await chromium.launch({headless:true});const context=await browser.newContext({viewport:{width:1440,height:1050}});
 await context.route('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2',r=>r.fulfill({contentType:'application/javascript',body:mock}));
 await context.route('https://unpkg.com/lucide@latest',r=>r.fulfill({contentType:'application/javascript',body:'window.lucide={createIcons(){}};'}));
 await context.route('https://cdn.tailwindcss.com',r=>r.fulfill({contentType:'application/javascript',body:'window.tailwind={};'}));
 await context.route('https://cdnjs.cloudflare.com/**',r=>r.fulfill({contentType:'application/javascript',body:`window.Papa={parse:async(file,o)=>{const rows=(await file.text()).trim().split(/\\r?\\n/).map(s=>s.split(','));const h=rows.shift();o.complete({data:rows.map(r=>Object.fromEntries(h.map((v,i)=>[v,r[i]||'']))),errors:[]});}};`}));
 await context.route('https://fonts.googleapis.com/**',r=>r.fulfill({contentType:'text/css',body:''}));
 const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base+'/collections.html');await page.locator('#syncStatus').filter({hasText:'tracked invoices'}).waitFor();
 await page.locator('#queueSource').selectOption('glassquest');assert.match(await page.locator('#queueCount').textContent(),/2 invoices/);
 await page.locator('#queueEvidence').selectOption('verified');assert.match(await page.locator('#queueCount').textContent(),/1 invoices/);
 await page.locator('.col-customer summary').click();await page.getByRole('button',{name:'Review invoice',exact:true}).click();
 await page.locator('#clearVerifiedForm').waitFor({state:'visible'});await page.locator('#clearVerifiedNote').fill('Confirmed payment and zero balance in Invoice List.');await page.getByRole('button',{name:'Archive verified settlement'}).click();await page.locator('#caseOverlay').waitFor({state:'hidden'});assert.match(await page.locator('#colMessage').textContent(),/archived/);
 await page.getByRole('tab',{name:'Notes registry',exact:true}).click();await page.locator('#notesCount').filter({hasText:'matching records'}).waitFor();
 await page.locator('#notesSearch').fill('CHECK-101');assert.match(await page.locator('#notesCount').textContent(),/1 matching/);assert.match(await page.locator('#notesRegistry').textContent(),/accounts payable/);await page.locator('#notesSearch').fill('');await page.locator('#notesType').selectOption('account');assert.match(await page.locator('#notesRegistry').textContent(),/AP instructions/);
 await page.getByRole('tab',{name:'Import center',exact:true}).click();assert.equal(await page.locator('#uploadGlassquest').isDisabled(),true);
 // Exercise compressed XLSX decoding, including the old Quest workbook metadata typo.
 const quest=workbook([['INV001','46200','Invoice','192.06','0','0','0','7.75']]);
 const decoded=await page.evaluate(async data=>{const file=new File([Uint8Array.from(atob(data),c=>c.charCodeAt(0))],'Report.xlsx');const r=await GPCollectionFiles.readFile(file);const p=GPCollectionIntelligence.parseReport('glassquest',r.rows);return{rows:p.rows.length,balance:p.rows[0].open_balance,missing:p.rows[0].raw.customer_missing};},quest.toString('base64'));
 assert.deepEqual(decoded,{rows:1,balance:7.75,missing:true});
 const ms=workbook([['Customer','Inv #','Type','Date','Balance','Amt'],['Example Customer','200','I','46200','25','50']]);
 await page.locator('#uploadMainstreet').setInputFiles({name:'mainstreet.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:ms});await page.locator('#importPreview').waitFor({state:'visible'});
 await page.locator('#importAsOf').fill('2026-11-18');await page.locator('#importScope').selectOption('full');await page.getByRole('button',{name:'Save reviewed snapshot'}).click();await page.locator('#importPreview').waitFor({state:'hidden'});assert.equal(await page.evaluate(()=>window.__rpc.some(r=>r.name==='gp_collections_commit_snapshot')),true);
 await page.getByRole('tab',{name:'Collection queue',exact:true}).click();await page.locator('#resetFilters').click();
 fs.mkdirSync('test-results',{recursive:true});await page.screenshot({path:'test-results/collections-desktop-light.png',fullPage:true});
 await page.evaluate(()=>document.documentElement.dataset.gpTheme='dark');await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'collections mobile fits');await page.screenshot({path:'test-results/collections-mobile-dark.png',fullPage:true});
 await page.goto(base+'/quotes.html');await page.locator('#quoteSyncStatus').filter({hasText:'records loaded'}).waitFor();await page.locator('#quoteCsvUploadButton').click();
 const quoteCsv='Quote #,Customer,Quote Date,Total,Module\n101,Example Customer,11/1/2026,50,Auto\n102,Example Customer,11/18/2026,60,Auto\n';
 await page.locator('#csvFileInput').setInputFiles({name:'Quotes.csv',mimeType:'text/csv',buffer:Buffer.from(quoteCsv)});await page.locator('#csvUploadReportBox').filter({hasText:'1 new quotes saved'}).waitFor();assert.match(await page.locator('#csvUploadReportBox').textContent(),/1 new quotes for returning customers/);assert.equal(await page.evaluate(()=>window.__tables.outstanding_quotes.length),2);
 await page.evaluate(()=>{window.__failQuotes=true;});await page.locator('#csvUploadModal button').first().click();await page.locator('#refreshQuotesButton').click();await page.locator('#quoteSyncStatus').filter({hasText:'Refresh failed'}).waitFor();assert.equal(await page.locator('#quoteTableBody tr').count(),2,'load error retains previously fetched quotes');
 await page.evaluate(()=>{window.__failQuotes=false;window.__tables.outstanding_quotes.push({quote_number:103,customer_name:'Another Customer',status:'open',parts:[],module:'Auto',total:20});});await page.locator('#refreshQuotesButton').click();await page.locator('#quoteSyncStatus').filter({hasText:'3 records loaded'}).waitFor();assert.equal(await page.locator('#quoteTableBody tr').count(),3,'refresh reads new quotes');
 assert.deepEqual(errors,[],'no uncaught browser errors');console.log('PASS: collections evidence, notes registry, XLSX preview, clearance, mobile layout, returning-customer quotes, fresh reads and error recovery');
 }finally{await browser?.close();server.kill('SIGTERM');}})().catch(e=>{console.error(e);process.exitCode=1;});
