/* Customer identity and directory parsing. No customer records are bundled. */
(function(root,factory){const api=factory(typeof module==='object'&&module.exports?require('./collections-core'):root.GPCollectionsCore);if(typeof module==='object'&&module.exports)module.exports=api;else root.GPCustomersCore=api;})(typeof window!=='undefined'?window:globalThis,function(C){'use strict';
const normalize=v=>String(v??'').normalize('NFKC').toUpperCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
const bool=v=>/^(true|yes|1)$/i.test(String(v??'').trim());
const textFields=['import_key','customer_number','customer_name','category','address','city','state','postal_code','phone','home_phone','work_phone','cell','fax','email','billing_code','sales_person','report_as_of','source_document','review_reason','source_excerpt'];
function parseDirectory(input){
 const rows=typeof input==='string'?C.csv(input):input;if(!rows?.length)throw Error('Customer file is empty.');
 const headers=rows[0].map(v=>String(v).replace(/^\ufeff/,'').trim().toLowerCase().replace(/\s+/g,'_'));
 if(!headers.includes('customer_name')||!headers.includes('import_key'))throw Error('Use the prepared customer registry CSV with customer_name and import_key headings.');
 const out=[],keys=new Set();for(let i=1;i<rows.length;i++){
  const raw=Object.fromEntries(headers.map((h,n)=>[h,String(rows[i][n]??'').trim()]));if(!Object.values(raw).some(Boolean))continue;
  const r=Object.fromEntries(textFields.map(k=>[k,raw[k]||'']));
  if(r.customer_name.length<2||r.customer_name.length>250||!r.import_key||keys.has(r.import_key))throw Error(`Row ${i+1}: missing name or duplicate import key. No records were imported.`);
  keys.add(r.import_key);
  for(const k of ['source_page','report_page']){const value=raw[k];if(value&&!/^\d{1,5}$/.test(value))throw Error(`Row ${i+1}: invalid source page.`);r[k]=value?Number(value):null;}
  r.ocr_confidence=raw.ocr_confidence?Number(raw.ocr_confidence):null;if(r.ocr_confidence!==null&&(!Number.isFinite(r.ocr_confidence)||r.ocr_confidence<0||r.ocr_confidence>100))throw Error(`Row ${i+1}: invalid OCR confidence.`);
  r.identity_review_required=bool(raw.identity_review_required);r.review_required=r.identity_review_required||bool(raw.review_required);
  if(r.report_as_of&&!/^\d{4}-\d{2}-\d{2}$/.test(r.report_as_of))throw Error(`Row ${i+1}: use YYYY-MM-DD for the source report date.`);
  out.push(r);
 }
 if(!out.length||out.length>5000)throw Error('Choose a directory with 1–5,000 customer rows.');
 return{rows:out,review:out.filter(r=>r.review_required).length,identityReview:out.filter(r=>r.identity_review_required).length};
}
function filterCustomer(c,f){
 const search=String(f.search||''),n=normalize(search),digits=search.replace(/\D/g,'');
 const phoneMatch=digits.length>=4&&/^[\d\s()+.\-]+$/.test(search)&&[c.phone,c.home_phone,c.work_phone,c.cell,c.fax].some(v=>String(v||'').replace(/\D/g,'').includes(digits));
 if(n&&!normalize([c.display_name,c.customer_number,c.phone,c.home_phone,c.work_phone,c.cell,c.fax,c.email,c.address,c.city,c.state_code,c.postal_code].join(' ')).includes(n)&&!phoneMatch)return false;
 if(f.status==='review'&&!c.review_required&&c.identity_status!=='review')return false;
 if(f.status==='verified'&&c.identity_status!=='verified')return false;
 if(f.category&&f.category!=='all'&&c.category!==f.category)return false;
 if(f.activity==='collections'&&!Number(c.active_invoice_count))return false;
 if(f.activity==='quotes'&&!Number(c.open_quote_count))return false;
 if(f.activity==='notes'&&!Number(c.shared_note_count))return false;
 return !c.archived;
}
function filterEvent(e,f){
 if(!f.reports&&e.kind==='report')return false;
 if(f.source&&f.source!=='all'&&e.source!==f.source)return false;
 const text=String(f.search||'').trim().toLowerCase();return !text||[e.title,e.body,e.related_record,JSON.stringify(e.details||{})].join(' ').toLowerCase().includes(text);
}
return{normalize,parseDirectory,filterCustomer,filterEvent};
});
