/* GLASSPRO 2.0 appearance. Local fallback, cloud sync for accounts with UI preferences migration. */
(() => {
 'use strict';
 let client=null,profile=null,theme=localStorage.getItem('gp2_theme_default')==='dark'?'dark':'light';
 function setTheme(next,persist=true){theme=next==='dark'?'dark':'light';document.documentElement.dataset.gpTheme=theme;localStorage.setItem('gp2_theme_default',theme);document.querySelectorAll('.gp2-display-switch').forEach(b=>b.textContent=theme==='dark'?'☀ Light mode':'☾ Dark mode');if(persist)saveTheme().catch(()=>{});}
 async function saveTheme(){if(!client||!profile?.auth_user_id)return;await client.rpc('gp_save_ui_preferences',{p_preferences:{theme}});}
 async function onSignedIn(p,c){profile=p;client=c;try{const {data,error}=await client.from('portal_preferences').select('ui_preferences').eq('auth_user_id',p.auth_user_id).maybeSingle();if(!error&&data?.ui_preferences?.theme)setTheme(data.ui_preferences.theme,false);}catch{} }
 function addToggle(){if(document.querySelector('.gp2-display-switch'))return;const b=document.createElement('button');b.type='button';b.className='gp2-display-switch';b.textContent=theme==='dark'?'☀ Light mode':'☾ Dark mode';b.addEventListener('click',()=>setTheme(theme==='dark'?'light':'dark'));(document.querySelector('header .header-right')||document.querySelector('header')||document.body).appendChild(b);}
 document.addEventListener('DOMContentLoaded',()=>{setTheme(theme,false);addToggle();});
 window.GP_UX={onSignedIn,setTheme};
})();
