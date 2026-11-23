const {execFile,execFileSync}=require('node:child_process'),assert=require('node:assert/strict');
const employee='22222222-2222-4222-8222-222222222222',admin='11111111-1111-4111-8111-111111111111';
function sql(q){return execFileSync('psql',['-XqAt','-v','ON_ERROR_STOP=1','-c',q],{encoding:'utf8'}).trim();}
function call(q){return new Promise((resolve,reject)=>execFile('psql',['-XqAt','-v','ON_ERROR_STOP=1','-c',q],{encoding:'utf8'},(e,out)=>e?reject(e):resolve(JSON.parse(out.trim().split('\n').pop()))));}
(async()=>{assert.equal(sql('select current_database()'),'gp_clock_test');
 const start=sql("select public.test_clock_at('2026-11-08 08:00-05')");
 await Promise.all([call("select jsonb_build_object('closed',public.gp_auto_clock_out_due())"),call("select set_config('request.jwt.claim.sub','"+admin+"',false);select public.gp_finish_active_shift("+start+",'"+employee+"','2026-11-08 17:00-05','Verified actual 5 PM end while scheduled worker was running')")]);
 assert.equal(sql('select count(*) from public.time_logs where session_started_at_ms='+start),'1');assert.equal(sql("select count(*) from public.active_time_sessions where auth_user_id='"+employee+"'"),'0');
 const stale=sql("select public.test_clock_at('2026-11-07 08:00-05')"),id=sql("insert into public.time_logs(auth_user_id,employee_name,work_date,clock_in,clock_out,decimal_hours,notes) values('"+employee+"','Test Employee','2026-11-07','08:00','16:00',8,'Saved before a failed legacy delete') returning id").split('\n')[0];
 await Promise.all([call("select jsonb_build_object('closed',public.gp_auto_clock_out_due())"),call("select set_config('request.jwt.claim.sub','"+admin+"',false);select public.gp_clear_saved_active_shift('"+employee+"',"+stale+","+id+",'Verified existing timecard while scheduled worker was running')")]);
 assert.equal(sql("select count(*) from public.time_logs where work_date='2026-11-07'"),'1');assert.equal(sql('select decimal_hours::numeric from public.time_logs where id='+id),'8.00');assert.equal(sql("select count(*) from public.active_time_sessions where auth_user_id='"+employee+"'"),'0');console.log('PASS: concurrent scheduled/manual completion and legacy recovery create no duplicate timecards.');
})().catch(e=>{console.error(e);process.exitCode=1;});
