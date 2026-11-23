/* GLASSPRO hierarchical sidebar v2026.11.13.2.
 * Navigation visibility is a UX hint. Supabase Auth/RLS and page guards retain
 * responsibility for authorization. No browser-stored preference grants access.
 */
(() => {
  'use strict';
  const MODULE_GROUPS = [{key:'workspace',label:'MY TOOLS',links:GP_NAV_CORE.items.filter(i=>i.group==='workspace').map(i=>[i.id,i.label,i.icon])}];
  // Interior pages stay in their existing modules; the sidebar activates their
  // original (permission-checked) tab controls instead of duplicating workflows.
  const MODULE_SECTIONS = {
    navLinkTime:{path:'index.html',views:[
      ['timeLivePane','Live Punch Clock','timeSubBtnLive']]},
    navLinkQuotes:{path:'quotes.html',views:[
      ['board','Active Call-Back Board','tab-btn-board'],
      ['admin-review','Admin Review & Alerts','tab-btn-admin-review'],
      ['competitors','Competitor Manager','tab-btn-competitors']]},
    navLinkCollections:{path:'collections.html',views:[
      ['queue','Collection Queue','col-tab:queue'],
      ['reconcile','Source Reconciliation','col-tab:reconcile'],
      ['closeout','End-of-Day Closeout','col-tab:closeout'],
      ['imports','Import Center','col-tab:imports'],
      ['notes','Notes Registry','col-tab:notes']]},
    navLinkFleet:{path:'fleet.html',views:[
      ['inspectPane','Vehicle Check','subBtnInspect'],
      ['historyPane','Inspection History','subBtnHistory'],
      ['safetyPane','Safety & SOPs','subBtnSafety'],
      ['garagePane','Fleet Garage','subBtnGarage']]}
  };
  const ADMIN_VIEWS = [
    ['adminOverviewPane','Command Center','◫'],
    ['adminMOSPane','MultiplyOS Hub','▦'],
    ['adminUsersPane','People & Access','♙'],
    ['adminCommissionsPane','Work Orders & Commissions','▤'],
    ['adminTimePane','Time & Attendance','◷'],
    ['adminFleetPane','Activity History','≡']
  ];
  const ADMIN_IDS=new Set(ADMIN_VIEWS.map(v=>v[0]));
  const ADMIN_LABELS=Object.fromEntries(ADMIN_VIEWS.map(v=>[v[0],v[1]]));
  const storage={
    read(k, fallback){try{const raw=localStorage.getItem(k);return raw===null?fallback:JSON.parse(raw);}catch{return fallback;}},
    write(k,value){try{localStorage.setItem(k,JSON.stringify(value));}catch{}}
  };
  let nav=null, adminLink=null, adminGroup=null, adminExpander=null, adminSubmenu=null;
  let mobileTrigger=null, breadcrumb=null, currentPane=null, activeUserId=null, searchInput=null, homeLink=null;
  let prefs=null, moduleLinks=new Map(), adminSubLinks=new Map(), groupRecords=[];
  const moduleMenus=new Map();let verifiedProfile=null;
  let pins=new Set(), favourites=null, favouriteGroup=null;
  let personal=GP_NAV_CORE.normalize(),personalRevision=0,personalDirty=false,navClient=null,saveTimer=null,savePromise=null,cloudLoading=null,editDraft=null;
  let customizeDialog=null,customizeReturn=null,customizeStatus=null,teamPanel=null,searchEmpty=null;
  const TEAM_IDS=['adminUsersPane','adminCommissionsPane','adminTimePane','adminFleetPane'];
  const personalKey=()=>activeUserId?`gp_navigation_v1_${activeUserId}`:null;
  const currentItem=()=>isAdminPage()?(TEAM_IDS.includes(currentPane)?'navLinkAdmin':currentPane):(GP_NAV_CORE.items.find(i=>i.group==='workspace'&&(location.pathname.toLowerCase().endsWith('/'+i.path)||(/\/$/.test(location.pathname)&&i.id==='navLinkTime')))?.id||null);
  const permitted=id=>GP_NAV_CORE.allowed(verifiedProfile).some(i=>i.id===id);
  const shown=id=>permitted(id)&&GP_NAV_CORE.visible(personal,id,currentItem(),!!searchInput?.value.trim());

  const isAdminPage=()=>/(^|\/)admin\.html$/i.test(location.pathname);
  const currentModule=()=>/\/$/.test(location.pathname)?'navLinkTime':(Object.entries(MODULE_SECTIONS).find(([,m])=>location.pathname.toLowerCase().endsWith('/'+m.path.toLowerCase()))?.[0]||null);
  const adminEnabled=()=>!!(adminLink&&!adminLink.classList.contains('hidden'));
  const getUserPrefKey=()=>activeUserId?`gp_admin_dashboard_prefs_${activeUserId}`:null;
  function sanitizePrefs(raw){
    const r=raw&&typeof raw==='object'?raw:{};
    const candidate=Array.isArray(r.tabOrder)?r.tabOrder:[];
    const ordered=[...new Set([...candidate.filter(x=>ADMIN_IDS.has(x)),...ADMIN_VIEWS.map(x=>x[0])])];
    const hidden=new Set(Array.isArray(r.hiddenTabs)?r.hiddenTabs.filter(x=>ADMIN_IDS.has(x)):[]);
    if(hidden.size>=ADMIN_IDS.size)hidden.delete(ordered[0]);
    return {tabOrder:ordered,hiddenTabs:hidden,tabNames:r.tabNames&&typeof r.tabNames==='object'?r.tabNames:{}};
  }
  function makeLink(id,label,glyph){
    const anchor=moduleLinks.get(id);
    if(!anchor)return null;
    const previouslyActive=anchor.classList.contains('active')||anchor.getAttribute('aria-current')==='page';
    anchor.classList.remove('nav-btn','gp-nav-btn');
    anchor.classList.add('gp-side-link');
    anchor.replaceChildren();
    const icon=document.createElement('span');icon.className='gp-side-icon';icon.textContent=glyph;icon.setAttribute('aria-hidden','true');
    const title=document.createElement('span');title.className='gp-side-title';title.textContent=label;
    anchor.append(icon,title);anchor.title=label;
    if(previouslyActive){anchor.classList.add('active');anchor.setAttribute('aria-current','page');}
    return anchor;
  }
  function makeModuleRow(id,label,glyph){
    const anchor=makeLink(id,label,glyph);if(!anchor)return null;
    const row=document.createElement('div');row.className='gp-side-link-row';row.append(anchor);return row;
  }
  function addIconButton(parent,label,css,content,handler){
    const button=document.createElement('button');button.type='button';button.className=css;button.setAttribute('aria-label',label);button.title=label;button.textContent=content;
    button.addEventListener('click',handler);parent.append(button);return button;
  }
  function createDisclosure(key,label){
    const section=document.createElement('section');section.className='gp-side-group';section.dataset.group=key;
    const toggle=document.createElement('button');toggle.type='button';toggle.className='gp-side-group-toggle';
    const name=document.createElement('span');name.textContent=label;
    const chevron=document.createElement('span');chevron.className='gp-side-chevron';chevron.textContent='⌄';chevron.setAttribute('aria-hidden','true');
    toggle.append(name,chevron);
    const content=document.createElement('div');content.className='gp-side-group-links';content.id=`gp-side-group-${key}`;
    toggle.setAttribute('aria-controls',content.id);
    const savedClosed=personal.closedGroups.includes(key);
    const closed=savedClosed===true && !(isAdminPage()&&key==='administration');
    section.classList.toggle('is-closed',closed);toggle.setAttribute('aria-expanded',String(!closed));
    toggle.addEventListener('click',()=>{
      const closedNow=section.classList.toggle('is-closed');toggle.setAttribute('aria-expanded',String(!closedNow));personal.closedGroups=personal.closedGroups.filter(v=>v!==key);if(closedNow)personal.closedGroups.push(key);persistPersonal();
    });
    section.append(toggle,content);nav.append(section);
    groupRecords.push({section,content,key});return {section,content,toggle};
  }
  function sourceButton(marker){
    return marker.startsWith('col-tab:')
      ?document.querySelector(`.col-tab[data-tab="${marker.slice(8)}"]`)
      :document.getElementById(marker);
  }
  function sectionAllowed(moduleKey,sectionId,source){
    if(!verifiedProfile)return !source||!source.classList.contains('hidden');
    const u=verifiedProfile;
    if(moduleKey==='navLinkQuotes'&&sectionId==='admin-review')return u.perm_admin===true;
    if(moduleKey==='navLinkCollections'&&sectionId==='imports')return u.perm_admin===true;
    if(moduleKey==='navLinkFleet'){
      const admin=u.perm_admin===true;
      if(sectionId==='inspectPane')return admin||u.perm_vehicle_submit===true;
      if(sectionId==='historyPane'||sectionId==='garagePane')return admin||u.perm_vehicle_view===true;
      if(sectionId==='safetyPane')return admin||u.perm_safety===true;
    }
    return !source||!source.classList.contains('hidden');
  }
  function setModuleExpanded(moduleKey,open,persist=true){
    const menu=moduleMenus.get(moduleKey);if(!menu)return;
    menu.submenu.hidden=!open;
    menu.toggle.setAttribute('aria-expanded',String(open));
    menu.toggle.querySelector('.gp-management-chevron')?.classList.toggle('is-open',open);
    if(persist)storage.write(`gp_nav_mod_${activeUserId}_${moduleKey}`,open);
  }
  function setModuleSection(moduleKey,sectionId){
    const menu=moduleMenus.get(moduleKey);if(!menu)return;
    for(const [id,anchor] of menu.children){
      const active=id===sectionId;
      anchor.classList.toggle('active',active);
      if(active)anchor.setAttribute('aria-current','page');else anchor.removeAttribute('aria-current');
    }
    if(currentModule()===moduleKey){
      if(personal.showSections)setModuleExpanded(moduleKey,true,false);
      const group=menu.toggle.closest('.gp-side-group');
      if(group){group.classList.remove('is-closed');group.querySelector('.gp-side-group-toggle')?.setAttribute('aria-expanded','true');}
    }
  }
  function applyModuleHash(){
    const moduleKey=currentModule();if(!moduleKey)return;
    const id=decodeURIComponent((location.hash||'').slice(1));
    const menu=moduleMenus.get(moduleKey);if(!menu||!menu.children.has(id))return;
    const marker=MODULE_SECTIONS[moduleKey].views.find(v=>v[0]===id)?.[2];
    const source=sourceButton(marker||'');
    if(source&&!source.classList.contains('hidden')&&sectionAllowed(moduleKey,id,source)){
      source.click();setModuleSection(moduleKey,id);
    }
  }
  function buildModuleSections(moduleKey,content,row){
    const definition=MODULE_SECTIONS[moduleKey];if(!definition||definition.views.length<2)return;
    const expander=document.createElement('button');expander.type='button';expander.className='gp-management-toggle gp-module-toggle';
    expander.innerHTML='<span class="gp-management-chevron" aria-hidden="true">⌄</span>';
    expander.setAttribute('aria-label',`Expand ${moduleLinks.get(moduleKey)?.textContent||'module'} sections`);
    const submenu=document.createElement('div');submenu.className='gp-management-submenu gp-module-submenu';submenu.id=`gp-submenu-${moduleKey}`;
    expander.setAttribute('aria-controls',submenu.id);
    const children=new Map();
    for(const [id,label,marker] of definition.views){
      const a=document.createElement('a');a.className='gp-management-sub-link';a.href=`${definition.path}#${id}`;
      a.dataset.moduleSection=id;
      const icon=document.createElement('span');icon.className='gp-management-sub-icon';icon.textContent='›';icon.setAttribute('aria-hidden','true');
      const name=document.createElement('span');name.className='gp-management-sub-title';name.textContent=label;
      a.append(icon,name);a.title=`${moduleLinks.get(moduleKey)?.textContent||'Module'} → ${label}`;
      a.addEventListener('click',event=>{
        if(currentModule()!==moduleKey)return;
        const source=sourceButton(marker);
        if(!source||source.classList.contains('hidden')||!sectionAllowed(moduleKey,id,source)){
          event.preventDefault();return;
        }
        event.preventDefault();source.click();
        if(location.hash!==`#${id}`)history.pushState(null,'',`#${id}`);
        setModuleSection(moduleKey,id);closeMobile();
      });
      submenu.append(a);children.set(id,a);
    }
    row.append(expander);content.append(submenu);
    moduleMenus.set(moduleKey,{submenu,toggle:expander,children});
    expander.addEventListener('click',()=>setModuleExpanded(moduleKey,submenu.hidden));
    const expanded=storage.read(`gp_nav_mod_${activeUserId}_${moduleKey}`,currentModule()===moduleKey)!==false;
    setModuleExpanded(moduleKey,expanded,false);
  }
  function setManagementExpanded(expanded,persist=true){
    if(!adminSubmenu||!adminExpander)return;
    adminSubmenu.hidden=!expanded;
    adminExpander.setAttribute('aria-expanded',String(expanded));
    adminExpander.querySelector('.gp-management-chevron')?.classList.toggle('is-open',expanded);
    if(persist)storage.write('gp_nav_management_open',expanded);
  }
  function openAdminPane(id){
    if(!isAdminPage())return;
    window.showAdminSubTab?.(id,document.getElementById(buttonIds[id]));
    if(location.hash!==`#${id}`)history.pushState(null,'',`#${id}`);
    setAdminPane(id);closeMobile();
  }
  function teamTarget(){
    const query=String(searchInput?.value||'').trim().toLowerCase(),keywords={adminUsersPane:'people access employees users roles accounts',adminCommissionsPane:'work orders commissions jobs',adminTimePane:'time attendance clock punches payroll hours lunch review approvals',adminFleetPane:'activity history audit trail'};
    const match=query&&TEAM_IDS.find(id=>(ADMIN_LABELS[id]+' '+keywords[id]+' '+(prefs?.tabNames[id]||'')).toLowerCase().includes(query));if(match)return match;
    const saved=storage.read(`gp_nav_team_last_${activeUserId}`,'adminTimePane');
    return [saved,...(prefs?.tabOrder||TEAM_IDS),...TEAM_IDS].find(id=>TEAM_IDS.includes(id)&&!prefs?.hiddenTabs.has(id)&&!personal.hiddenSections.includes('admin:'+id))||'adminTimePane';
  }
  function buildAdministration(){
    adminLink=moduleLinks.get('navLinkAdmin');if(!adminLink)return;
    const {section,content}=createDisclosure('administration','MANAGEMENT');adminGroup=section;
    adminSubmenu=content;
    for(const [id,label,glyph] of ADMIN_VIEWS.filter(v=>!TEAM_IDS.includes(v[0]))){
      const a=document.createElement('a');a.id='gpNav-'+id;a.href=`admin.html#${id}`;
      moduleLinks.set(id,a);const row=makeModuleRow(id,label,glyph);content.append(row);adminSubLinks.set(id,a);
      a.addEventListener('click',e=>{if(isAdminPage()){e.preventDefault();openAdminPane(id);}});
    }
    const parent=makeModuleRow('navLinkAdmin','Team Management','⚙');
    content.append(parent);
    adminLink.addEventListener('click',e=>{if(isAdminPage()){e.preventDefault();openAdminPane(teamTarget());}});
    if(isAdminPage()){
      teamPanel=document.createElement('section');teamPanel.id='gpTeamManagement';teamPanel.className='gp-team-management card';
      const heading=document.createElement('h3');heading.textContent='Team Management';
      const hint=document.createElement('p');hint.textContent='People, attendance, work orders and activity in one place.';
      const tabs=document.createElement('nav');tabs.id='gpTeamTabs';tabs.setAttribute('aria-label','Team Management sections');
      teamPanel.append(heading,hint,tabs);document.querySelector('.dashboard-pref-bar')?.after(teamPanel);
    }
  }
  function renderTeamControls(){
    if(!teamPanel)return;
    const active=TEAM_IDS.includes(currentPane);teamPanel.hidden=!active;
    const tabs=document.getElementById('gpTeamTabs');
    const views=(prefs?.tabOrder||TEAM_IDS).filter(id=>TEAM_IDS.includes(id)&&(id===currentPane||(!prefs?.hiddenTabs.has(id)&&!personal.hiddenSections.includes('admin:'+id))));
    const signature=JSON.stringify([views,prefs?.tabNames,currentPane]);if(tabs._gpSignature===signature)return;tabs._gpSignature=signature;
    tabs.replaceChildren();
    for(const id of views){const b=document.createElement('button');b.type='button';b.textContent=prefs?.tabNames[id]||ADMIN_LABELS[id];b.setAttribute('aria-pressed',String(currentPane===id));b.dataset.teamPane=id;b.addEventListener('click',()=>openAdminPane(id));tabs.append(b);}
  }
  const buttonIds={adminOverviewPane:'adminSubBtnOverview',adminMOSPane:'adminSubBtnMOS',adminUsersPane:'adminSubBtnUsers',adminCommissionsPane:'adminSubBtnComm',adminTimePane:'adminSubBtnTime',adminFleetPane:'adminSubBtnAudits'};
  function makeBreadcrumb(){
    if(!isAdminPage())return;
    const intro=document.querySelector('.gp-page-intro');if(!intro)return;
    breadcrumb=document.createElement('div');breadcrumb.className='gp-management-breadcrumb';breadcrumb.setAttribute('aria-label','Current Management section');
    intro.prepend(breadcrumb);
    document.body.classList.add('gp-hierarchical-nav');
  }
  function setAdminPane(id){
    if(!ADMIN_IDS.has(id))return;
    currentPane=id;
    for(const [key,link] of [...adminSubLinks,['navLinkAdmin',adminLink]]){
      if(!link)continue;const active=key==='navLinkAdmin'?TEAM_IDS.includes(id):key===id;
      link.classList.toggle('active',active);
      if(active)link.setAttribute('aria-current','page');else link.removeAttribute('aria-current');
    }
    if(TEAM_IDS.includes(id)&&activeUserId)storage.write(`gp_nav_team_last_${activeUserId}`,id);
    renderTeamControls();
    if(isAdminPage()&&adminEnabled()){
      adminGroup?.classList.remove('is-closed');
      const groupToggle=adminGroup?.querySelector('.gp-side-group-toggle');groupToggle?.setAttribute('aria-expanded','true');
      setManagementExpanded(true,false);
    }
    if(breadcrumb){
      breadcrumb.replaceChildren();
      const root=document.createElement('span');root.textContent='Administration';
      const separator=document.createElement('span');separator.textContent='›';separator.setAttribute('aria-hidden','true');
      const manage=document.createElement('span');manage.textContent='Management';
      const second=document.createElement('span');second.textContent='›';second.setAttribute('aria-hidden','true');
      const leaf=document.createElement('strong');leaf.textContent=(prefs?.tabNames[id]||ADMIN_LABELS[id]||'Management');
      breadcrumb.append(root,separator,manage,second,leaf);
    }
    renderVisibility();
  }
  function setAdminPrefs(next){
    prefs=sanitizePrefs(next);
    for(const [id,a] of adminSubLinks){
      const fallback=ADMIN_LABELS[id],label=String(prefs.tabNames[id]||fallback).replace(/[<>\x00-\x1f]/g,'').trim().slice(0,35)||fallback;
      a.querySelector('.gp-side-title').textContent=label;a.title=label;
    }
    renderTeamControls();if(currentPane)setAdminPane(currentPane);else renderVisibility();
  }
  function setUser(profile){
    if(!profile?.auth_user_id)return;
    const changed=activeUserId!==String(profile.auth_user_id);
    activeUserId=String(profile.auth_user_id);
    if(changed){const saved=storage.read(personalKey(),null);personal=GP_NAV_CORE.normalize(saved?.preferences||saved);personalDirty=saved?.dirty===true;personalRevision++;navClient=null;cloudLoading=null;prefs=sanitizePrefs(null);if(customizeDialog?.open)customizeDialog.close();}
    const key=getUserPrefKey();
    if(key){const saved=storage.read(key,null);if(saved)setAdminPrefs(saved);}
    verifiedProfile=profile;
    if(changed)for(const [id] of moduleMenus)setModuleExpanded(id,storage.read(`gp_nav_mod_${activeUserId}_${id}`,currentModule()===id)===true,false);
    renderVisibility();if(customizeDialog?.open)renderMenuEditor();
    // Authentication startup is async. Resolve a hash once the source tab
    // controls have their employee permissions assigned.
    setTimeout(()=>{renderVisibility();applyModuleHash();},100);
  }
  function closeMobile(){
    const wasOpen=document.body.classList.contains('gp-nav-open');
    document.body.classList.remove('gp-nav-open');mobileTrigger?.setAttribute('aria-expanded','false');
    if(wasOpen)mobileTrigger?.focus();
  }
  function filterNavigation(){
    if(!nav)return;const query=String(searchInput?.value||'').trim().toLowerCase();
    const matches=el=>!query||String(el?.textContent||'').toLowerCase().includes(query);
    homeLink?.classList.toggle('gp-search-hidden',!matches(homeLink));
    let any=matches(homeLink);
    for(const item of GP_NAV_CORE.items){
      const link=moduleLinks.get(item.id),row=link?.closest('.gp-side-link-row');if(!row)continue;
      const menu=moduleMenus.get(item.id)?.submenu,parentMatch=matches(link)||(item.id==='navLinkAdmin'&&!!query&&teamTarget()!==undefined&&[...TEAM_IDS.map(id=>ADMIN_LABELS[id]),'people access employees users roles accounts work orders commissions jobs time attendance clock punches payroll hours lunch review approvals activity history audit trail'].some(v=>v.toLowerCase().includes(query)));
      const children=menu?[...menu.querySelectorAll('a')]:[];
      for(const child of children)child.classList.toggle('gp-search-hidden',!!query&&!parentMatch&&!matches(child));
      const childMatch=children.some(child=>!child.hidden&&matches(child));
      const match=parentMatch||childMatch;
      row.classList.toggle('gp-search-hidden',!!query&&!match);menu?.classList.toggle('gp-search-hidden',!!query&&!match);
      if(match&&shown(item.id))any=true;
    }
    for(const {section,content} of groupRecords){
      const visible=[...content.querySelectorAll('.gp-side-link-row')].some(row=>!['gp-search-hidden','gp-personal-hidden','gp-permission-hidden'].some(c=>row.classList.contains(c)));
      section.classList.toggle('hidden',!visible);section.classList.toggle('gp-search-empty',!!query&&!visible);
    }
    if(favourites)for(const a of favourites.querySelectorAll('a'))a.classList.toggle('gp-search-hidden',!matches(a));
    if(searchEmpty)searchEmpty.hidden=!query||any;
  }
  function renderVisibility(){
    if(!nav)return;
    const available=!nav.classList.contains('hidden');document.body.classList.toggle('gp-shell-active',available);
    if(!available)closeMobile();if(mobileTrigger)mobileTrigger.hidden=!available;
    document.body.classList.toggle('gp-side-collapsed',personal.collapsed);
    document.body.classList.toggle('gp-density-compact',personal.compact);
    const compact=nav.querySelector('#gpNavCompact');if(compact)compact.checked=personal.compact;
    const collapse=nav.querySelector('.gp-side-collapse');if(collapse){collapse.textContent=personal.collapsed?'›':'‹';collapse.setAttribute('aria-expanded',String(!personal.collapsed));}
    document.body.classList.toggle('gp-module-hierarchical-nav',!!currentModule()&&(personal.showSections||currentModule()==='navLinkTime'));
    const searching=!!searchInput?.value.trim();
    for(const id of personal.order){
      const item=GP_NAV_CORE.items.find(i=>i.id===id),link=moduleLinks.get(id),row=link?.closest('.gp-side-link-row');if(!row)continue;
      const allowed=permitted(id)&&!link.classList.contains('hidden');
      const dashboardHidden=['adminOverviewPane','adminMOSPane'].includes(id)&&prefs?.hiddenTabs.has(id)&&currentItem()!==id&&!searching;
      const visible=GP_NAV_CORE.visible(personal,id,currentItem(),searching)&&!dashboardHidden;
      row.classList.toggle('gp-permission-hidden',!allowed);row.classList.toggle('gp-personal-hidden',!visible);
      const parent=groupRecords.find(g=>g.key===item.group)?.content;
      if(parent)parent.append(row);
      const menu=moduleMenus.get(id);
      if(menu){
        if(parent)parent.append(menu.submenu);
        menu.toggle.hidden=!personal.showSections||!allowed;
        menu.submenu.classList.toggle('gp-personal-hidden',!allowed||!visible||(!personal.showSections&&!searching));
        for(const [sectionId,child] of menu.children){
          const marker=MODULE_SECTIONS[id].views.find(v=>v[0]===sectionId)?.[2]||'',source=currentModule()===id?sourceButton(marker):null;
          const current=currentModule()===id&&child.getAttribute('aria-current')==='page';
          child.hidden=!allowed||!sectionAllowed(id,sectionId,source)||(!current&&!searching&&personal.hiddenSections.includes(id+':'+sectionId));
        }
      }
    }
    if(adminLink)adminLink.href='admin.html#'+teamTarget();
    for(const {section,key} of groupRecords){const closed=personal.closedGroups.includes(key);section.classList.toggle('is-closed',closed);section.querySelector('.gp-side-group-toggle')?.setAttribute('aria-expanded',String(!closed));}
    pins=new Set(personal.favorites);
    if(favourites){
      const entries=personal.order.filter(id=>pins.has(id)&&permitted(id)&&!personal.hidden.includes(id));
      const signature=JSON.stringify([entries,currentItem(),adminLink?.href]);
      if(favourites._gpSignature!==signature){favourites._gpSignature=signature;favourites.replaceChildren();
        for(const id of entries){const item=GP_NAV_CORE.items.find(i=>i.id===id),link=moduleLinks.get(id);if(!link||link.classList.contains('hidden'))continue;
          const fav=document.createElement('a');fav.className='gp-side-link';fav.href=link.href;fav.title=item.label;
          const icon=document.createElement('span');icon.className='gp-side-icon';icon.textContent=item.icon;icon.setAttribute('aria-hidden','true');
          const title=document.createElement('span');title.className='gp-side-title';title.textContent=item.label;fav.append(icon,title);
          if(currentItem()===id){fav.classList.add('active');fav.setAttribute('aria-current','page');}
          if(item.group==='administration')fav.addEventListener('click',e=>{if(isAdminPage()){e.preventDefault();openAdminPane(id==='navLinkAdmin'?teamTarget():id);}});
          favourites.append(fav);
        }
      }
      favouriteGroup?.classList.toggle('hidden',favourites.children.length===0);
    }
    renderTeamControls();filterNavigation();
  }
  function localSave(){if(personalKey())storage.write(personalKey(),{preferences:personal,dirty:personalDirty});}
  function syncMessage(text){if(customizeStatus)customizeStatus.textContent=text;const status=document.getElementById('gpNavSaveStatus');if(status){status.textContent=text;status.title=text;}}
  function persistPersonal(){
    if(!activeUserId)return;
    personal=GP_NAV_CORE.normalize(personal);personalRevision++;personalDirty=true;localSave();renderVisibility();
    syncMessage(navClient?'Saved here · syncing…':'Saved on this browser.');
    clearTimeout(saveTimer);saveTimer=setTimeout(flushPersonal,400);
  }
  async function flushPersonal(){
    if(!navClient||!personalDirty||savePromise)return;
    const uid=activeUserId,revision=personalRevision,client=navClient,value=GP_NAV_CORE.normalize(personal);
    savePromise=(async()=>{
      try{const r=await client.rpc('gp_save_navigation_preferences',{p_preferences:value,p_expected_user:uid});if(r.error)throw r.error;if(!r.data||typeof r.data!=='object')throw Error('Account save was not confirmed.');
        if(uid===activeUserId&&revision===personalRevision){personalDirty=false;localSave();syncMessage('Menu saved to your account.');}
      }catch(error){if(uid===activeUserId)syncMessage('Saved here · account sync unavailable.');}
      finally{savePromise=null;if(personalDirty&&(uid!==activeUserId||revision!==personalRevision)){clearTimeout(saveTimer);saveTimer=setTimeout(flushPersonal,100);}}
    })();return savePromise;
  }
  async function onSignedIn(profile,client){
    setUser(profile);if(!activeUserId||!client)return;
    navClient=client;if(cloudLoading)return cloudLoading;
    const uid=activeUserId,revision=personalRevision;
    cloudLoading=(async()=>{try{
      const r=await client.from('gp_navigation_preferences').select('preferences').eq('auth_user_id',uid).maybeSingle();if(r.error)throw r.error;
      if(uid!==activeUserId||revision!==personalRevision)return;
      if(personalDirty){await flushPersonal();return;}
      if(r.data?.preferences){personal=GP_NAV_CORE.normalize(r.data.preferences);localSave();renderVisibility();syncMessage('Menu synced with your account.');}
    }catch(error){if(uid===activeUserId)syncMessage('Saved here · account sync unavailable.');}})();return cloudLoading;
  }
  function checkbox(parent,label,checked,handler,key){
    const wrap=document.createElement('label');wrap.className='gp-menu-check';const input=document.createElement('input');input.type='checkbox';input.checked=checked;if(key)input.dataset.menuControl=key;
    input.addEventListener('change',()=>handler(input.checked));wrap.append(input,document.createTextNode(label));parent.append(wrap);return input;
  }
  function renderMenuEditor(focusKey){
    const list=document.getElementById('gpMenuItems');if(!list||!editDraft)return;list.replaceChildren();
    const allowed=GP_NAV_CORE.allowed(verifiedProfile),allowedIds=allowed.map(i=>i.id);
    for(const group of ['workspace','administration']){
      const items=editDraft.order.filter(id=>allowedIds.includes(id)&&allowed.find(i=>i.id===id).group===group);if(!items.length)continue;
      const heading=document.createElement('h4');heading.textContent=group==='workspace'?'My tools':'Management';list.append(heading);
      items.forEach((id,position)=>{
        const item=allowed.find(i=>i.id===id),row=document.createElement('article');row.className='gp-menu-item';row.dataset.menuItem=id;
        const title=document.createElement('a');title.href=id==='navLinkAdmin'?'admin.html#'+teamTarget():item.path;title.textContent=item.label+' ↗';title.className='gp-menu-open';title.title='Open '+item.label;
        const controls=document.createElement('div');controls.className='gp-menu-item-controls';
        checkbox(controls,'Show',!editDraft.hidden.includes(id),checked=>{editDraft.hidden=editDraft.hidden.filter(v=>v!==id);if(!checked)editDraft.hidden.push(id);},'show-'+id);
        checkbox(controls,'Favorite',editDraft.favorites.includes(id),checked=>{editDraft.favorites=editDraft.favorites.filter(v=>v!==id);if(checked){editDraft.favorites.push(id);editDraft.hidden=editDraft.hidden.filter(v=>v!==id);renderMenuEditor('favorite-'+id);}},'favorite-'+id);
        [-1,1].forEach(delta=>{const b=document.createElement('button');b.type='button';b.textContent=delta<0?'↑':'↓';b.setAttribute('aria-label',`Move ${item.label} ${delta<0?'up':'down'}`);b.dataset.menuControl=`move-${delta}-${id}`;b.disabled=delta<0?position===0:position===items.length-1;b.onclick=()=>{editDraft=GP_NAV_CORE.move(editDraft,id,delta,allowedIds);renderMenuEditor(b.dataset.menuControl);};controls.append(b);});
        row.append(title,controls);
        const sectionViews=id==='navLinkAdmin'?TEAM_IDS.map(v=>[v,ADMIN_LABELS[v],null]):MODULE_SECTIONS[id]?.views;
        if(sectionViews?.length>1){
          const details=document.createElement('details');details.className='gp-menu-sections';const summary=document.createElement('summary');summary.textContent=id==='navLinkAdmin'?'Team tabs':'Section shortcuts';details.append(summary);
          for(const [sectionId,label,marker] of sectionViews){
            if(id!=='navLinkAdmin'&&!sectionAllowed(id,sectionId,currentModule()===id?sourceButton(marker):null))continue;
            const key=(id==='navLinkAdmin'?'admin':id)+':'+sectionId;
            checkbox(details,label,!editDraft.hiddenSections.includes(key),checked=>{editDraft.hiddenSections=editDraft.hiddenSections.filter(v=>v!==key);if(!checked)editDraft.hiddenSections.push(key);});
          }
          row.append(details);
        }
        list.append(row);
      });
    }
    for(const field of ['favoritesOnly','showSections','compact'])document.querySelector(`[data-menu-setting="${field}"]`).checked=editDraft[field];
    if(focusKey){const control=[...list.querySelectorAll('[data-menu-control]')].find(e=>e.dataset.menuControl===focusKey);if(control&&!control.disabled)control.focus();}
  }
  function openMenuEditor(){
    if(!verifiedProfile)return;customizeReturn=document.activeElement;closeMobile();editDraft=GP_NAV_CORE.normalize(personal);renderMenuEditor();customizeDialog.showModal();customizeDialog.querySelector('.gp-menu-editor-body').scrollTop=0;
  }
  function mountMenuEditor(){
    customizeDialog=document.createElement('dialog');customizeDialog.id='gpMenuEditor';customizeDialog.className='gp-menu-editor';customizeDialog.setAttribute('aria-labelledby','gpMenuEditorTitle');
    customizeDialog.innerHTML='<form method="dialog" class="gp-menu-editor-shell"><div class="gp-menu-editor-head"><div><h2 id="gpMenuEditorTitle">Make this menu yours</h2><p>Choose the tools you need. My Home and Customize menu always stay available.</p></div><button type="submit" value="cancel" aria-label="Close menu customization">×</button></div><div class="gp-menu-editor-body"><div id="gpMenuSettings" class="gp-menu-settings"></div><div id="gpMenuItems"></div><p class="gp-menu-editor-hint">Only your permitted tools appear here. A hidden tool remains available through search or its Open link. The current page stays visible while you are using it. Team tab choices also apply inside Team Management.</p><p id="gpMenuSyncStatus" role="status"></p></div><div class="gp-menu-editor-actions"><button type="button" id="gpMenuReset">Restore defaults</button><span></span><button type="submit" value="cancel">Cancel</button><button type="submit" value="save" id="gpMenuSave">Save menu</button></div></form>';
    const settings=customizeDialog.querySelector('#gpMenuSettings');
    for(const [field,label] of [['favoritesOnly','Show favorites only'],['showSections','Show section shortcuts in the sidebar'],['compact','Use compact cards and tables']]){
      const input=checkbox(settings,label,false,checked=>editDraft[field]=checked);input.dataset.menuSetting=field;
    }
    customizeDialog.querySelector('#gpMenuReset').onclick=()=>{editDraft=GP_NAV_CORE.normalize();renderMenuEditor();};
    customizeDialog.querySelector('form').onsubmit=e=>{if(e.submitter?.value==='save'){personal=GP_NAV_CORE.normalize(editDraft);persistPersonal();}};
    customizeDialog.addEventListener('close',()=>{editDraft=null;if(window.innerWidth<=1000)mobileTrigger?.focus();else customizeReturn?.focus();});
    document.body.append(customizeDialog);customizeStatus=document.getElementById('gpMenuSyncStatus');
    window.addEventListener('storage',e=>{if(e.key===personalKey()){const saved=storage.read(personalKey(),null);personal=GP_NAV_CORE.normalize(saved?.preferences||saved);personalDirty=saved?.dirty===true;personalRevision++;renderVisibility();}});
  }
  function init(){
    nav=document.getElementById('mainNavBar');if(!nav||nav.dataset.gpSidebarReady)return;
    nav.dataset.gpSidebarReady='true';nav.setAttribute('aria-label','GLASSPRO modules and Management sections');
    nav.classList.add('gp-sidebar');
    if(!nav.querySelector('#navLinkCustomers')){const customerLink=document.createElement('a');customerLink.id='navLinkCustomers';customerLink.href='customers.html';customerLink.textContent='Customers';customerLink.className='gp-nav-btn';nav.append(customerLink);}
    moduleLinks=new Map([...nav.querySelectorAll('a[href][id]')].map(a=>[a.id,a]));
    nav.replaceChildren();
    const brand=document.createElement('div');brand.className='gp-side-brand';
    const logo=document.createElement('span');logo.className='gp-side-brand-logo';logo.textContent='G';logo.setAttribute('aria-hidden','true');
    const copy=document.createElement('span');copy.className='gp-side-brand-copy';copy.innerHTML='<strong>GLASSPRO</strong><span>TEAM WORKSPACE</span>';
    brand.append(logo,copy);
    const collapse=addIconButton(brand,'Collapse or expand sidebar','gp-side-collapse','‹',()=>{
      personal.collapsed=!personal.collapsed;if(personal.collapsed&&searchInput){searchInput.value='';nav.classList.remove('gp-searching');}persistPersonal();
    });
    addIconButton(brand,'Close menu','gp-side-close','×',closeMobile);
    nav.append(brand);
    const heading=document.createElement('div');heading.className='gp-side-workspace';heading.textContent='Workspace';nav.append(heading);
    homeLink=document.createElement('a');homeLink.href='home.html';homeLink.className='gp-side-link';homeLink.innerHTML='<span class="gp-side-icon" aria-hidden="true">⌂</span><span class="gp-side-title">My Home</span>';nav.append(homeLink);
    if(/(^|\/)home\.html$/i.test(location.pathname)){homeLink.classList.add('active');homeLink.setAttribute('aria-current','page');}
    const searchBox=document.createElement('label');searchBox.className='gp-side-search';
    const searchIcon=document.createElement('span');searchIcon.textContent='⌕';searchIcon.setAttribute('aria-hidden','true');
    searchInput=document.createElement('input');searchInput.type='search';searchInput.placeholder='Find a workspace…';searchInput.setAttribute('aria-label','Find a workspace or Management section');
    searchBox.append(searchIcon,searchInput);nav.append(searchBox);
    searchInput.addEventListener('input',()=>{nav.classList.toggle('gp-searching',!!searchInput.value.trim());renderVisibility();});
    searchEmpty=document.createElement('p');searchEmpty.className='gp-search-no-results';searchEmpty.hidden=true;searchEmpty.setAttribute('role','status');searchEmpty.textContent='No matching tools. Try another name.';nav.append(searchEmpty);
    pins=new Set(personal.favorites);
    favouriteGroup=document.createElement('section');favouriteGroup.className='gp-side-group hidden';
    const favHeading=document.createElement('div');favHeading.className='gp-side-group-toggle';favHeading.textContent='FAVORITES';
    favourites=document.createElement('div');favourites.className='gp-side-favorites';favouriteGroup.append(favHeading,favourites);nav.append(favouriteGroup);
    for(const group of MODULE_GROUPS){
      const section=createDisclosure(group.key,group.label);
      group.links.forEach(([id,label,glyph])=>{
        const row=makeModuleRow(id,label,glyph);if(!row)return;
        section.content.append(row);
        buildModuleSections(id,section.content,row);
      });
    }
    buildAdministration();
    const footer=document.createElement('div');footer.className='gp-side-foot';
    const customize=document.createElement('button');customize.type='button';customize.className='gp-side-settings-button gp-customize-menu';customize.setAttribute('aria-label','Customize menu');customize.title='Customize menu';customize.innerHTML='<span aria-hidden="true">☷</span><span class="gp-side-foot-label">Customize menu</span>';customize.onclick=openMenuEditor;footer.append(customize);
    const settings=document.createElement('button');settings.type='button';settings.className='gp-side-settings-button';settings.innerHTML='<span aria-hidden="true">☷</span><span class="gp-side-foot-label">Display preferences</span>';
    settings.setAttribute('aria-expanded','false');
    settings.setAttribute('aria-label','Display preferences');settings.title='Display preferences';
    const options=document.createElement('div');options.className='gp-side-options';
    window.GP_UX?.mountThemeControl?.(options);
    const compact=document.createElement('label');compact.className='gp-side-settings-row';
    const check=document.createElement('input');check.type='checkbox';check.id='gpNavCompact';check.checked=personal.compact;
    compact.append(check,document.createTextNode('Compact cards and tables'));options.append(compact);
    check.addEventListener('change',()=>{personal.compact=check.checked;persistPersonal();});
    const hint=document.createElement('small');hint.textContent='Use Customize menu to choose your tools, favorites and shortcuts. Theme controls stay here in Display preferences.';options.append(hint);
    settings.addEventListener('click',()=>{if(document.body.classList.contains('gp-side-collapsed'))nav.querySelector('.gp-side-collapse')?.click();const expanded=options.classList.toggle('is-open');settings.setAttribute('aria-expanded',String(expanded));});
    const status=document.createElement('small');status.id='gpNavSaveStatus';status.className='gp-nav-save-status';status.setAttribute('role','status');footer.append(settings,options,status);nav.append(footer);mountMenuEditor();
    const scrim=document.createElement('div');scrim.className='gp-nav-scrim';scrim.addEventListener('click',closeMobile);document.body.append(scrim);
    mobileTrigger=document.createElement('button');mobileTrigger.type='button';mobileTrigger.className='gp-mobile-nav-trigger';mobileTrigger.innerHTML='<span aria-hidden="true">☰</span> Menu';
    mobileTrigger.setAttribute('aria-label','Open GLASSPRO navigation');mobileTrigger.setAttribute('aria-expanded','false');mobileTrigger.setAttribute('aria-controls','mainNavBar');
    const header=document.querySelector('header');header?.prepend(mobileTrigger);
    mobileTrigger.addEventListener('click',()=>{
      const open=document.body.classList.toggle('gp-nav-open');mobileTrigger.setAttribute('aria-expanded',String(open));
      if(open)(nav.querySelector('.gp-side-close')||nav.querySelector('a'))?.focus();
    });
document.addEventListener('keydown',e=>{
      if(!document.body.classList.contains('gp-nav-open'))return;
      if(e.key==='Escape'){e.preventDefault();closeMobile();return;}
      if(e.key==='Tab'){
        const items=[...nav.querySelectorAll('a[href],button,input')].filter(el=>!el.disabled&&el.getClientRects().length>0);
        const first=items[0],last=items[items.length-1];
        if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}
        else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}
      }
    });
    window.addEventListener('resize',()=>{if(window.innerWidth>1000)closeMobile();});
    const savedCollapsed=personal.collapsed;
    document.body.classList.toggle('gp-side-collapsed',savedCollapsed);collapse.textContent=savedCollapsed?'›':'‹';collapse.setAttribute('aria-expanded',String(!savedCollapsed));
    document.body.classList.toggle('gp-density-compact',check.checked);
    makeBreadcrumb();
    if(currentModule()&&moduleMenus.has(currentModule())){
      document.body.classList.add('gp-module-hierarchical-nav');
      const marker=MODULE_SECTIONS[currentModule()].views[0]?.[0];
      if(marker)setModuleSection(currentModule(),marker);
    }
    window.addEventListener('hashchange',applyModuleHash);
    const sourceControls=MODULE_SECTIONS[currentModule()]?.views.map(([, ,mark])=>sourceButton(mark)).filter(Boolean)||[];
    if(sourceControls.length){
      const sourcesObserver=new MutationObserver(()=>renderVisibility());
      for(const source of sourceControls){
        sourcesObserver.observe(source,{attributes:true,attributeFilter:['class','hidden']});
        const item=MODULE_SECTIONS[currentModule()].views.find(v=>sourceButton(v[2])===source);
        source.addEventListener('click',()=>{if(item)setModuleSection(currentModule(),item[0]);});
      }
    }
    const hash=decodeURIComponent((location.hash||'').slice(1));
    if(isAdminPage())setAdminPane(ADMIN_IDS.has(hash)?hash:'adminOverviewPane');
    const current=storage.read('gp_session_user',null);
    if(current?.auth_user_id)setUser(current);
    const observer=new MutationObserver(records=>{
      if(records.some(r=>r.target===nav || moduleLinks.has(r.target.id)))renderVisibility();
    });
    observer.observe(nav,{attributes:true,subtree:true,attributeFilter:['class']});
    renderVisibility();
  }
  window.GP_SIDEBAR={setAdminPane,setAdminPrefs,setModuleSection,setUser,onSignedIn,openCustomizer:openMenuEditor,refresh:renderVisibility};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})();

