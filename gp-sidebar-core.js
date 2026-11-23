/* Personal navigation preferences never grant module permissions. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;root.GP_NAV_CORE=api;})(globalThis,function(){
 'use strict';
 const items=[
  {id:'navLinkTime',label:'Time Clock',icon:'◷',path:'index.html',group:'workspace',permissions:['perm_time']},
  {id:'navLinkComm',label:'Work Orders & Commissions',icon:'▤',path:'commissions.html',group:'workspace',permissions:['perm_commission']},
  {id:'navLinkCustomers',label:'Customers',icon:'♙',path:'customers.html',group:'workspace',permissions:['perm_quotes','perm_collections']},
  {id:'navLinkQuotes',label:'Quote Call-Backs',icon:'◉',path:'quotes.html',group:'workspace',permissions:['perm_quotes']},
  {id:'navLinkCollections',label:'Collections',icon:'▥',path:'collections.html',group:'workspace',permissions:['perm_collections']},
  {id:'navLinkFleet',label:'Fleet',icon:'◇',path:'fleet.html',group:'workspace',permissions:['perm_vehicle_submit','perm_vehicle_view']},
  {id:'navLinkSafety',label:'Safety',icon:'◈',path:'safety.html',group:'workspace',permissions:['perm_safety']},
  {id:'adminOverviewPane',label:'Command Center',icon:'◫',path:'admin.html#adminOverviewPane',group:'administration',permissions:[]},
  {id:'adminMOSPane',label:'MultiplyOS Hub',icon:'▦',path:'admin.html#adminMOSPane',group:'administration',permissions:[]},
  {id:'navLinkAdmin',label:'Team Management',icon:'⚙',path:'admin.html#adminTimePane',group:'administration',permissions:[]}
 ];
 const sections=['navLinkQuotes:board','navLinkQuotes:admin-review','navLinkQuotes:competitors','navLinkCollections:queue','navLinkCollections:reconcile','navLinkCollections:closeout','navLinkCollections:imports','navLinkCollections:notes','navLinkFleet:inspectPane','navLinkFleet:historyPane','navLinkFleet:garagePane','admin:adminUsersPane','admin:adminCommissionsPane','admin:adminTimePane','admin:adminFleetPane'];
 const ids=items.map(i=>i.id);
 function cleanList(value,allow){return [...new Set(Array.isArray(value)?value.filter(v=>allow.includes(v)):[])];}
 function normalize(raw){const r=raw&&typeof raw==='object'&&!Array.isArray(raw)?raw:{};return {version:1,order:[...cleanList(r.order,ids),...ids.filter(id=>!Array.isArray(r.order)||!r.order.includes(id))],hidden:cleanList(r.hidden,ids),favorites:cleanList(r.favorites,ids),hiddenSections:cleanList(r.hiddenSections,sections),closedGroups:cleanList(r.closedGroups,['workspace','administration']),favoritesOnly:r.favoritesOnly===true,showSections:r.showSections!==false,compact:r.compact===true,collapsed:r.collapsed===true};}
 function allowed(user){return items.filter(i=>user?.active===true&&(user.perm_admin===true||(i.group!=='administration'&&i.permissions.some(p=>user[p]===true))));}
 function visible(prefs,id,current,searching=false){const p=normalize(prefs);return searching||id===current||(!p.hidden.includes(id)&&(!p.favoritesOnly||p.favorites.includes(id)));}
 function move(prefs,id,delta,allowedIds=ids){const p=normalize(prefs),item=items.find(i=>i.id===id);if(!item)return p;const peers=p.order.filter(x=>allowedIds.includes(x)&&items.find(i=>i.id===x)?.group===item.group),at=peers.indexOf(id),next=at+delta;if(at<0||next<0||next>=peers.length)return p;const a=p.order.indexOf(id),b=p.order.indexOf(peers[next]);[p.order[a],p.order[b]]=[p.order[b],p.order[a]];return p;}
 return Object.freeze({items,sections,normalize,allowed,visible,move});
});
