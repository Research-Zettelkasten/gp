/* Management Workspace Builder: pure, bounded preference validation.
 * Customization is presentation-only: RLS and employee permissions are separate. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;root.GP_DASH_CORE=api;})(typeof window!=='undefined'?window:globalThis,function(){'use strict';
const PANES=[
{id:'adminOverviewPane',label:'Command Center',widgets:[{id:'dashWidgetKpis',label:'Performance cards'},{id:'dashWidgetOvertime',label:'Overtime alerts'},{id:'dashWidgetDivision',label:'Department scorecards'}]},
{id:'adminMOSPane',label:'MultiplyOS Hub',widgets:[{id:'gpWidgetMOSOverview',label:'MultiplyOS scorecard'},{id:'gpWidgetAccountingBridge',label:'Mainstreet/QBO accounting review'}]},
{id:'adminUsersPane',label:'Users & Roles',widgets:[{id:'gpWidgetUserEditor',label:'Employee editor'},{id:'gpWidgetUserRoster',label:'Employee directory'}]},
{id:'adminCommissionsPane',label:'Commissions & WOs',widgets:[{id:'gpWidgetCommissionBoard',label:'Commissions & work orders'}]},
{id:'adminTimePane',label:'Time & Geotags',widgets:[{id:'gpWidgetLunchReview',label:'No-lunch manager review'},{id:'gpWidgetPayroll',label:'Weekly payroll overview'},{id:'gpWidgetLiveTime',label:'Live time monitoring'},{id:'gpWidgetTimeHistory',label:'Weekly shift history'}]},
{id:'adminFleetPane',label:'Audit Trail',widgets:[{id:'gpWidgetAuditHistory',label:'Audit trail'}]}
];
const names=PANES.map(p=>p.id);const widgetIds=PANES.flatMap(p=>p.widgets.map(w=>w.id));
function defaults(){return {locked:true,defaultPane:'adminOverviewPane',columns:'two',density:'comfortable',contentWidth:'standard',tabOrder:[...names],hiddenTabs:[],hiddenWidgets:[],tabNames:{},widgetOrder:Object.fromEntries(PANES.map(p=>[p.id,p.widgets.map(w=>w.id)]))};}
function sanitizeOrder(candidate,allow){const seen=new Set();const a=[];for(const v of Array.isArray(candidate)?candidate:[]){if(allow.includes(v)&&!seen.has(v)){seen.add(v);a.push(v);}}for(const v of allow)if(!seen.has(v))a.push(v);return a;}
function limitLabel(label,fallback){const s=String(label??'').replace(/[<>\x00-\x1f]/g,'').trim().slice(0,35);return s||fallback;}
function normalize(raw){const r=raw&&typeof raw==='object'?raw:{};const out=defaults();out.locked=r.locked!==false;out.columns=r.columns==='one'?'one':'two';out.density=r.density==='compact'?'compact':'comfortable';out.contentWidth=r.contentWidth==='wide'?'wide':'standard';out.tabOrder=sanitizeOrder(r.tabOrder,names);out.hiddenTabs=[...new Set(Array.isArray(r.hiddenTabs)?r.hiddenTabs.filter(v=>names.includes(v)):[])];if(out.hiddenTabs.length===names.length)out.hiddenTabs.pop();out.hiddenWidgets=[...new Set(Array.isArray(r.hiddenWidgets)?r.hiddenWidgets.filter(v=>widgetIds.includes(v)):[])];out.tabNames={};for(const p of PANES)if(r.tabNames&&r.tabNames[p.id])out.tabNames[p.id]=limitLabel(r.tabNames[p.id],p.label);out.widgetOrder=Object.fromEntries(PANES.map(p=>[p.id,sanitizeOrder(r.widgetOrder?.[p.id],p.widgets.map(w=>w.id))]));out.defaultPane=names.includes(r.defaultPane)&&!out.hiddenTabs.includes(r.defaultPane)?r.defaultPane:out.tabOrder.find(v=>!out.hiddenTabs.includes(v));return out;}
function reorder(items,id,delta){const a=[...items],i=a.indexOf(id),next=i+delta;if(i<0||next<0||next>=a.length)return a;[a[i],a[next]]=[a[next],a[i]];return a;}
return {PANES,defaults,normalize,reorder,limitLabel};});
