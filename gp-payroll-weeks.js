/* Monday-Sunday payroll range helpers. Use date-only values (YYYY-MM-DD), not UTC timestamps. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;root.GP_PAYROLL_WEEKS=api;})(typeof window!=='undefined'?window:globalThis,function(){
 'use strict';const KEY='gp_payroll_week_monday_v1';
 function validDate(s){if(!/^\d{4}-\d{2}-\d{2}$/.test(String(s||'')))return false;const d=new Date(s+'T12:00:00');return !isNaN(d)&&[d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-')===s;}
 function dateObj(s){if(!validDate(s))throw Error('Invalid payroll date: '+s);return new Date(Number(s.slice(0,4)),Number(s.slice(5,7))-1,Number(s.slice(8,10)),12);}
 function iso(d){return [d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-');}
 function today(){return iso(new Date());}
 function shiftDays(s,days){const d=dateObj(s);d.setDate(d.getDate()+days);return iso(d);}
 function monday(s){const d=dateObj(s);d.setDate(d.getDate()-((d.getDay()+6)%7));return iso(d);}
 function range(value){const mon=monday(value);const sun=shiftDays(mon,6);const disp=s=>dateObj(s).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});return {monday:mon,sunday:sun,label:`${disp(mon)} – ${disp(sun)}`};}
 function inWeek(value,mon){return validDate(value)&&value>=monday(mon)&&value<=shiftDays(monday(mon),6);}
 function shiftWeeks(mon,count){return shiftDays(monday(mon),7*(Number(count)||0));}
 function readSavedWeek(){try{const val=localStorage.getItem(KEY);return validDate(val)?monday(val):monday(today());}catch(_){return monday(today());}}
 function saveWeek(val){try{localStorage.setItem(KEY,monday(val));}catch(_){}return monday(val);}
 return {validDate,today,monday,range,inWeek,shiftWeeks,readSavedWeek,saveWeek,shiftDays};
});
