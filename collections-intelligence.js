/* Deterministic report parsing and evidence assessment; no customer data bundled. */
(function(root,factory){const api=factory(typeof module==='object'&&module.exports?require('./collections-core.js'):root.GPCollectionsCore);if(typeof module==='object'&&module.exports)module.exports=api;else root.GPCollectionIntelligence=api;})(typeof window!=='undefined'?window:globalThis,function(C){'use strict';
const header=v=>String(v??'').toLowerCase().replace(/[\\#._/()-]/g,' ').replace(/\s+/g,' ').trim();
const date=v=>{
 const s=String(v??'').trim();if(!s)return null;
 const withTime=s.match(/^(\d{1,2}\/\d{1,2}\/\d{2,4})\s+\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AP]M)?$/i);if(withTime)return date(withTime[1]);
 if(/^\d{5}(?:\.\d+)?$/.test(s)){const n=Number(s);if(n<20000||n>80000)return null;return new Date(Date.UTC(1899,11,30)+Math.floor(n)*86400000).toISOString().slice(0,10);}
 let m=s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);if(m)return C.iso(`${m[1]}/${m[2]}/20${m[3]}`);
 m=s.match(/^(\d{4}-\d{2}-\d{2})(?:[ T].*)?$/);if(m){const d=new Date(m[1]+'T00:00:00Z');return Number.isFinite(+d)&&d.toISOString().slice(0,10)===m[1]?m[1]:null;}
 const standard=C.iso(s);if(standard)return standard;
 m=s.match(/^(?:As of\s+)?([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/i);if(m){const mm=['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'].indexOf(m[1].slice(0,3).toLowerCase())+1;return mm?C.iso(`${mm}/${m[2]}/${m[3]}`):null;}return null;
};
function amount(v,required=false){
 let s=String(v??'').trim();if(/^\$?[\d,.]+-$/.test(s))s='-'+s.slice(0,-1);if(!s||s==='—'||s==='-'){if(required)throw Error('An invoice has a blank balance. Blank balances cannot verify settlement.');return null;}
 if(!/^(?:-?\$?\s*[\d,]+(?:\.\d{1,2})?|\(\$?\s*[\d,]+(?:\.\d{1,2})?\))$/.test(s))throw Error('A financial amount is not readable. Check the report columns.');
 return C.money(s);
}
const find=(heads,names)=>heads.findIndex(h=>names.includes(h));
const rank=i=>i?[i?.report_as_of||String(i?.completed_at||i?.created_at||'').slice(0,10),i?.completed_at||i?.created_at||'',i?.id||''].join('|'):'';
const newest=imports=>[...imports].filter(i=>i.status==='complete').sort((a,b)=>rank(b).localeCompare(rank(a)));
const kind=i=>i.report_kind||'legacy';
function selectedImports(imports){const selected=new Map();for(const i of newest(imports)){const key=i.source+'|'+kind(i);if(!selected.has(key))selected.set(key,i);}return [...selected.values()];}
function parseReport(source,input){
 const rows=typeof input==='string'?C.csv(input):input;
 if(!Array.isArray(rows)||!rows.length)throw Error('The report is empty.');
 const preamble=rows.slice(0,35).flat().map(v=>String(v??'').trim());
 const asOf=rows.slice(0,35).map(r=>r.map(v=>String(v??'')).join(',').replace(/,+$/,'').trim()).find(v=>/^As of\s+/i.test(v));
 let result={source,rows:[],rejected:0,duplicates:0,report_as_of:asOf?date(asOf):null,report_kind:source==='glassquest'?'legacy_baseline':'open_invoices',warnings:[]};
 let hi=rows.findIndex(r=>{const h=r.map(header);return source==='mainstreet'?h.includes('customer')&&h.includes('inv')&&h.includes('balance'):source==='qbo'?h.includes('transaction type')&&h.includes('date')&&(h.includes('open balance')||h.includes('a r paid')):h.some(x=>['invoice','invoice number','inv','invoice no','document number'].includes(x))&&h.some(x=>['balance','open balance','amount'].includes(x));});
 const summary=source==='qbo'&&hi<0?rows.findIndex(r=>r.map(header).includes('current')&&r.map(header).includes('total')):-1;
 if(summary>=0){
  result.report_kind='account_summary';const h=rows[summary].map(header),total=h.indexOf('total');
  for(let ix=summary+1;ix<rows.length;ix++){const r=rows[ix],customer=String(r[0]??'').trim();if(!customer||/^(total|accrual|cash basis|[a-z]+day,)/i.test(customer))continue;
   const balance=amount(r[total]);if(balance===null)continue;
   result.rows.push(makeRow(source,customer,null,'account_summary',null,null,balance,balance,ix,{balance_present:true,report_row:ix+1,aging_columns:r.slice(1)}));
  }
  result.warnings.push('Customer totals only. This report cannot verify payment of an individual invoice.');return finish(result);
 }
 const bareQuest=source==='glassquest'&&hi<0&&rows.every(r=>r.length===8&&date(r[1])&&/^\s*(Invoice|Payment|Credit Invoice|Deposit|App Cr #.+)\s*$/i.test(String(r[2])));
 if(hi<0&&!bareQuest)throw Error('Report headings were not recognized. Use the Mainstreet AR Aging, QBO Collections / Invoice List, or GlassQuest receivables export.');
 const h=hi>=0?rows[hi].map(header):[],col=names=>find(h,names),pick=(r,names)=>{const ix=col(names);return ix<0?'':r[ix]??'';};
 if(source==='qbo'&&/invoice list|invoices and received payments/i.test(preamble.slice(0,5).join(' ')))result.report_kind='invoice_verification';
 if(bareQuest)result.warnings.push('GlassQuest has no headings or customer names. Invoice = A, date = B, type = C, original amount = D, remaining balance = E+F+G+H. Customer matching is required.');
 let group='';
 for(let ix=bareQuest?0:hi+1;ix<rows.length;ix++){
  const r=rows[ix];let customer,invoice,type,day,due,balance,original,raw={report_row:ix+1};
  if(bareQuest){invoice=String(r[0]??'').trim();type=String(r[2]).trim().toLowerCase();day=date(r[1]);original=amount(r[3],true);balance=+r.slice(4,8).reduce((s,v)=>s+(amount(v,true)||0),0).toFixed(2);customer='GlassQuest · customer not provided';raw={...raw,customer_missing:true,layout:'quest-eight-column',aging_values:r.slice(4,8),balance_present:true};}
  else if(source==='mainstreet'){
   customer=String(pick(r,['customer'])).trim();invoice=String(pick(r,['inv'])).trim();const t=String(pick(r,['type'])).trim().toUpperCase();type=({I:'invoice',P:'payment',D:'debit',C:'credit memo'})[t]||t.toLowerCase();
   if(!customer||!type||/^total/i.test(customer))continue;
   day=date(pick(r,['date']));due=null;balance=amount(pick(r,['balance']),type==='invoice');original=amount(pick(r,['amt','amount']));
   raw={...raw,balance_present:balance!==null,transaction_ref:String(pick(r,['tran','transaction number'])),ref1:pick(r,['ref 1']),ref2:pick(r,['ref 2']),ref3:pick(r,['ref 3']),address:pick(r,['address']),city:pick(r,['city']),state:pick(r,['state']),zip_code:pick(r,['zip code']),contact:pick(r,['contact']),phone:pick(r,['phone']),collection_notes:pick(r,['collection notes']),last_payment:pick(r,['last payment']),last_purchase:pick(r,['last purchase']),edi_status:pick(r,['edi status']),edi_activity:pick(r,['edi activity'])};
  }else{
   type=String(pick(r,['transaction type','type'])).trim().toLowerCase();
   const named=String(pick(r,['customer','customer name','customer full name','name'])).trim();
   if(source==='qbo'&&!type){const label=String(r[0]??'').trim();if(label&&!/^(total|accrual|cash basis|[a-z]+day,)/i.test(label))group=label;continue;}
   customer=named||group;invoice=String(pick(r,['num','invoice','invoice number','invoice no','document number','inv','number','no'])).trim();
   if(source==='glassquest'){type=type||'invoice';if(!customer){customer='GlassQuest · customer not provided';raw.customer_missing=true;}}
   if(!['invoice','payment','journal entry','credit memo','credit invoice','deposit','debit'].includes(type)){result.rejected++;continue;}
   if(!customer)throw Error(`Row ${ix+1} has no customer heading or customer name.`);
   day=date(pick(r,['date','invoice date','transaction date']));due=date(pick(r,['due date']));
   const b=pick(r,['open balance','balance','remaining balance','remaining amount','amount due']);balance=amount(b,type==='invoice');original=amount(pick(r,['amount','amt','original amount','total']));
   raw={...raw,balance_present:balance!==null,ar_paid:String(pick(r,['a r paid','paid','status'])).trim(),store_full_name:pick(r,['store full name']),source_customer_heading:customer};
  }
  raw.exported_fields=JSON.stringify(bareQuest?{invoice:r[0],original_date:r[1],type:r[2],original_amount:r[3],remaining_buckets:r.slice(4,8)}:Object.fromEntries(rows[hi].map((label,n)=>[String(label||'column_'+(n+1)),r[n]??''])));
  if(!day)throw Error(`Row ${ix+1} has an invalid transaction date.`);
  if(type==='invoice'&&!invoice)throw Error(`Row ${ix+1} has no invoice number. Invoice matching requires a number.`);
  if(type==='invoice'&&raw.ar_paid&&/^(paid|yes)$/i.test(raw.ar_paid)&&balance>0)throw Error(`Row ${ix+1} says paid but still has a positive balance. Review the report.`);
  const row=makeRow(source,customer,invoice||null,type,day,due,original??balance??0,balance??0,ix,raw);
  if(source==='mainstreet'){
   row.phone=String(pick(r,['phone'])||'')||null;row.contact=String(pick(r,['contact'])||'')||null;
   row.aging_bucket=['Over 120','Over 90','Over 60','Over 30','Current'].find(k=>(amount(pick(r,[header(k)]))||0)>0)||null;
  }
  row.days_past_due=source==='qbo'?(parseInt(pick(r,['past due','days past due']),10)||0):null;
  result.rows.push(row);
 }
 return finish(result);
}
function makeRow(source,customer,invoice,type,day,due,original,balance,ix,raw){
 const key=type==='invoice'?(raw.customer_missing?`GQ|${C.num(invoice)}`:C.stableKey(source,customer,invoice,'invoice',day,original,'')):C.stableKey(source,customer,invoice,type,day,original,'')+`|ROW${ix+1}`;
 return{source,external_key:key,case_key:type==='invoice'?key:null,customer_name:customer,normalized_customer:C.name(customer),invoice_number:invoice,transaction_type:type,transaction_date:day,due_date:due,days_past_due:null,original_amount:original,open_balance:balance,phone:null,contact:null,aging_bucket:null,raw};
}
function finish(result){
 const keys=new Map();result.rows=result.rows.filter(r=>{
  if(r.transaction_type!=='invoice')return true;const fingerprint=JSON.stringify([r.transaction_date,r.original_amount,r.open_balance,r.due_date,r.raw.ar_paid||'',r.raw.exported_fields]);
  if(keys.has(r.case_key)){if(keys.get(r.case_key)!==fingerprint)throw Error('The same customer/invoice has conflicting rows. Export one invoice per row; do not upload a line-item sales report.');result.duplicates++;return false;}keys.set(r.case_key,fingerprint);return true;
 });
 if(!result.rows.length)throw Error('The report contains no recognized records. Nothing was imported.');
 if(result.rejected)throw Error(`${result.rejected} unrecognized transaction rows. Nothing was imported; use the original supported report.`);
 if(result.rows.length>20000)throw Error('Report exceeds 20,000 records.');
 return result;
}
function evidenceIndex(imports,rows){const byImport=new Map(imports.map(i=>[i.id,i])),byCase=new Map(),byCustomerInvoice=new Map();for(const r of rows){if(r.transaction_type!=='invoice'||!r.case_key)continue;const i=byImport.get(r.import_id);if(!i||i.status!=='complete')continue;const value={...r,import:i},list=byCase.get(r.case_key)||[];list.push(value);byCase.set(r.case_key,list);if(r.customer_id&&r.invoice_number&&r.transaction_date){const key=[r.customer_id,C.num(r.invoice_number),r.transaction_date].join('|'),matches=byCustomerInvoice.get(key)||[];matches.push(value);byCustomerInvoice.set(key,matches);}}for(const map of [byCase,byCustomerInvoice])for(const list of map.values())list.sort((a,b)=>rank(b.import).localeCompare(rank(a.import)));return{byCase,byCustomerInvoice,byImport,imports:newest(imports)};}
function assess(c,index,today){
 const rows=index?.byCase.get(c.case_key)||[],known=source=>{
  const aliases=c.customer_id&&c.invoice_date?index?.byCustomerInvoice?.get([c.customer_id,C.num(c.invoice_number),c.invoice_date].join('|'))||[]:[];
  const candidates=[...rows,...aliases.filter(r=>r.case_key!==c.case_key&&(r.customer_identity_verified||['manual','verified_alias'].includes(c.customer_link_method)))].filter(r=>r.source===source).sort((a,b)=>rank(b.import).localeCompare(rank(a.import)));
  const row=candidates[0],i=index?.byImport.get(c[source+'_import_id']);
  const fallback=c[source+'_balance']==null?null:{source,open_balance:Number(c[source+'_balance']),import:i||null,raw:{},fallback:true};
  return row&&(!fallback||rank(row.import)>=rank(i))?row:fallback;
 };
 const qbo=known('qbo'),ms=known('mainstreet'),gq=known('glassquest');
 const open=index?.imports.find(i=>i.source==='qbo'&&kind(i)==='open_invoices'&&i.report_scope==='full');
 const coverageStart=[c.invoice_date,ms?.import?.report_as_of,gq?.import?.report_as_of].filter(Boolean).sort().at(-1)||'';
 const missing=!!(open&&open.report_as_of>=coverageStart&&(!qbo||rank(open)>rank(qbo.import))&&!rows.some(r=>r.import_id===open.id));
 const verified=!!(qbo&&!qbo.fallback&&kind(qbo.import)==='invoice_verification'&&qbo.raw?.balance_present===true&&Number(qbo.open_balance)===0&&(!c.invoice_date||qbo.import.report_as_of>=c.invoice_date)&&(!gq?.import||qbo.import.report_as_of>=gq.import.report_as_of)&&(!ms||Number(ms.open_balance)<=0||rank(qbo.import)>=rank(ms.import)));
 const clearedImport=index?.byImport.get(c.cleared_import_id);
 const reappeared=!!(c.cleared_at&&qbo&&Number(qbo.open_balance)>0&&qbo.import&&(clearedImport?rank(qbo.import)>rank(clearedImport):qbo.import.report_as_of>=(c.cleared_report_as_of||String(c.cleared_at).slice(0,10))&&qbo.import.completed_at>c.cleared_at));
 let category=c.legacy_unmatched?'unmatched':reappeared?'reappeared':c.status==='reconciled'?'archived':verified?'verified':missing?'missing':qbo&&Number(qbo.open_balance)>0?'open':qbo&&Number(qbo.open_balance)<0?'credit':'unverified';
 const labels={unmatched:'Match customer',reappeared:'Balance reappeared',archived:'Archived',verified:'Verified zero balance',missing:'Missing from QBO · verify',open:'Open in QBO',credit:'Credit / adjustment review',unverified:'Needs invoice evidence'};
 const balances=[ms,qbo,gq].filter(Boolean).map(r=>Number(r.open_balance)).filter(Number.isFinite);
 const invoiceDay=c.invoice_date&&date(c.invoice_date),age=invoiceDay&&today?Math.max(0,Math.floor((Date.parse(today)-Date.parse(invoiceDay))/86400000)):null;
 const latest=qbo?.import||ms?.import||gq?.import;const reportAge=latest?.report_as_of&&today?Math.floor((Date.parse(today)-Date.parse(latest.report_as_of))/86400000):null;
 return{category,label:labels[category],qbo,mainstreet:ms,glassquest:gq,missing,verified,reappeared,age,reportAge,amount:Math.max(0,...balances),sources:['mainstreet','qbo','glassquest'].filter(s=>known(s)),lastReport:latest?.report_as_of||null};
}
function filterCase(c,a,f,today,userId){
 if(c.legacy_linked_to)return false;
 if(f.status==='active'&&!((['open','contacted','promise','disputed'].includes(c.status)&&a.amount>0.005)||a.reappeared))return false;
 if(f.status&&f.status!=='active'&&f.status!=='all'&&c.status!==f.status)return false;
 if(f.source&&f.source!=='all'&&!a.sources.includes(f.source))return false;
 if(f.evidence&&f.evidence!=='all'&&a.category!==f.evidence)return false;
 if(f.age&&f.age!=='all'&&(a.age===null||(f.age==='0-30'?a.age>30:f.age==='31-60'?a.age<31||a.age>60:f.age==='61-90'?a.age<61||a.age>90:f.age==='91-120'?a.age<91||a.age>120:a.age<121)))return false;
 if(f.followup==='due'&&(!c.next_follow_up||c.next_follow_up>today))return false;
 if(f.followup==='none'&&c.next_follow_up)return false;
 if(f.assignee==='mine'&&c.assigned_to!==userId)return false;
 if(f.assignee==='none'&&c.assigned_to)return false;
 if(f.min!==''&&f.min!=null&&a.amount<Number(f.min))return false;
 if(f.max!==''&&f.max!=null&&a.amount>Number(f.max))return false;
 const needle=String(f.search||'').trim();if(needle&&!C.name([c.customer_name,c.invoice_number,c.phone,c.contact,c.source_collection_notes].join(' ')).includes(C.name(needle)))return false;
 return true;
}
return{date,amount,parseReport,rank,newest,kind,selectedImports,evidenceIndex,assess,filterCase};
});
