/* GLASSPRO hierarchical sidebar v2026.11.13.2.
 * Navigation visibility is a UX hint. Supabase Auth/RLS and page guards retain
 * responsibility for authorization. No browser-stored preference grants access.
 */
(() => {
  'use strict';
  const MODULE_GROUPS = [
    {key:'daily', label:'DAILY WORK', links:[['navLinkTime','Time Clock','◷'],['navLinkComm','Commission & WOs','▤']]},
    {key:'customer', label:'CUSTOMER OPERATIONS', links:[['navLinkQuotes','Quote Call-Backs','◉'],['navLinkCollections','Collections','▥']]},
    {key:'field', label:'FIELD OPERATIONS', links:[['navLinkFleet','Vehicle Check & Safety','◇']]}
  ];
  // Interior pages stay in their existing modules; the sidebar activates their
  // original (permission-checked) tab controls instead of duplicating workflows.
  const MODULE_SECTIONS = {
    navLinkTime:{path:'index.html',views:[
      ['timeLivePane','Live Punch Clock','timeSubBtnLive'],
      ['timeManualPane','Manual Shift Entry','timeSubBtnManual']]},
    navLinkQuotes:{path:'quotes.html',views:[
      ['board','Active Call-Back Board','tab-btn-board'],
      ['admin-review','Admin Review & Alerts','tab-btn-admin-review'],
      ['competitors','Competitor Manager','tab-btn-competitors']]},
    navLinkCollections:{path:'collections.html',views:[
      ['queue','Collection Queue','col-tab:queue'],
      ['reconcile','Source Reconciliation','col-tab:reconcile'],
      ['closeout','End-of-Day Closeout','col-tab:closeout'],
      ['imports','Import Center','col-tab:imports']]},
    navLinkFleet:{path:'fleet.html',views:[
      ['inspectPane','Vehicle Check','subBtnInspect'],
      ['historyPane','Inspection History','subBtnHistory'],
      ['safetyPane','Safety & SOPs','subBtnSafety'],
      ['garagePane','Fleet Garage','subBtnGarage']]}
  };
  const ADMIN_VIEWS = [
    ['adminOverviewPane','Command Center','◫'],
    ['adminMOSPane','MultiplyOS Hub','▦'],
    ['adminUsersPane','Users & Roles','♙'],
    ['adminCommissionsPane','Commissions & WOs','▤'],
    ['adminTimePane','Time & Geotags','◷'],
    ['adminFleetPane','Audit Trail','≡']
  ];
  const ADMIN_IDS=new Set(ADMIN_VIEWS.map(v=>v[0]));
  const ADMIN_LABELS=Object.fromEntries(ADMIN_VIEWS.map(v=>[v[0],v[1]]));
  const storage={
    read(k, fallback){try{const raw=localStorage.getItem(k);return raw===null?fallback:JSON.parse(raw);}catch{return fallback;}},
    write(k,value){try{localStorage.setItem(k,JSON.stringify(value));}catch{}}
  };
  let nav=null, adminLink=null, adminGroup=null, adminExpander=null, adminSubmenu=null;
  let mobileTrigger=null, breadcrumb=null, currentPane=null, activeUserId=null;
  let prefs=null, moduleLinks=new Map(), adminSubLinks=new Map(), groupRecords=[];
  const moduleMenus=new Map();let verifiedProfile=null;
  let pins=new Set(), favourites=null, favouriteGroup=null;
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
    const row=document.createElement('div');row.className='gp-side-link-row';
    const pin=document.createElement('button');pin.type='button';pin.className='gp-side-pin';pin.title=`Add ${label} to favorites`;
    pin.addEventListener('click',()=>{
      if(pins.has(id))pins.delete(id);else pins.add(id);
      storage.write('gp_nav_pins',[...pins]);renderVisibility();
    });
    row.append(anchor,pin);row.gpPin=pin;
    return row;
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
    const savedClosed=storage.read(`gp_nav_grp_${key}`,false);
    const closed=savedClosed===true && !(isAdminPage()&&key==='administration');
    section.classList.toggle('is-closed',closed);toggle.setAttribute('aria-expanded',String(!closed));
    toggle.addEventListener('click',()=>{
      const closedNow=section.classList.toggle('is-closed');toggle.setAttribute('aria-expanded',String(!closedNow));storage.write(`gp_nav_grp_${key}`,closedNow);
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
    if(persist)storage.write(`gp_nav_mod_${moduleKey}`,open);
  }
  function setModuleSection(moduleKey,sectionId){
    const menu=moduleMenus.get(moduleKey);if(!menu)return;
    for(const [id,anchor] of menu.children){
      const active=id===sectionId;
      anchor.classList.toggle('active',active);
      if(active)anchor.setAttribute('aria-current','page');else anchor.removeAttribute('aria-current');
    }
    if(currentModule()===moduleKey){
      setModuleExpanded(moduleKey,true,false);
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
    const definition=MODULE_SECTIONS[moduleKey];if(!definition)return;
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
    const expanded=storage.read(`gp_nav_mod_${moduleKey}`,currentModule()===moduleKey)!==false;
    setModuleExpanded(moduleKey,expanded,false);
  }
  function setManagementExpanded(expanded,persist=true){
    if(!adminSubmenu||!adminExpander)return;
    adminSubmenu.hidden=!expanded;
    adminExpander.setAttribute('aria-expanded',String(expanded));
    adminExpander.querySelector('.gp-management-chevron')?.classList.toggle('is-open',expanded);
    if(persist)storage.write('gp_nav_management_open',expanded);
  }
  function buildAdministration(){
    adminLink=moduleLinks.get('navLinkAdmin');if(!adminLink)return;
    const {section,content}=createDisclosure('administration','ADMINISTRATION');adminGroup=section;
    const parent=document.createElement('div');parent.className='gp-management-row';
    const management=makeLink('navLinkAdmin','Management','⚙');
    management.title='Management — open your saved default workspace';
    parent.append(management);
    adminExpander=document.createElement('button');adminExpander.type='button';adminExpander.className='gp-management-toggle';
    adminExpander.innerHTML='<span class="gp-management-chevron" aria-hidden="true">⌄</span>';
    adminExpander.setAttribute('aria-label','Expand Management sections');adminExpander.title='Expand Management sections';
    adminSubmenu=document.createElement('div');adminSubmenu.id='gp-management-submenu';adminSubmenu.className='gp-management-submenu';
    adminExpander.setAttribute('aria-controls',adminSubmenu.id);
    adminExpander.addEventListener('click',()=>setManagementExpanded(adminSubmenu.hidden));parent.append(adminExpander);
    for(const [id,label,glyph] of ADMIN_VIEWS){
      const a=document.createElement('a');a.className='gp-management-sub-link';a.href=`admin.html#${id}`;a.dataset.pane=id;a.title=`Management → ${label}`;
      const symbol=document.createElement('span');symbol.className='gp-management-sub-icon';symbol.textContent=glyph;symbol.setAttribute('aria-hidden','true');
      const text=document.createElement('span');text.className='gp-management-sub-title';text.textContent=label;
      a.append(symbol,text);adminSubmenu.append(a);adminSubLinks.set(id,a);
      a.addEventListener('click',event=>{
        if(!isAdminPage())return;
        event.preventDefault();
        // A click on the currently selected hash still opens the pane; no hashchange needed.
        if(typeof window.showAdminSubTab==='function')window.showAdminSubTab(id,document.getElementById(buttonIds[id]));
        if(location.hash!==`#${id}`)history.pushState(null,'',`#${id}`);
        setAdminPane(id);closeMobile();
      });
    }
    content.append(parent,adminSubmenu);
    const defaultExpanded=storage.read('gp_nav_management_open',true)!==false || isAdminPage();
    setManagementExpanded(defaultExpanded,false);
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
    for(const [key,link] of adminSubLinks){
      const active=key===id;
      link.classList.toggle('active',active);
      if(active)link.setAttribute('aria-current','page');else link.removeAttribute('aria-current');
    }
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
  }
  function setAdminPrefs(next){
    prefs=sanitizePrefs(next);
    if(!adminSubmenu)return;
    for(const pane of prefs.tabOrder){
      const a=adminSubLinks.get(pane);if(!a)continue;
      const fallback=ADMIN_LABELS[pane];
      const label=String(prefs.tabNames[pane]||fallback).replace(/[<>\x00-\x1f]/g,'').trim().slice(0,35)||fallback;
      a.querySelector('.gp-management-sub-title').textContent=label;
      a.title=`Management → ${label}`;
      a.hidden=prefs.hiddenTabs.has(pane);
      adminSubmenu.append(a);
    }
    if(currentPane)setAdminPane(currentPane);
    renderVisibility();
  }
  function setUser(profile){
    if(!profile?.auth_user_id)return;
    activeUserId=String(profile.auth_user_id);
    const key=getUserPrefKey();
    if(key){const saved=storage.read(key,null);if(saved)setAdminPrefs(saved);}
    verifiedProfile=profile;
    renderVisibility();
    // Authentication startup is async. Resolve a hash once the source tab
    // controls have their employee permissions assigned.
    setTimeout(()=>{renderVisibility();applyModuleHash();},100);
  }
  function closeMobile(){document.body.classList.remove('gp-nav-open');mobileTrigger?.setAttribute('aria-expanded','false');}
  function renderVisibility(){
    if(!nav)return;
    const available=!nav.classList.contains('hidden');
    document.body.classList.toggle('gp-shell-active',available);
    if(!available)closeMobile();
    if(mobileTrigger)mobileTrigger.hidden=!available;
    for(const {section,content,key} of groupRecords){
      const visible=key==='administration'?adminEnabled():[...content.querySelectorAll('a.gp-side-link')].some(a=>!a.classList.contains('hidden'));
      section.classList.toggle('hidden',!visible);
    }
    // The enclosing group is permission-gated. Do not mutate the nested open
    // state here: a profile refresh must not permanently close the submenu.
    for(const [moduleKey,menu] of moduleMenus){
      const link=moduleLinks.get(moduleKey);
      const allowed=!!link&&!link.classList.contains('hidden');
      menu.toggle.hidden=!allowed;
      // Parent category gating already hides the whole subtree when a module
      // has not been assigned, but links are also individually suppressed.
      for(const [sectionId,child] of menu.children){
        const marker=MODULE_SECTIONS[moduleKey].views.find(v=>v[0]===sectionId)?.[2]||'';
        const source=currentModule()===moduleKey?sourceButton(marker):null;
        child.hidden=!allowed||!sectionAllowed(moduleKey,sectionId,source);
      }
    }
    if(favourites){
      favourites.replaceChildren();
      for(const group of MODULE_GROUPS){for(const [id,label,glyph] of group.links){
        const link=moduleLinks.get(id);const row=link?.closest('.gp-side-link-row');const pin=row?.gpPin;
        const starred=pins.has(id);if(pin){pin.classList.toggle('is-pinned',starred);pin.textContent=starred?'★':'☆';pin.setAttribute('aria-label',`${starred?'Unpin':'Pin'} ${label}`);}
        if(!starred||!link||link.classList.contains('hidden'))continue;
        const fav=document.createElement('a');fav.className='gp-side-link';fav.href=link.href;fav.title=label;
        const span=document.createElement('span');span.className='gp-side-icon';span.textContent=glyph;span.setAttribute('aria-hidden','true');
        const title=document.createElement('span');title.className='gp-side-title';title.textContent=label;
        fav.append(span,title);favourites.append(fav);
      }}
      if(favouriteGroup)favouriteGroup.classList.toggle('hidden',favourites.children.length===0);
    }
  }
  function init(){
    nav=document.getElementById('mainNavBar');if(!nav||nav.dataset.gpSidebarReady)return;
    nav.dataset.gpSidebarReady='true';nav.setAttribute('aria-label','GLASSPRO modules and Management sections');
    nav.classList.add('gp-sidebar');
    moduleLinks=new Map([...nav.querySelectorAll('a[href][id]')].map(a=>[a.id,a]));
    nav.replaceChildren();
    const brand=document.createElement('div');brand.className='gp-side-brand';
    const logo=document.createElement('span');logo.className='gp-side-brand-logo';logo.textContent='G';logo.setAttribute('aria-hidden','true');
    const copy=document.createElement('span');copy.className='gp-side-brand-copy';copy.innerHTML='<strong>GLASSPRO</strong><span>TEAM WORKSPACE</span>';
    brand.append(logo,copy);
    const collapse=addIconButton(brand,'Collapse or expand sidebar','gp-side-collapse','‹',()=>{
      const collapsed=document.body.classList.toggle('gp-side-collapsed');storage.write('gp_nav_collapsed',collapsed);collapse.textContent=collapsed?'›':'‹';
    });
    addIconButton(brand,'Close menu','gp-side-close','×',closeMobile);
    nav.append(brand);
    const heading=document.createElement('div');heading.className='gp-side-workspace';heading.textContent='Workspace';nav.append(heading);
    pins=new Set((Array.isArray(storage.read('gp_nav_pins',[]))?storage.read('gp_nav_pins',[]):[]).filter(x=>typeof x==='string'));
    favouriteGroup=document.createElement('section');favouriteGroup.className='gp-side-group hidden';
    const favHeading=document.createElement('div');favHeading.className='gp-side-group-toggle';favHeading.textContent='★ YOUR FAVORITES';
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
    const settings=document.createElement('button');settings.type='button';settings.className='gp-side-settings-button';settings.innerHTML='<span aria-hidden="true">☷</span><span class="gp-side-foot-label">Display preferences</span>';
    settings.setAttribute('aria-expanded','false');
    const options=document.createElement('div');options.className='gp-side-options';
    const compact=document.createElement('label');compact.className='gp-side-settings-row';
    const check=document.createElement('input');check.type='checkbox';check.checked=storage.read('gp_nav_compact',false)===true;
    compact.append(check,document.createTextNode('Compact cards and tables'));options.append(compact);
    check.addEventListener('change',()=>{storage.write('gp_nav_compact',check.checked);document.body.classList.toggle('gp-density-compact',check.checked);});
    const hint=document.createElement('small');hint.textContent='Expand Administration → Management for section links. Sidebar changes are visual only; access still follows employee roles.';options.append(hint);
    settings.addEventListener('click',()=>{const expanded=options.classList.toggle('is-open');settings.setAttribute('aria-expanded',String(expanded));});
    footer.append(settings,options);nav.append(footer);
    const scrim=document.createElement('div');scrim.className='gp-nav-scrim';scrim.addEventListener('click',closeMobile);document.body.append(scrim);
    mobileTrigger=document.createElement('button');mobileTrigger.type='button';mobileTrigger.className='gp-mobile-nav-trigger';mobileTrigger.innerHTML='<span aria-hidden="true">☰</span> Menu';
    mobileTrigger.setAttribute('aria-label','Open GLASSPRO navigation');mobileTrigger.setAttribute('aria-expanded','false');
    const header=document.querySelector('header');header?.prepend(mobileTrigger);
    mobileTrigger.addEventListener('click',()=>{const open=document.body.classList.toggle('gp-nav-open');mobileTrigger.setAttribute('aria-expanded',String(open));});
    document.addEventListener('keydown',e=>{if(e.key==='Escape')closeMobile();});
    const savedCollapsed=storage.read('gp_nav_collapsed',false)===true;
    document.body.classList.toggle('gp-side-collapsed',savedCollapsed);collapse.textContent=savedCollapsed?'›':'‹';
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
  window.GP_SIDEBAR={setAdminPane,setAdminPrefs,setModuleSection,setUser,refresh:renderVisibility};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})();
