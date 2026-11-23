/* Immediate administrator correction; original server punches remain immutable. */
(()=>{'use strict';let config=null,row=null,busy=false,returnFocus=null,openRevision=0;
 const get=id=>document.getElementById(id),stamp=value=>new Date(value).toLocaleString('en-US',{timeZone:'America/New_York',dateStyle:'medium',timeStyle:'short'});
 function message(text){get('gpLiveCorrectionStatus').textContent=text;}
 function preview(){
  if(!row)return;const start=new Date(get('gpLiveCorrectionTime').value).getTime();
  get('gpLiveCorrectionPreview').textContent=Number.isFinite(start)?`${GP_CLOCK.preview({...row,approved_clock_in_at:new Date(start).toISOString()}).hours.toFixed(2)} estimated paid hours · recorded lunch punches stay in place.`:'Enter the actual start date and time.';
 }
 async function open(button){
  if(!config||busy||config.getUser()?.perm_admin!==true)return;
  const revision=++openRevision;returnFocus=button;row=null;get('gpLiveCorrectionForm').reset();message('Checking the active punch…');get('gpLiveCorrectionApply').disabled=true;
  get('gpLiveCorrectionRecorded').textContent='';get('gpLiveCorrectionPreview').textContent='';get('gpLiveCorrectionEmployee').textContent='';get('gpLiveCorrectionDialog').showModal();
  try{
   const r=await config.client.from('active_time_sessions').select('*').eq('auth_user_id',button.dataset.correctClockUser).maybeSingle();if(revision!==openRevision)return;if(r.error)throw r.error;
   if(!r.data||Number(r.data.started_at_ms)!==Number(button.dataset.correctClockStart))throw Error('This live shift changed or ended. Close this window and refresh.');
   row=r.data;get('gpLiveCorrectionEmployee').textContent=row.employee_name;get('gpLiveCorrectionRecorded').textContent='Original recorded punch: '+stamp(row.started_at)+(row.approved_clock_in_at?' · Currently approved: '+stamp(row.approved_clock_in_at):'');
   get('gpLiveCorrectionTime').value=GP_CLOCK.localInput(GP_TIME.effectiveStart(row));get('gpLiveCorrectionTime').max=GP_CLOCK.localInput(Date.now());get('gpLiveCorrectionTimezone').textContent='Entry shown in '+Intl.DateTimeFormat().resolvedOptions().timeZone+'. Recorded punch shown in America/New_York.';
   get('gpLiveCorrectionApply').disabled=false;message('');preview();get('gpLiveCorrectionTime').focus();
  }catch(error){message(error.message||'Could not verify this active punch.');}
 }
 function mount(options){
  if(config)return;config=options;const dialog=document.createElement('dialog');dialog.id='gpLiveCorrectionDialog';dialog.className='gp-live-correction-dialog';dialog.setAttribute('aria-labelledby','gpLiveCorrectionTitle');
  dialog.innerHTML='<form id="gpLiveCorrectionForm"><span class="gp-page-kicker">TIME &amp; ATTENDANCE</span><h2 id="gpLiveCorrectionTitle">Correct a live clock-in</h2><p>Apply the verified start immediately as an administrator. The original punch, lunch records and audit history stay attached to this shift.</p><strong id="gpLiveCorrectionEmployee"></strong><p id="gpLiveCorrectionRecorded"></p><label for="gpLiveCorrectionTime">Correct clock-in date and time</label><input id="gpLiveCorrectionTime" type="datetime-local" required><small id="gpLiveCorrectionTimezone"></small><label for="gpLiveCorrectionReason">Reason for correction</label><textarea id="gpLiveCorrectionReason" minlength="10" maxlength="1000" required rows="3" placeholder="Explain how you verified the actual work start."></textarea><div id="gpLiveCorrectionPreview"></div><p>A pending employee request for this shift will be marked as superseded and retained in history. This action does not clock the employee out.</p><div id="gpLiveCorrectionStatus" role="status" aria-live="polite"></div><div class="gp-clock-dialog-actions"><button type="button" id="gpLiveCorrectionCancel">Cancel</button><button type="submit" id="gpLiveCorrectionApply">Apply correction now</button></div></form>';
  document.body.append(dialog);get('gpLiveCorrectionTime').oninput=preview;
  get('gpLiveCorrectionCancel').onclick=()=>{if(!busy)dialog.close();};dialog.addEventListener('cancel',e=>{if(busy)e.preventDefault();});dialog.addEventListener('close',()=>{openRevision++;if(returnFocus?.isConnected)returnFocus.focus();});
  get('gpLiveCorrectionForm').onsubmit=async e=>{
   e.preventDefault();if(busy||!row)return;busy=true;get('gpLiveCorrectionApply').disabled=true;get('gpLiveCorrectionCancel').disabled=true;message('Saving correction and audit record…');
   try{
    const requested=new Date(get('gpLiveCorrectionTime').value);if(!Number.isFinite(+requested)||+requested>Date.now())throw Error('Choose an actual start that is not in the future.');
    const r=await config.client.rpc('gp_admin_correct_live_clock_in',{p_employee_id:row.auth_user_id,p_expected_start_ms:Number(row.started_at_ms),p_requested_at:requested.toISOString(),p_reason:get('gpLiveCorrectionReason').value.trim()});
    if(r.error)throw Error(r.error.code==='PGRST202'?'Run the navigation and administrator live-correction SQL update before applying this change.':r.error.message);
    if(r.data?.applied_to!=='active_shift')throw Error('The database did not confirm this correction. Refresh and verify the live punch.');
    dialog.close();config.onSaved?.('Clock-in corrected. Live hours recalculated and original punch retained.');window.GP_CLOCK_IN?.refreshAdmin?.().catch(()=>{});
   }catch(error){message(error.message||'The correction was not saved.');}
   finally{busy=false;get('gpLiveCorrectionApply').disabled=false;get('gpLiveCorrectionCancel').disabled=false;}
  };
  document.addEventListener('click',e=>{const b=e.target.closest('[data-correct-clock-user]');if(b&&!b.disabled)open(b);});
 }
 window.GP_ADMIN_LIVE={mount};
})();
