/* GLASSPRO 2.0 employee home: permissions-only links; user preference stored in Supabase. */
(() => {
'use strict';
let user=null,getTime=()=>[],saved={layout:'two',hidden:[]},draft=null;
const catalog=[
 {id:'time',name:'My Weekly Time',url:'index.html',permission:u=>u.perm_time||u.perm_admin},
 {id:'quotes',name:'Quote Call-Backs',url:'quotes.html',permission:u=>u.perm_quotes!==false},
 {id:'collections',name:'Collections',url:'collections.html',permission:u=>u.perm_collections===true||u.perm_admin},
 {id:'commission',name:'Commissions & Work Orders',url:'commissions.html',permission:u=>u.perm_commission||u.perm_admin},
 {id:'fleet',name:'Vehicle Check & Safety',url:'fleet.html',permission:u=>u.perm_vehicle_view||u.perm_vehicle_submit||u.perm_admin},
 {id:'admin',name:'Administration',url:'admin.html',permission:u=>u.perm_admin}
];
function monday(date){let d=new Date(date.getFullYear(),date.getMonth(),date.getDate());d.setDate(d.getDate()-((d.getDay()+6)%7));return d;}
function esc(x){return String(x).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function normalize(x){return {layout:x?.layout==='one'?'one':'two',hidden:Array.isArray(x?.hidden)?x.hidden.filter(v=>typeof v==='string'):[]};}
async function loadPrefs(){try{const c=window.GP?.getSupabaseClient?.();if(!c)return;const{data,error}=await c.from('portal_preferences').select('ui_preferences').eq('auth_user_id',user.auth_user_id).maybeSingle();if(!error&&data?.ui_preferences?.home)saved=normalize(data.ui_preferences.home);}catch{}}
function render(){const mount=document.getElementById('gp2StandaloneHome')||document.getElementById('gp2EmployeeHome');if(!mount||!user)return;const editable=!!draft;const prefs=editable?draft:saved;const allowed=catalog.filter(x=>x.permission(user));const days=getTime().filter(x=>{const d=new Date(String(x.work_date)+'T12:00:00'),start=monday(new Date()),end=new Date(start);end.setDate(end.getDate()+7);return d>=start&&d<end;});const hours=days.reduce((acc,x)=>acc+Number(x.decimal_hours||0),0);
mount.innerHTML=`<section class="gp2-home-toolbar"><button type="button" id="gp2Edit">${editable?'Editing workspace':'Customize my home'}</button>${editable?'<button id="gp2Save">Save & Lock</button><button id="gp2Cancel">Cancel</button>':''}<span class="gp2-home-status" id="gp2HomeStatus">${editable?'Preview your layout and save it to Supabase':'Personal workspace'}</span></section>`+
(editable?`<section class="gp2-home-editor"><strong>Display settings</strong><label>Columns <select id="gp2Columns"><option value="two" ${prefs.layout==='two'?'selected':''}>Two</option><option value="one" ${prefs.layout==='one'?'selected':''}>One</option></select></label>${allowed.map(w=>`<label><input type="checkbox" data-gp-card="${w.id}" ${!prefs.hidden.includes(w.id)?'checked':''}> ${esc(w.name)}</label>`).join('')}</section>`:'')+
`<section class="gp2-home-cards ${prefs.layout==='one'?'gp2-one':''}"><article class="gp2-home-card"><h3>My Current Week</h3><p>Monday–Sunday</p><strong>${hours.toFixed(2)} hours</strong><p>${days.length} recorded shifts</p></article>${allowed.filter(w=>!prefs.hidden.includes(w.id)).map(w=>`<article class="gp2-home-card"><h3>${esc(w.name)}</h3><p>Open your assigned workspace</p><a href="${w.url}">Open ${esc(w.name)}</a></article>`).join('')}</section>`;
mount.querySelector('#gp2Edit').onclick=()=>{if(!draft){draft=normalize(saved);render();}};
if(editable){mount.querySelector('#gp2Cancel').onclick=()=>{draft=null;render();};mount.querySelector('#gp2Columns').onchange=e=>{draft.layout=e.target.value;render();};mount.querySelectorAll('[data-gp-card]').forEach(input=>input.onchange=()=>{draft.hidden=allowed.filter(w=>!mount.querySelector(`[data-gp-card="${w.id}"]`).checked).map(w=>w.id);render();});mount.querySelector('#gp2Save').onclick=async()=>{const st=mount.querySelector('#gp2HomeStatus');st.textContent='Saving to Supabase…';try{const sessionClient=window.GP_HOME_CLIENT||window.GP?.getSupabaseClient?.();if(!sessionClient)throw Error('Supabase client unavailable');const next=normalize(draft);const {error}=await sessionClient.rpc('gp_save_ui_preferences',{p_preferences:{home:next}});if(error)throw error;saved=next;draft=null;render();}catch(e){st.textContent='Save failed: '+String(e.message||e);}};}}
function mount(p,fn,c){user=p;getTime=fn||(()=>[]);if(c)window.GP_HOME_CLIENT=c;loadPrefs().then(render);render();}
window.GP_HOME={mount,render};
})();
