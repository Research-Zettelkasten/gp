/* Employee home preferences and permission-aware summaries. */
(function homeCore(){
  'use strict';
  const ids=['time','quotes','collections','customers','commission','fleet','safety','admin'];
  const catalog=[
    {id:'time',name:'Time Clock',url:'index.html',icon:'◷',description:'Clock in, take lunch, and review your shifts.',permission:u=>u.perm_time===true||u.perm_admin===true},
    {id:'commission',name:'Commissions & Work Orders',url:'commissions.html',icon:'▤',description:'Log completed jobs and follow your commissions.',permission:u=>u.perm_commission===true||u.perm_admin===true},
    {id:'quotes',name:'Quote Call-Backs',url:'quotes.html',icon:'◉',description:'Keep customer conversations and follow-ups moving.',permission:u=>u.perm_quotes===true||u.perm_admin===true},
    {id:'collections',name:'Collections',url:'collections.html',icon:'▥',description:'Review your collection queue and account follow-ups.',permission:u=>u.perm_collections===true||u.perm_admin===true},
    {id:'customers',name:'Customers',url:'customers.html',icon:'♙',description:'Find contact details, quotes, invoices and shared customer notes.',permission:u=>u.perm_quotes===true||u.perm_collections===true||u.perm_admin===true},
    {id:'fleet',name:'Fleet',url:'fleet.html',icon:'◇',description:'Manage inspections, garage records and registrations.',permission:u=>u.perm_vehicle_view===true||u.perm_vehicle_submit===true||u.perm_admin===true},
    {id:'safety',name:'Safety',url:'safety.html',icon:'◈',description:'Find shop and field safety procedures.',permission:u=>u.perm_safety===true||u.perm_admin===true},
    {id:'admin',name:'Management',url:'admin.html',icon:'⚙',description:'Review your team, timecards, and daily operations.',permission:u=>u.perm_admin===true}
  ];
  function normalize(x){
    const order=[...new Set([...(Array.isArray(x?.order)?x.order:[]),...catalog.map(c=>c.id)])].filter(id=>ids.includes(id));
    return {layout:x?.layout==='one'?'one':'two',order,hidden:[...new Set(Array.isArray(x?.hidden)?x.hidden:[])].filter(id=>ids.includes(id))};
  }
  function allowed(user){return catalog.filter(c=>user?.active===true&&c.permission(user));}
  function weekly(logs,now=new Date()){
    const start=new Date(now.getFullYear(),now.getMonth(),now.getDate());start.setDate(start.getDate()-((start.getDay()+6)%7));
    const end=new Date(start);end.setDate(end.getDate()+7);
    const rows=(logs||[]).filter(r=>{const date=new Date(String(r.work_date)+'T12:00:00');return date>=start&&date<end;});
    return {hours:rows.reduce((sum,r)=>sum+(Number.isFinite(Number(r.decimal_hours))?Number(r.decimal_hours):0),0),shifts:rows.length,pending:rows.filter(r=>r.lunch_review_status==='pending').length,start,end};
  }
  globalThis.GP_HOME_CORE=Object.freeze({normalize,allowed,weekly});
})();

