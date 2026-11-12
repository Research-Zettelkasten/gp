/* Shared module navigation. Module authorization remains enforced by Supabase Auth/RLS. */
(() => {
  "use strict";
  const definitions = [
    {key:"work", label:"MY WORK", links:[
      ["navLinkTime","Time Clock","◷"],["navLinkComm","Commission & WOs","▤"]]},
    {key:"customer", label:"CUSTOMER OPERATIONS", links:[
      ["navLinkQuotes","Quote Call-Backs","◉"],["navLinkCollections","Collections","▥"]]},
    {key:"field", label:"FIELD OPERATIONS", links:[
      ["navLinkFleet","Vehicle Check & Safety","◇"]]},
    {key:"manage", label:"ADMINISTRATION", links:[
      ["navLinkAdmin","Management & MOS Hub","⚙"]]}
  ];
  const storage = {
    read(k,fallback){try {const s=localStorage.getItem(k);return s===null?fallback:JSON.parse(s);}catch{return fallback;}},
    write(k,v){try{localStorage.setItem(k,JSON.stringify(v));}catch{}}
  };
  document.addEventListener("DOMContentLoaded", () => {
    const nav = document.getElementById("mainNavBar");
    if (!nav || nav.dataset.gpSidebarReady) return;
    nav.dataset.gpSidebarReady="true";
    nav.setAttribute("aria-label","GLASSPRO navigation");
    nav.classList.add("gp-sidebar");
    const existing = new Map(Array.from(nav.querySelectorAll("a[href]")).map(a=>[a.id,a]));
    nav.replaceChildren();
    const brand=document.createElement("div"); brand.className="gp-side-brand";
    brand.innerHTML='<span class="gp-side-brand-logo" aria-hidden="true">G</span><span class="gp-side-brand-copy"><strong>GLASSPRO</strong><span>TEAM WORKSPACE</span></span>';
    const collapse=document.createElement("button"); collapse.type="button";collapse.className="gp-side-collapse";collapse.title="Collapse or expand sidebar";collapse.setAttribute("aria-label","Collapse or expand sidebar");collapse.textContent="‹";
    collapse.addEventListener("click",()=>{const collapsed=document.body.classList.toggle("gp-side-collapsed");storage.write("gp_nav_collapsed",collapsed);collapse.textContent=collapsed?"›":"‹";});
    brand.append(collapse);
    const close=document.createElement("button");close.type="button";close.className="gp-side-close";close.textContent="×";close.setAttribute("aria-label","Close navigation");close.addEventListener("click",()=>document.body.classList.remove("gp-nav-open"));brand.append(close);
    nav.append(brand);
    const heading=document.createElement("div");heading.className="gp-side-workspace";heading.textContent="Workspace";nav.append(heading);
    const groups=[];
    const linkMeta=new Map();
    const pins=new Set(storage.read("gp_nav_pins",[]));
    const favorites=document.createElement("div");favorites.className="gp-side-favorites";
    const favGroup=document.createElement("div");favGroup.className="gp-side-group hidden";
    const favLabel=document.createElement("div");favLabel.className="gp-side-group-toggle";favLabel.textContent="★ YOUR FAVORITES";
    favGroup.append(favLabel,favorites); nav.append(favGroup);
    for (const group of definitions) {
      const outer=document.createElement("section");outer.className="gp-side-group";outer.dataset.group=group.key;
      const toggle=document.createElement("button"); toggle.type="button";toggle.className="gp-side-group-toggle";toggle.innerHTML=`<span>${group.label}</span><span class="gp-side-chevron" aria-hidden="true">⌄</span>`;
      toggle.setAttribute("aria-expanded","true");
      const contents=document.createElement("div");contents.className="gp-side-group-links";
      group.links.forEach(([id,label,glyph])=>{
        const link=existing.get(id);
        if (!link) return;
        const wasActive=link.classList.contains("active") || link.getAttribute("aria-current")==="page";
        link.classList.remove("nav-btn","gp-nav-btn");link.classList.add("gp-side-link");
        link.textContent="";
        const ico=document.createElement("span");ico.className="gp-side-icon";ico.textContent=glyph;ico.setAttribute("aria-hidden","true");
        const txt=document.createElement("span");txt.className="gp-side-title";txt.textContent=label;
        const pin=document.createElement("button");
        // A button inside a link is invalid, so the pin is a separate sibling in a wrapper.
        const wrapper=document.createElement("div");wrapper.className="gp-side-link-row";wrapper.style.cssText="display:flex;align-items:center;position:relative;";
        link.append(ico,txt);
        if(wasActive){link.classList.add("active");link.setAttribute("aria-current","page");}
        link.title=label;
        pin.type="button";pin.className="gp-side-pin";pin.setAttribute("aria-label",`Pin ${label} to favorites`);
        pin.title="Pin to favorites";pin.textContent="☆";
        pin.addEventListener("click",()=>{if(pins.has(id))pins.delete(id);else pins.add(id);storage.write("gp_nav_pins",[...pins]);sync();});
        linkMeta.set(id,{link,pin,label,glyph});wrapper.append(link,pin);contents.append(wrapper);
      });
      outer.append(toggle,contents);nav.append(outer);groups.push({outer,toggle,contents,key:group.key});
      toggle.addEventListener("click",()=>{const closed=outer.classList.toggle("is-closed");toggle.setAttribute("aria-expanded",String(!closed));storage.write(`gp_nav_grp_${group.key}`,closed);});
      const closed=storage.read(`gp_nav_grp_${group.key}`,false);
      if(closed && !contents.querySelector('[aria-current="page"]')){outer.classList.add("is-closed");toggle.setAttribute("aria-expanded","false");}
    }
    const footer=document.createElement("div");footer.className="gp-side-foot";
    const settings=document.createElement("button");settings.type="button";settings.className="gp-side-settings-button";settings.innerHTML='<span aria-hidden="true">☷</span><span class="gp-side-foot-label">Display preferences</span>';
    settings.setAttribute("aria-expanded","false");
    const options=document.createElement("div");options.className="gp-side-options";
    const compact=document.createElement("label");compact.className="gp-side-settings-row";
    const check=document.createElement("input");check.type="checkbox";check.checked=storage.read("gp_nav_compact",false);
    compact.append(check,document.createTextNode("Compact cards and tables"));options.append(compact);
    check.addEventListener("change",()=>{storage.write("gp_nav_compact",check.checked);document.body.classList.toggle("gp-density-compact",check.checked);});
    const hint=document.createElement("small");hint.textContent="Pin modules with ☆, collapse groups, or use the narrow sidebar on desktop.";options.append(hint);
    settings.addEventListener("click",()=>{const open=options.classList.toggle("is-open");settings.setAttribute("aria-expanded",String(open));});
    footer.append(settings,options);nav.append(footer);
    const scrim=document.createElement("div");scrim.className="gp-nav-scrim";scrim.addEventListener("click",()=>document.body.classList.remove("gp-nav-open"));document.body.append(scrim);
    const trigger=document.createElement("button");trigger.type="button";trigger.className="gp-mobile-nav-trigger";trigger.innerHTML='<span aria-hidden="true">☰</span> Menu';trigger.setAttribute("aria-label","Open GLASSPRO menu");trigger.setAttribute("aria-expanded","false");
    const header=document.querySelector("header");if(header)header.prepend(trigger);
    trigger.addEventListener("click",()=>{const open=document.body.classList.toggle("gp-nav-open");trigger.setAttribute("aria-expanded",String(open));});
    document.addEventListener("keydown",e=>{if(e.key==="Escape")document.body.classList.remove("gp-nav-open");});
    const collapsed=storage.read("gp_nav_collapsed",false);
    document.body.classList.toggle("gp-side-collapsed",collapsed);collapse.textContent=collapsed?"›":"‹";
    document.body.classList.toggle("gp-density-compact",check.checked);
    const sync=()=>{
      const visible=!nav.classList.contains("hidden");
      document.body.classList.toggle("gp-shell-active",visible);
      if(!visible)document.body.classList.remove("gp-nav-open");
      trigger.hidden=!visible;
      for(const {outer,contents} of groups){
        const ok=[...contents.querySelectorAll("a.gp-side-link")].some(a=>!a.classList.contains("hidden"));
        outer.classList.toggle("hidden",!ok);
      }
      favorites.replaceChildren();
      for(const [id,meta] of linkMeta){
        const enabled=!meta.link.classList.contains("hidden");
        const starred=pins.has(id);meta.pin.classList.toggle("is-pinned",starred);meta.pin.textContent=starred?"★":"☆";
        meta.pin.setAttribute("aria-label",(starred?"Unpin ":"Pin ")+meta.label);
        if(starred&&enabled){const a=document.createElement("a");a.className="gp-side-link";a.href=meta.link.href;a.title=meta.label;a.innerHTML=`<span class="gp-side-icon" aria-hidden="true">${meta.glyph}</span>`;
          const span=document.createElement("span");span.className="gp-side-title";span.textContent=meta.label;a.append(span);favorites.append(a);}
      }
      favGroup.classList.toggle("hidden",!favorites.childElementCount);
    };
    const observer=new MutationObserver(records=>{
      if(records.some(r=>r.target===nav || (r.target.matches && r.target.matches("a.gp-side-link"))))sync();
    });
    observer.observe(nav,{subtree:true,attributes:true,attributeFilter:["class"]});
    sync();
  });
})();
