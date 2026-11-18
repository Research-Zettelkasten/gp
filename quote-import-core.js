/* Import identity is the quote number. Returning customers may have new quotes. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.GPQuoteImportCore=api;})(typeof window!=='undefined'?window:globalThis,function(){'use strict';
function parse(rows,csr,today){
 if(!Array.isArray(rows)||!rows.length)throw Error('The CSV is empty.');
 const columns=Object.keys(rows[0]).map(k=>k.trim());if(!columns.some(k=>k==='Quote #'||k==='quote_number')||!columns.includes('Customer'))throw Error('Use the Mainstreet Quotes export with Quote # and Customer columns.');
 const grouped=new Map();
 const money=v=>{const s=String(v??'').trim();if(!s)return 0;if(!/^-?\$?[\d,]+(?:\.\d{1,2})?$/.test(s))throw Error('A quote amount is not readable.');return Math.round(Number(s.replace(/[$,]/g,''))*100)/100;};
 rows.forEach((row,index)=>{
  const r=Object.fromEntries(Object.entries(row).map(([k,v])=>[k.trim(),v])),raw=String(r['Quote #']||r.quote_number||'').trim();if(!raw&&!String(r.Customer||'').trim())return;
  if(!/^\d+$/.test(raw)||!Number.isSafeInteger(Number(raw))||Number(raw)<=0)throw Error(`Row ${index+2}: invalid Quote #. Nothing was imported.`);
  const number=Number(raw),customer=String(r.Customer||'').trim();if(!customer)throw Error(`Row ${index+2}: customer is missing.`);
  if(grouped.has(number)&&grouped.get(number).customer_name.toUpperCase()!==customer.toUpperCase())throw Error(`Quote #${raw} has conflicting customer names.`);
  if(!grouped.has(number)){
   const cell=String(r.Cell||'').trim(),phone=String(r.Phone||'').trim();
   grouped.set(number,{quote_number:number,customer_name:customer,quote_date:String(r['Quote Date']||today).trim(),module:String(r.Module||'Auto').trim(),phone:cell||phone||'N/A',has_cell:!!cell,subtotal:money(r.Subtotal),tax:money(r.Tax),total:money(r.Total),csr:String(r.CSR||csr).trim(),parts:[],status:'open',contact_attempts:0,call_data:null});
  }
  const part=String(r.Part||'').trim(),desc=String(r['Desc.']||'').trim();if(part||desc)grouped.get(number).parts.push({category:String(r.Category||'').trim(),part,desc,qty:Number(r['Qty.'])||1,total:money(r['Part Total'])});
 });
 if(!grouped.size)throw Error('No valid quotes were found.');if(grouped.size>5000)throw Error('Import at most 5,000 quotes per file.');return [...grouped.values()];
}
function partition(candidates,existing){const numbers=new Set(existing.map(q=>String(q.quote_number))),names=new Set(existing.map(q=>q.customer_name.trim().toUpperCase().replace(/\s+/g,' '))),accepted=[],duplicates=[],returning=[];for(const q of candidates){if(numbers.has(String(q.quote_number))){duplicates.push(q);continue;}accepted.push(q);numbers.add(String(q.quote_number));if(names.has(q.customer_name.trim().toUpperCase().replace(/\s+/g,' ')))returning.push(q);}return{accepted,duplicates,returning};}
return{parse,partition};
});
