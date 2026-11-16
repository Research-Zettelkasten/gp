/* GLASSPRO employee workspace: verified permissions and persisted home layouts. */
(function employeeHome(){
'use strict';
let user=null,client=null,getTime=()=>[],saved=GP_HOME_CORE.normalize({}),draft=null,session=null,summaryReady=false,shiftReady=false,saving=false,request=0;
const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const mountNode=()=>document.getElementById('gp2StandaloneHome')||document.getElementById('gp2EmployeeHome');
async function loadPrefs(){
  const ticket=++request;
  try{
    const {data,error}=await client.from('portal_preferences').select('ui_preferences').eq('auth_user_id',user.auth_user_id).maybeSingle();
    if(!error&&ticket===request&&!draft&&data?.ui_preferences?.home){saved=GP_HOME_CORE.normalize(data.ui_preferences.home);render();}
  }catch{}
}
function render(){
  const mount=mountNode();if(!mount||!user)return;
  const editable=!!draft,prefs=draft||saved,allowed=GP_HOME_CORE.allowed(user),byId=new Map(allowed.map(x=>[x.id,x]));
  const ordered=prefs.order.filter(id=>byId.has(id)).map(id=>byId.get(id)),visible=ordered.filter(w=>!prefs.hidden.includes(w.id));
  const stats=GP_HOME_CORE.weekly(getTime()),canTime=user.perm_time===true||user.perm_admin===true;
  const first=String(user.employee_name||'').trim().split(/\s+/)[0]||'there',hour=new Date().getHours();
  const greeting=hour<12?'Good morning':hour<17?'Good afternoon':'Good evening';
  const hero=document.getElementById('gpHomeGreeting');if(hero)hero.textContent=greeting+', '+first;
  const date=document.getElementById('gpHomeDate');if(date)date.textContent=new Date().toLocaleDateString([],{weekday:'long',month:'long',day:'numeric'});
  const shiftLabel=!shiftReady?'Status unavailable':!session?'Off the clock':session.lunch_out_at&&!session.lunch_in_at?'On lunch':'Clocked in';
  const shiftDetail=session?'Since '+new Date(Number(session.started_at_ms)).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'}):'Open Time Clock when your workday begins.';
  mount.innerHTML=
    '<section class="gp-home-summary" aria-label="Your workday summary">'+
    (canTime?'<article class="gp-home-stat"><span class="gp-home-eyebrow">THIS WEEK</span><strong>'+(summaryReady?stats.hours.toFixed(2)+'<small> hrs</small>':'—')+'</strong><p>'+(summaryReady?stats.shifts+' recorded '+(stats.shifts===1?'shift':'shifts')+' · Monday–Sunday':'Timecard summary unavailable')+'</p></article>'+
    '<article class="gp-home-stat"><span class="gp-home-eyebrow">SHIFT STATUS</span><strong class="gp-home-shift-status">'+(shiftReady&&session?'<span class="gp-home-live-dot"></span>':'')+esc(shiftLabel)+'</strong><p>'+esc(shiftReady?shiftDetail:'Refresh to check your active shift.')+'</p><a href="index.html#timeLivePane">Open Time Clock <span aria-hidden="true">↗</span></a></article>':'')+
    '<article class="gp-home-stat"><span class="gp-home-eyebrow">YOUR WORKSPACE</span><strong>'+allowed.length+'<small> modules</small></strong><p>'+visible.length+' shown on your home page</p>'+(canTime&&summaryReady&&stats.pending?'<a href="index.html">'+stats.pending+' lunch '+(stats.pending===1?'review':'reviews')+' pending</a>':'<span class="gp-home-stat-note">Your tools, all in one place.</span>')+'</article></section>'+
    '<section class="gp2-home-toolbar" aria-label="Workspace controls"><div><h2>Your tools</h2><p>Pick up where your work takes you.</p></div><div class="gp-home-toolbar-actions"><button type="button" id="gp2Edit" '+(editable?'disabled':'')+'>'+ (editable?'Customizing…':'Customize home')+'</button>'+
    (editable?'<button type="button" id="gp2Save" '+(saving?'disabled':'')+'>'+(saving?'Saving…':'Save layout')+'</button><button type="button" id="gp2Cancel" '+(saving?'disabled':'')+'>Cancel</button>':'')+'</div></section>'+
    '<p class="gp2-home-status" id="gp2HomeStatus" role="status" aria-live="polite">'+(editable?'Choose cards, set columns, and use the arrows to reorder them.':'')+'</p>'+
    (editable?'<section class="gp2-home-editor" aria-label="Customize your home"><label class="gp-home-columns" for="gp2Columns">Layout <select id="gp2Columns"><option value="two" '+(prefs.layout==='two'?'selected':'')+'>Two columns</option><option value="one" '+(prefs.layout==='one'?'selected':'')+'>One column</option></select></label><div class="gp-home-editor-list">'+ordered.map((w,i)=>
      '<div class="gp-home-editor-row"><label><input type="checkbox" data-gp-card="'+w.id+'" '+(!prefs.hidden.includes(w.id)?'checked':'')+'> '+esc(w.name)+'</label><div><button type="button" data-move="'+w.id+'" data-step="-1" aria-label="Move '+esc(w.name)+' up" '+(i===0?'disabled':'')+'>↑</button><button type="button" data-move="'+w.id+'" data-step="1" aria-label="Move '+esc(w.name)+' down" '+(i===ordered.length-1?'disabled':'')+'>↓</button></div></div>').join('')+'</div></section>':'')+
    '<section class="gp2-home-cards '+(prefs.layout==='one'?'gp2-one':'')+'" aria-label="Your assigned modules">'+visible.map(w=>
      '<a class="gp2-home-card gp-home-tool" href="'+w.url+'"><span class="gp-home-tool-icon" aria-hidden="true">'+w.icon+'</span><div><h3>'+esc(w.name)+'</h3><p>'+esc(w.description)+'</p></div><span class="gp-home-tool-arrow" aria-hidden="true">↗</span></a>').join('')+'</section>'+
    (!visible.length?'<div class="gp-home-empty"><h3>'+(allowed.length?'Make this space yours':'Your workspace is getting ready')+'</h3><p>'+(allowed.length?'Choose Customize home to bring your cards back. Your modules are also in the sidebar.':'Ask your administrator to assign the tools you need.')+'</p></div>':'');
  mount.querySelector('#gp2Edit').onclick=()=>{draft=GP_HOME_CORE.normalize(saved);render();mount.querySelector('#gp2Columns')?.focus();};
  if(!editable)return;
  mount.querySelector('#gp2Cancel').onclick=()=>{draft=null;render();mount.querySelector('#gp2Edit')?.focus();};
  mount.querySelector('#gp2Columns').onchange=e=>{draft.layout=e.target.value;render();mount.querySelector('#gp2Columns')?.focus();};
  mount.querySelectorAll('[data-gp-card]').forEach(input=>input.onchange=()=>{
    const hidden=new Set(draft.hidden);if(input.checked)hidden.delete(input.dataset.gpCard);else hidden.add(input.dataset.gpCard);
    draft.hidden=[...hidden];const id=input.dataset.gpCard;render();mount.querySelector('[data-gp-card="'+id+'"]')?.focus();
  });
  mount.querySelectorAll('[data-move]').forEach(button=>button.onclick=()=>{
    const id=button.dataset.move,step=Number(button.dataset.step),visibleIds=ordered.map(w=>w.id),i=visibleIds.indexOf(id),other=visibleIds[i+step];
    if(!other)return;const a=draft.order.indexOf(id),b=draft.order.indexOf(other);[draft.order[a],draft.order[b]]=[draft.order[b],draft.order[a]];
    render();mount.querySelector('[data-move="'+id+'"][data-step="'+step+'"]:not(:disabled)')?.focus();
  });
  mount.querySelector('#gp2Save').onclick=async()=>{
    if(saving)return;
    saving=true;const next=GP_HOME_CORE.normalize(draft);render();
    mount.querySelectorAll('input,select,[data-move]').forEach(el=>el.disabled=true);
    try{
      const {error}=await client.rpc('gp_save_ui_preferences',{p_preferences:{home:next}});
      if(error)throw error;saved=next;draft=null;saving=false;render();
      mount.querySelector('#gp2HomeStatus').textContent='Your layout is saved.';
      mount.querySelector('#gp2Edit')?.focus();
    }catch(e){saving=false;render();mount.querySelector('#gp2HomeStatus').textContent='Your layout was not saved: '+String(e.message||e);}
  };
}
function mount(p,fn,c){user=p;getTime=fn||(()=>[]);client=c||globalThis.GP_HOME_CLIENT;summaryReady=true;render();if(client)loadPrefs();}
function updateData(state){if('session'in state){session=state.session;shiftReady=state.shiftReady!==false;}if('summaryReady'in state)summaryReady=state.summaryReady===true;if(!draft)render();}
globalThis.GP_HOME={mount,render,updateData};
})();
