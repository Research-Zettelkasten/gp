/* Administrator dialog for audited server-side clock-out. */
(function adminClock(){
'use strict';
let config=null,selected=null,busy=false,opener=null;
const id=x=>document.getElementById(x);
function setBusy(value){busy=value;for(const el of id('gpClockForm').querySelectorAll('button,input,textarea,select'))el.disabled=value;}
function updatePreview(){
  if(!selected)return;
  const custom=id('gpClockMode').value==='custom';id('gpClockCustomRow').hidden=!custom;id('gpClockEnd').required=custom;
  const end=custom?Date.parse(id('gpClockEnd').value):Date.now();
  id('gpClockConfirm').disabled=busy||!Number.isFinite(end);
  if(!Number.isFinite(end)){id('gpClockPreview').textContent='Enter the actual clock-out date and time.';return;}
  const view=GP_CLOCK.preview(selected,end);
  id('gpClockPreview').textContent=view.grossMinutes>0?view.hours.toFixed(2)+' estimated paid hours · '+view.breakMinutes+' unpaid lunch minutes':'Clock-out must be after clock-in.';
}
async function open(button){
  if(busy||!config?.getUser()?.perm_admin)return;
  const userId=button.dataset.clockUser,start=Number(button.dataset.clockStart);
  opener=button;selected=null;id('gpClockForm').reset();id('gpClockStatus').textContent='Checking the active shift…';
  id('gpClockEmployee').textContent='Loading employee…';id('gpClockSession').textContent='';
  id('gpClockPreview').textContent='';id('gpClockCloseLunchRow').hidden=true;
  id('gpClockEnd').value=GP_CLOCK.localInput();id('gpClockEnd').max=GP_CLOCK.localInput();id('gpClockCustomRow').hidden=true;
  id('gpClockDialog').showModal();setBusy(true);
  try{
    const session=await GP_CLOCK.readActive(config.client,userId);
    if(!session||Number(session.started_at_ms)!==start)throw new Error('This shift changed or already ended. Close this window and refresh the active shifts.');
    selected=session;id('gpClockEmployee').textContent=session.employee_name;
    id('gpClockSession').textContent='Clocked in '+new Date(Number(session.started_at_ms)).toLocaleString([],{dateStyle:'medium',timeStyle:'short'});
    id('gpClockEnd').min=GP_CLOCK.localInput(Number(session.started_at_ms)+60000);
    const onLunch=!!session.lunch_out_at&&!session.lunch_in_at;id('gpClockCloseLunchRow').hidden=!onLunch;
    id('gpClockTimezone').textContent='Time shown in '+Intl.DateTimeFormat().resolvedOptions().timeZone+'. Timecards use America/New_York.';
    id('gpClockStatus').textContent='';setBusy(false);updatePreview();id('gpClockReason').focus();
  }catch(e){setBusy(false);id('gpClockConfirm').disabled=true;id('gpClockStatus').textContent=String(e.message||e);id('gpClockCancel').focus();}
}
function mount(options){
  if(config)return;config=options;
  document.getElementById('adminActiveTimeTable')?.addEventListener('click',event=>{
    const button=event.target.closest('button[data-clock-user]');if(button&&!button.disabled)open(button);
  });
  id('gpClockCancel').addEventListener('click',()=>{if(!busy)id('gpClockDialog').close();});
  id('gpClockDialog').addEventListener('cancel',e=>{if(busy)e.preventDefault();});
  id('gpClockDialog').addEventListener('close',()=>{if(opener?.isConnected)opener.focus();});
  id('gpClockMode').addEventListener('change',updatePreview);id('gpClockEnd').addEventListener('input',updatePreview);
  id('gpClockForm').addEventListener('submit',async event=>{
    event.preventDefault();if(busy||!selected)return;
    if(selected.lunch_out_at&&!selected.lunch_in_at&&!id('gpClockCloseLunch').checked){
      id('gpClockStatus').textContent='Confirm that the open lunch should end at clock-out, or review the lunch punches first.';id('gpClockCloseLunch').focus();return;
    }
    const custom=id('gpClockMode').value==='custom';
    const options={employeeId:selected.auth_user_id,startedAtMs:Number(selected.started_at_ms),
      reason:id('gpClockReason').value,endedAt:custom?new Date(id('gpClockEnd').value).toISOString():null,
      closeLunch:id('gpClockCloseLunch').checked};
    setBusy(true);id('gpClockStatus').textContent='Saving the shift and audit record…';
    let result;
    try{result=await GP_CLOCK.finishShift(config.client,options);}
    catch(e){setBusy(false);id('gpClockStatus').textContent=String(e.message||e);return;}
    setBusy(false);id('gpClockDialog').close();
    const message=result.already_closed?'This shift was already clocked out; no duplicate was created.':'Clocked out '+selected.employee_name+'. Shift and audit record saved.';
    config.onSaved?.(message);selected=null;
  });
}
globalThis.GP_ADMIN_CLOCK={mount};
})();
