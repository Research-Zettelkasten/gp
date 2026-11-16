const {execFile,execFileSync}=require('node:child_process');
const assert=require('node:assert/strict');
const admin='11111111-1111-4111-8111-111111111111',employee='22222222-2222-4222-8222-222222222222';
function sql(q){return execFileSync('psql',['-XqAt','-v','ON_ERROR_STOP=1','-c',q],{encoding:'utf8'}).trim();}
function call(q){return new Promise((resolve,reject)=>execFile('psql',['-XqAt','-v','ON_ERROR_STOP=1','-c',q],{encoding:'utf8'},(error,out)=>error?reject(error):resolve(JSON.parse(out.trim().split('\n').pop()))));}
(async()=>{
  assert.equal(sql('select current_database()'),'gp_clock_test');
  const start=sql("select public.test_seed_shift('"+employee+"',3)");
  const results=await Promise.all([
    call("select set_config('request.jwt.claim.sub','"+employee+"',false);select public.gp_finish_active_shift("+start+",null,null,'','Customer workload prevented lunch')"),
    call("select set_config('request.jwt.claim.sub','"+admin+"',false);select public.gp_finish_active_shift("+start+",'"+employee+"',null,'Employee forgot to clock out')")
  ]);
  assert.equal(results[0].shift_id,results[1].shift_id);
  assert.equal(results.filter(x=>x.already_closed).length,1);
  assert.equal(sql('select count(*) from public.time_logs where session_started_at_ms='+start),'1');
  assert.equal(sql("select count(*) from public.active_time_sessions where auth_user_id='"+employee+"'"),'0');
  console.log('Concurrent employee/admin clock-outs create one timecard and one completion.');
})().catch(e=>{console.error(e);process.exitCode=1;});
