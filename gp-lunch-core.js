/* Time clock calculations with overnight-shift support; no forced break duration. */
(function(root){
  "use strict";
  function clockMinutes(value){
    if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(value||"")))return null;
    const [h,m]=value.split(":").map(Number);return h*60+m;
  }
  function manualInterval(start,end,lunchOut,lunchBack){
    const a=clockMinutes(start),b=clockMinutes(end),out=clockMinutes(lunchOut),back=clockMinutes(lunchBack);
    if(a===null||b===null)return {error:"Enter valid shift start and end times."};
    let finish=b;if(finish<=a)finish+=1440;
    if(finish-a>1440)return {error:"A shift cannot exceed 24 hours."};
    if((out===null)!==(back===null))return {error:"Enter both Lunch Out and Lunch Back, or leave both blank."};
    let unpaid=0;
    if(out!==null){
      let o=out;while(o<a)o+=1440;
      let r=back;while(r<=o)r+=1440;
      if(o<a||o>=finish||r>finish||r<=o)return {error:"Lunch Out and Lunch Back must fall within the shift, in that order."};
      unpaid=r-o;
    }
    const gross=finish-a;
    if(gross-unpaid<=0)return {error:"The shift must contain paid work time."};
    return {breakMinutes:unpaid,decimalHours:Math.round((gross-unpaid)/60*100)/100,grossMinutes:gross,lunchOut:lunchOut||null,lunchBack:lunchBack||null,error:null};
  }
  function minutesBetween(start,end){const a=Date.parse(start||""),b=Date.parse(end||"");return Number.isFinite(a)&&Number.isFinite(b)&&b>a?Math.max(1,Math.round((b-a)/60000)):0;}
  function liveBreakMinutes(state,nowMs=Date.now()){
    if(!state)return 0;
    if(state.lunch_out_at&&state.lunch_in_at)return minutesBetween(state.lunch_out_at,state.lunch_in_at);
    if(state.lunch_out_at){const start=Date.parse(state.lunch_out_at);return Number.isFinite(start)?Math.max(0,(nowMs-start)/60000):0;}
    return Math.max(0,Number(state.break_minutes)||0);
  }
  function localTime(iso){if(!iso)return null;const d=new Date(iso);if(!Number.isFinite(d.getTime()))return null;return `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;}
  root.GP_LUNCH=Object.freeze({manualInterval,minutesBetween,liveBreakMinutes,localTime});
})(typeof window!=="undefined"?window:globalThis);
