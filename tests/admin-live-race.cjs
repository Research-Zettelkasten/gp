const {execFile,execFileSync}=require('node:child_process'),assert=require('node:assert/strict');
const employee='22222222-2222-4222-8222-222222222222',admin='11111111-1111-4111-8111-111111111111';
const sql=q=>execFileSync('psql',['-XqAt','-v','ON_ERROR_STOP=1','-c',q],{encoding:'utf8'}).trim();
const call=q=>new Promise((resolve,reject)=>execFile('psql',['-XqAt','-v','ON_ERROR_STOP=1','-c',q],{encoding:'utf8'},(e,out)=>e?reject(e):resolve(JSON.parse(out.trim().split('\n').pop()))));
(async()=>{
 assert.equal(sql('select current_database()'),'gp_clock_test');
 const start=sql("select public.test_clock_at(date_trunc('minute',clock_timestamp()-interval '8 hours')+interval '23 seconds')");
 const [correction,finish]=await Promise.allSettled([
  call(`select set_config('request.jwt.claim.sub','${admin}',false);select public.gp_admin_correct_live_clock_in('${employee}',${start},to_timestamp(${start}/1000.0)-interval '30 minutes','Verified actual start during a simultaneous shift clock-out')`),
  call(`select set_config('request.jwt.claim.sub','${admin}',false);select public.gp_finish_active_shift(${start},'${employee}',to_timestamp(${start}/1000.0)+interval '3 hours','Verified actual end during simultaneous administrator correction')`)
 ]);
 assert.equal(finish.status,'fulfilled');
 if(correction.status==='rejected')assert.match(correction.reason.stderr,/changed or ended/);
 assert.equal(sql(`select count(*) from public.time_logs where session_started_at_ms=${start}`),'1');
 assert.equal(Number(sql(`select decimal_hours::numeric from public.time_logs where session_started_at_ms=${start}`)),correction.status==='fulfilled'?3.5:3);
 assert.equal(sql(`select count(*) from public.active_time_sessions where auth_user_id='${employee}'`),'0');
 console.log('PASS: concurrent direct live correction and clock-out create one timecard with the confirmed start.');
})().catch(e=>{console.error(e);process.exitCode=1;});
