/* Worksite calendar and missed-punch policy. All boundaries use Eastern time. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.GP_TIME=api;})(globalThis,function(){
 'use strict';
 const zone='America/New_York';
 function parts(value=Date.now()){return Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date(value)).filter(p=>p.type!=='literal').map(p=>[p.type,p.value]));}
 function day(value=Date.now()){const p=parts(value);return `${p.year}-${p.month}-${p.day}`;}
 function validDay(value){if(!/^\d{4}-\d{2}-\d{2}$/.test(value||''))return false;const d=new Date(value+'T12:00:00Z');return Number.isFinite(+d)&&d.toISOString().slice(0,10)===value;}
 function addDays(value,amount){if(!validDay(value))throw Error('Choose a valid calendar date.');const d=new Date(value+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+amount);return d.toISOString().slice(0,10);}
 function week(value=day()){if(!validDay(value))throw Error('Choose a valid week.');const dow=new Date(value+'T12:00:00Z').getUTCDay();return addDays(value,-((dow+6)%7));}
 function inWeek(value,start){return validDay(value)&&value>=start&&value<=addDays(start,6);}
 function wallTime(date,time){const [y,m,d]=date.split('-').map(Number),[h,min]=time.split(':').map(Number),target=Date.UTC(y,m-1,d,h,min);let ms=target;for(let n=0;n<3;n++){const p=parts(ms);const wall=Date.UTC(+p.year,+p.month-1,+p.day,+p.hour,+p.minute,+p.second);ms+=target-wall;}return ms;}
 function policy(start){const p=parts(start),date=day(start),emergency=Number(p.hour)*3600+Number(p.minute)*60+Number(p.second)>18*3600||(p.hour==='18'&&p.minute==='00'&&p.second==='00'&&Number(start)%1000>0);return{emergency,dueAt:wallTime(addDays(date,1),emergency?'07:30':'00:01'),endAt:wallTime(emergency?addDays(date,1):date,emergency?'07:30':'17:00')};}
 function hours(value){const s=String(value??'').trim();return /^\d+(?:\.\d+)?$/.test(s)&&Number.isFinite(Number(s))?Math.round(Number(s)*100):0;}
 function own(row,user){return row.auth_user_id?String(row.auth_user_id)===String(user.auth_user_id):String(row.employee_name||'').trim().toLowerCase()===String(user.employee_name||'').trim().toLowerCase();}
 function summary(rows,user,start){const shifts=rows.filter(r=>own(r,user)&&inWeek(r.work_date,start)).sort((a,b)=>b.work_date.localeCompare(a.work_date)||String(b.clock_in||'').localeCompare(String(a.clock_in||'')));return{rows:shifts,hours:shifts.reduce((n,r)=>n+hours(r.decimal_hours),0)/100,unpaidMinutes:shifts.reduce((n,r)=>n+Math.max(0,Number(r.break_minutes)||0),0),review:shifts.filter(r=>r.clock_out_review_status==='pending'||r.lunch_review_status==='pending').length};}
 return{zone,parts,day,validDay,addDays,week,inWeek,wallTime,policy,summary};
});
