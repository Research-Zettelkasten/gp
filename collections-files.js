/* Local-only CSV/XLSX decoding. Nothing is uploaded before the preview is saved. */
(function(root){'use strict';
const MAX=30*1024*1024, utf8=new TextDecoder();
async function unzip(buffer){
 const bytes=new Uint8Array(buffer),view=new DataView(buffer);let end=-1;
 for(let i=bytes.length-22;i>=Math.max(0,bytes.length-65557);i--)if(view.getUint32(i,true)===0x06054b50){end=i;break;}
 if(end<0)throw Error('This is not a readable XLSX workbook. Save the export as CSV or XLSX.');
 const entries=view.getUint16(end+10,true);let at=view.getUint32(end+16,true),total=0;const files=new Map();
 if(entries>5000)throw Error('Workbook has too many parts. Export just the report sheet.');
 for(let n=0;n<entries;n++){
  if(at+46>bytes.length||view.getUint32(at,true)!==0x02014b50)throw Error('Damaged workbook directory.');
  const flags=view.getUint16(at+8,true),method=view.getUint16(at+10,true),size=view.getUint32(at+20,true),expanded=view.getUint32(at+24,true),len=view.getUint16(at+28,true),extra=view.getUint16(at+30,true),comment=view.getUint16(at+32,true),offset=view.getUint32(at+42,true);
  const name=utf8.decode(bytes.subarray(at+46,at+46+len));at+=46+len+extra+comment;
  total+=expanded;if(total>MAX)throw Error('Expanded workbook exceeds 30 MB. Export the report as CSV.');
  if(!/^(xl\/(worksheets\/sheet\d+\.xml|sharedStrings\.xml|workbook\.xml|_rels\/workbook\.xml\.rels))$/.test(name))continue;
  if(flags&1)throw Error('Password-protected workbooks are not supported.');
  if(offset+30>bytes.length||view.getUint32(offset,true)!==0x04034b50)throw Error('Damaged workbook entry.');
  const start=offset+30+view.getUint16(offset+26,true)+view.getUint16(offset+28,true);
  if(start+size>bytes.length)throw Error('Truncated workbook.');
  const compressed=bytes.subarray(start,start+size);let decoded;
  if(method===0)decoded=compressed;
  else if(method===8){
   if(typeof DecompressionStream==='undefined')throw Error('Your browser cannot read XLSX. Export as CSV or use a current browser.');
   const reader=new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();let count=0;const chunks=[];
   while(true){const part=await reader.read();if(part.done)break;count+=part.value.length;if(count>expanded||count>MAX){await reader.cancel();throw Error('Invalid workbook expansion size.');}chunks.push(part.value);}
   decoded=new Uint8Array(count);let pos=0;for(const chunk of chunks){decoded.set(chunk,pos);pos+=chunk.length;}
  }else throw Error('Unsupported workbook compression. Export as CSV.');
  if(decoded.length!==expanded)throw Error('Workbook entry length is invalid.');
  files.set(name,utf8.decode(decoded));
 }
 return files;
}
function xml(text){if(/<!DOCTYPE|<!ENTITY/i.test(text))throw Error('Workbook XML contains unsupported declarations.');const doc=new DOMParser().parseFromString(text,'application/xml');if(doc.getElementsByTagName('parsererror').length)throw Error('Workbook XML is damaged.');return doc;}
const tags=(node,name)=>Array.from(node.getElementsByTagNameNS('*',name));
async function readFile(file){
 if(file.size>10*1024*1024)throw Error('Choose a CSV or XLSX file smaller than 10 MB.');
 const bytes=await file.arrayBuffer();
 if(/\.csv$/i.test(file.name)){const t=new Uint8Array(bytes);return{rows:root.GPCollectionsCore.csv((t[0]===255&&t[1]===254?new TextDecoder('utf-16le'):utf8).decode(bytes)),bytes,sheet:null};}
 if(!/\.xlsx$/i.test(file.name))throw Error('Choose a CSV or XLSX file.');
 const files=await unzip(bytes),book=xml(files.get('xl/workbook.xml')||''),rels=xml(files.get('xl/_rels/workbook.xml.rels')||'');
 const sheets=tags(book,'sheet');if(sheets.length!==1)throw Error('Export a workbook with just one report sheet so the wrong sheet cannot be imported.');
 const id=sheets[0].getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships','id');
 const rel=tags(rels,'Relationship').find(r=>r.getAttribute('Id')===id),target=rel?.getAttribute('Target')||'';
 const path=target.startsWith('/')?target.slice(1):'xl/'+target.replace(/^\.\//,'');
 if(!/^xl\/worksheets\/sheet\d+\.xml$/.test(path)||!files.has(path))throw Error('The report worksheet could not be found.');
 const strings=files.has('xl/sharedStrings.xml')?tags(xml(files.get('xl/sharedStrings.xml')),'si').map(si=>tags(si,'t').map(t=>t.textContent).join('')):[];
 const rows=[];for(const row of tags(xml(files.get(path)),'row')){
  const out=[];for(const cell of tags(row,'c')){
   const ref=cell.getAttribute('r')||'',letters=ref.match(/^[A-Z]+/)?.[0];if(!letters)throw Error('A worksheet cell has no position.');
   let col=0;for(const c of letters)col=col*26+c.charCodeAt(0)-64;if(col>200)throw Error('Report has too many columns.');
   const value=tags(cell,'v')[0]?.textContent??'',type=cell.getAttribute('t');
   if(tags(cell,'f').length)throw Error('Formula cells are not imported. Export the report as values or CSV.');
   out[col-1]=type==='s'?(strings[Number(value)]??''):type==='inlineStr'?tags(cell,'t').map(t=>t.textContent).join(''):value;
  }
  if(out.some(v=>String(v??'').trim()))rows.push(Array.from({length:out.length},(_,i)=>out[i]??''));
  if(rows.length>20050)throw Error('Report exceeds 20,000 data rows.');
 }
 return{rows,bytes,sheet:sheets[0].getAttribute('name')};
}
root.GPCollectionFiles={readFile};
})(typeof window!=='undefined'?window:globalThis);
