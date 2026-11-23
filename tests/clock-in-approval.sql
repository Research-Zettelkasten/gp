\set ON_ERROR_STOP on
do $$begin if current_database()<>'gp_clock_test' then raise exception 'Use disposable gp_clock_test';end if;end$$;
select set_config('request.jwt.claim.sub','',false);
\ir ../supabase/migrations/2026-11-23-clock-in-approval.sql
\ir ../supabase/migrations/2026-11-23-clock-in-approval.sql
delete from public.active_time_sessions;
select public.test_seed_shift('22222222-2222-4222-8222-222222222222',3) as correction_start \gset
update public.active_time_sessions set lunch_out_at=started_at+interval '1 hour',lunch_in_at=started_at+interval '90 minutes';
select set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',false);
select public.gp_request_clock_in_change(:correction_start,to_timestamp(:correction_start/1000.0)-interval '30 minutes','Started work thirty minutes before the recorded punch') as request_id \gset
select public.test_assert((select approved_clock_in_at is null and started_at_ms=:correction_start from public.active_time_sessions),'pending request changes no punch');
select public.test_expect_error('select public.gp_request_clock_in_change('||:correction_start||',clock_timestamp()+interval ''1 hour'',''Checking future clock in rejection'')','not in the future');
select public.test_expect_error('select public.gp_request_clock_in_change('||:correction_start||',to_timestamp('||:correction_start||'/1000.0)-interval ''15 minutes'',''Duplicate pending request is not allowed'')','already awaiting');
select public.test_expect_error('update public.active_time_sessions set approved_clock_in_at=started_at-interval ''1 hour''','administrator approval');
select public.test_expect_error($q$insert into public.time_logs(auth_user_id,employee_name,work_date,clock_in,clock_out,decimal_hours,no_lunch_reason) values('22222222-2222-4222-8222-222222222222','Test Employee',current_date,'08:00','17:00',9,'Attempt to use a legacy manual-entry client')$q$,'Use live');
select set_config('request.jwt.claim.sub','33333333-3333-4333-8333-333333333333',false);
select public.test_expect_error('select public.gp_review_clock_in_change('||:request_id||',true,''Employee cannot approve another employee correction'')','administrator');
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',false);
select public.gp_review_clock_in_change(:request_id,true,'Verified actual start and retained the original recorded punch');
select public.test_assert((select started_at=to_timestamp(:correction_start/1000.0) and started_at_ms=:correction_start and approved_clock_in_at=started_at-interval '30 minutes' from public.active_time_sessions),'approval preserves original start identity');
select public.gp_review_clock_in_change(:request_id,true,'Retry after successful confirmation does not duplicate decisions');
select public.test_assert((select count(*)=1 from public.audit_logs where action_type='TIME_CLOCK_IN_REVIEW' and (details::jsonb->>'request_id')::bigint=:request_id),'approval is idempotent');
select set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',false);
select public.gp_finish_active_shift(:correction_start,null,null,'','');
select public.test_assert((select session_started_at_ms=:correction_start and approved_clock_in_at=to_timestamp(:correction_start/1000.0)-interval '30 minutes' and decimal_hours::numeric>=3 and decimal_hours::numeric<3.1 and break_minutes=30 and clock_in_correction_id=:request_id from public.time_logs where session_started_at_ms=:correction_start),'employee clock-out uses approved start and exact lunch with same immutable session');
-- Approval may arrive after the employee has clocked out.
select set_config('request.jwt.claim.sub','',false);
select public.test_seed_shift('22222222-2222-4222-8222-222222222222',4) as completed_start \gset
select set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',false);
select public.gp_request_clock_in_change(:completed_start,to_timestamp(:completed_start/1000.0)-interval '30 minutes','Actual work started before this second recorded shift') as completed_request \gset
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',false);
select public.gp_finish_active_shift(:completed_start,'22222222-2222-4222-8222-222222222222',to_timestamp(:completed_start/1000.0)+interval '3 hours','Verified end after three recorded hours');
select public.gp_review_clock_in_change(:completed_request,true,'Verified earlier start after the employee already clocked out');
select public.test_assert((select decimal_hours::numeric=3.5 and session_started_at_ms=:completed_start and clock_in_correction_id=:completed_request from public.time_logs where session_started_at_ms=:completed_start),'completed hours recalculate once without another timecard');
select public.test_assert((select count(*)=1 from public.time_logs where session_started_at_ms=:completed_start),'completed correction does not duplicate payroll');
-- Rejection, withdrawal and audit rollback all preserve current punches.
select set_config('request.jwt.claim.sub','',false);
select public.test_seed_shift('22222222-2222-4222-8222-222222222222',5) as rejected_start \gset
select set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',false);
select public.gp_request_clock_in_change(:rejected_start,to_timestamp(:rejected_start/1000.0)-interval '15 minutes','Request to check another clock in correction') as rejected_request \gset
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',false);
select public.gp_review_clock_in_change(:rejected_request,false,'Original recorded punch was verified as the actual arrival');
select public.test_assert((select approved_clock_in_at is null from public.active_time_sessions),'rejection changes no actual start');
select set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',false);
select public.gp_request_clock_in_change(:rejected_start,to_timestamp(:rejected_start/1000.0)-interval '10 minutes','Withdraw a mistyped clock in request') as withdrawn_request \gset
select public.gp_cancel_clock_in_change(:withdrawn_request);
select public.test_assert((select status='cancelled' from public.gp_clock_in_requests where id=:withdrawn_request),'employee can withdraw pending request without losing history');
select public.gp_request_clock_in_change(:rejected_start,to_timestamp(:rejected_start/1000.0)-interval '10 minutes','Checking atomic rollback on administrator approval') as rollback_request \gset
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',false);
create trigger test_fail_audit before insert on public.audit_logs for each row execute function public.test_fail_audit();
select public.test_expect_error('select public.gp_review_clock_in_change('||:rollback_request||',true,''Approval must roll back if the audit record fails'')','simulated audit failure');
select public.test_assert((select approved_clock_in_at is null from public.active_time_sessions),'failed audit rolls back effective time');
select public.test_assert((select status='pending' from public.gp_clock_in_requests where id=:rollback_request),'failed audit leaves request pending');
drop trigger test_fail_audit on public.audit_logs;
select set_config('request.jwt.claim.sub','',false);
delete from public.active_time_sessions;
-- An automatic default may be corrected before its separate clock-out review.
select public.test_clock_at('2026-11-04 08:00-05') as auto_request_start \gset
select set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',false);
select public.gp_request_clock_in_change(:auto_request_start,'2026-11-04 07:30-05','Actual start was before an older missed clock-out') as auto_request \gset
select set_config('request.jwt.claim.sub','',false);
select public.gp_auto_clock_out_due();
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',false);
select public.gp_review_clock_in_change(:auto_request,true,'Verified actual clock-in after automatic missed-punch closure');
select id as auto_review_id from public.gp_shift_close_reviews where session_started_at_ms=:auto_request_start \gset
select public.gp_review_auto_clock_out(:auto_review_id,'Verified 5 PM clock-out after approving the corrected start');
select public.test_assert((select decimal_hours::numeric=9.5 and clock_in='07:30' and clock_out='17:00' and clock_out_review_status='approved' from public.time_logs where session_started_at_ms=:auto_request_start),'automatic-close review accepts approved corrected start');
select set_config('request.jwt.claim.sub','33333333-3333-4333-8333-333333333333',false);
set role authenticated;
select public.test_assert((select count(*)=0 from public.gp_clock_in_requests),'another employee cannot read requests');
reset role;
select public.test_assert(not has_table_privilege('authenticated','public.gp_clock_in_requests','insert'),'requests cannot be inserted directly');
select public.test_assert(not has_function_privilege('anon','public.gp_review_clock_in_change(bigint,boolean,text)','execute'),'anonymous review denied');
select set_config('request.jwt.claim.sub','',false);
\echo 'PASS: live-only enforcement, pending approvals, immutable punches, completed payroll corrections, review RLS and rollback.'
