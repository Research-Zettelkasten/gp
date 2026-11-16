/* Shared, server-backed shift completion. No service credentials are used. */
(function clockCore(){
  'use strict';
  const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  function validate(options,now=Date.now()){
    const o=options||{},start=Number(o.startedAtMs),admin=o.employeeId!=null;
    if(!Number.isSafeInteger(start)||start<=0)throw new Error('Refresh the active shift before clocking out.');
    if(admin&&!uuid.test(o.employeeId))throw new Error('Select a confirmed employee account.');
    const reason=String(o.reason||'').trim(),noLunch=String(o.noLunchReason||'').trim();
    if(admin&&(reason.length<10||reason.length>500))throw new Error('Enter an audit reason of 10–500 characters.');
    if(noLunch.length>1000)throw new Error('The no-lunch explanation must be 1,000 characters or fewer.');
    const end=o.endedAt?Date.parse(o.endedAt):now;
    if(!Number.isFinite(end)||end<=start||end>now+1000)throw new Error('Clock-out must be after clock-in and cannot be in the future.');
    if(end-start>=24*3600000)throw new Error('Choose the actual end time within 24 hours of clock-in; older shifts need a timecard review.');
    if(!admin&&o.endedAt)throw new Error('Employee clock-out uses the server’s current time.');
    return {p_expected_start_ms:start,p_employee_id:admin?o.employeeId:null,p_ended_at:admin&&o.endedAt?new Date(end).toISOString():null,
      p_reason:reason,p_no_lunch_reason:noLunch,p_close_lunch:admin&&o.closeLunch===true,
      p_location:String(o.location||'').slice(0,500),p_coords:String(o.coords||'').slice(0,100)};
  }
  function preview(session,endMs=Date.now()){
    const start=Number(session?.started_at_ms),out=Date.parse(session?.lunch_out_at||''),back=Date.parse(session?.lunch_in_at||'');
    const gross=(Math.floor(endMs/60000)-Math.floor(start/60000));
    let unpaid=Number.isFinite(out)?Math.floor((Number.isFinite(back)?back:endMs)/60000)-Math.floor(out/60000):Math.max(0,Number(session?.break_minutes)||0);
    unpaid=Math.max(0,unpaid);
    return {grossMinutes:gross,breakMinutes:unpaid,hours:Math.max(0,(gross-unpaid)/60),onLunch:Number.isFinite(out)&&!Number.isFinite(back)};
  }
  async function confirmedWithin(request){
    let timer;
    try{return await Promise.race([request,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('The server has not confirmed the request. Refresh the shift before retrying; repeating a confirmed clock-out will not create a duplicate.')),20000);})]);}
    finally{clearTimeout(timer);}
  }
  async function readActive(client,userId){
    if(!client)throw new Error('Reconnect to GLASSPRO before reviewing an active shift.');
    const {data,error}=await confirmedWithin(client.from('active_time_sessions').select('*').eq('auth_user_id',userId).maybeSingle());
    if(error)throw error;return data||null;
  }
  async function finishShift(client,options){
    if(!client)throw new Error('Reconnect before clocking out. Your active shift has been preserved.');
    const payload=validate(options),{data,error}=await confirmedWithin(client.rpc('gp_finish_active_shift',payload));
    if(error){
      if(error.code==='PGRST202'||/could not find.*gp_finish_active_shift|function.*gp_finish_active_shift.*does not exist/i.test(error.message||''))
        throw new Error('The clock-out update is not installed in Supabase yet. Run the supplied 2026-11-16-admin-clock-out.sql migration first.');
      throw error;
    }
    if(data?.ok!==true)throw new Error('The server did not confirm clock-out. Refresh the shift before retrying.');
    return data;
  }
  function localInput(ms=Date.now()){
    const d=new Date(ms),pad=x=>String(x).padStart(2,'0');
    return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate())+'T'+pad(d.getHours())+':'+pad(d.getMinutes());
  }
  globalThis.GP_CLOCK=Object.freeze({validate,preview,readActive,finishShift,localInput});
})();
