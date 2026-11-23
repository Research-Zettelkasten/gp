\set ON_ERROR_STOP on
do $$begin if current_database()<>'gp_clock_test' then raise exception 'Use disposable gp_clock_test';end if;end$$;
select set_config('request.jwt.claim.sub','',false);
\ir ../supabase/migrations/2026-11-23-navigation-and-admin-live-corrections.sql
\ir ../supabase/migrations/2026-11-23-navigation-and-admin-live-corrections.sql
delete from public.active_time_sessions;
select public.test_clock_at(date_trunc('minute',clock_timestamp()-interval '7 hours')+interval '17 seconds') as direct_start \gset
update public.active_time_sessions set lunch_out_at=started_at+interval '1 hour',lunch_in_at=started_at+interval '90 minutes';
select public.test_expect_error('select public.gp_admin_correct_live_clock_in(''22222222-2222-4222-8222-222222222222'','||:direct_start||',to_timestamp('||:direct_start||'/1000.0)-interval ''30 minutes'',''Anonymous cannot correct live punches'')','administrator');
select set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',false);
select public.test_expect_error('select public.gp_admin_correct_live_clock_in(''22222222-2222-4222-8222-222222222222'','||:direct_start||',to_timestamp('||:direct_start||'/1000.0)-interval ''30 minutes'',''Employee cannot bypass administrator approval'')','administrator');
select public.gp_request_clock_in_change(:direct_start,to_timestamp(:direct_start/1000.0)-interval '15 minutes','Employee requests verification of their actual start') as pending_id \gset
select public.test_assert((select requested_by=auth_user_id from public.gp_clock_in_requests where id=:pending_id),'employee-origin requests remain identifiable');
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',false);
select public.test_expect_error('select public.gp_admin_correct_live_clock_in(''22222222-2222-4222-8222-222222222222'','||:direct_start||',clock_timestamp()+interval ''1 hour'',''Future live corrections are never allowed'')','not in the future');
select public.test_expect_error('select public.gp_admin_correct_live_clock_in(''22222222-2222-4222-8222-222222222222'','||(:direct_start+1)||',to_timestamp('||:direct_start||'/1000.0)-interval ''30 minutes'',''Stale session identifiers cannot correct a replacement shift'')','changed or ended');
select public.test_expect_error('select public.gp_admin_correct_live_clock_in(''22222222-2222-4222-8222-222222222222'','||:direct_start||',to_timestamp('||:direct_start||'/1000.0)+interval ''2 hours'',''Start cannot be moved beyond the recorded lunch'')','after the recorded lunch');
select public.test_assert((select status='pending' from public.gp_clock_in_requests where id=:pending_id),'failed correction does not discard a pending employee request');
create trigger test_fail_audit before insert on public.audit_logs for each row execute function public.test_fail_audit();
select public.test_expect_error('select public.gp_admin_correct_live_clock_in(''22222222-2222-4222-8222-222222222222'','||:direct_start||',to_timestamp('||:direct_start||'/1000.0)-interval ''30 minutes'',''Every live correction must preserve an atomic audit trail'')','simulated audit failure');
select public.test_assert((select approved_clock_in_at is null from public.active_time_sessions),'audit failure rolls back live correction');
select public.test_assert((select status='pending' from public.gp_clock_in_requests where id=:pending_id),'audit failure also rolls back superseded request status');
drop trigger test_fail_audit on public.audit_logs;
select public.gp_admin_correct_live_clock_in('22222222-2222-4222-8222-222222222222',:direct_start,to_timestamp(:direct_start/1000.0)-interval '30 minutes','Verified actual arrival directly with employee and supervisor') as direct_result \gset
select public.test_assert((select started_at_ms=:direct_start and started_at=to_timestamp(:direct_start/1000.0) and approved_clock_in_at=started_at-interval '30 minutes' and lunch_in_at=started_at+interval '90 minutes' from public.active_time_sessions),'direct correction preserves original punches and lunch evidence');
select public.test_assert((select status='rejected' and review_note like 'Superseded%' from public.gp_clock_in_requests where id=:pending_id),'superseded employee request remains in history');
select public.test_assert((select status='approved' and requested_by='11111111-1111-4111-8111-111111111111' and reviewed_by=requested_by from public.gp_clock_in_requests where id=(:'direct_result'::jsonb->>'request_id')::bigint),'direct correction is attributed to the approving administrator');
select public.test_assert((public.gp_admin_correct_live_clock_in('22222222-2222-4222-8222-222222222222',:direct_start,to_timestamp(:direct_start/1000.0)-interval '30 minutes','Retry confirmed correction without duplicating history')->>'unchanged')::boolean,'same-time retry is idempotent');
select public.test_assert((select count(*)=1 from public.audit_logs where action_type='TIME_CLOCK_IN_ADMIN_CORRECT' and (details::jsonb->'original_punch'->>'started_at_ms')::bigint=:direct_start),'one direct-correction audit record');
select public.gp_finish_active_shift(:direct_start,'22222222-2222-4222-8222-222222222222',to_timestamp(:direct_start/1000.0)+interval '3 hours','Verified shift end after direct live clock-in correction');
select public.test_assert((select decimal_hours::numeric=3 and break_minutes=30 and session_started_at_ms=:direct_start and approved_clock_in_at=to_timestamp(:direct_start/1000.0)-interval '30 minutes' from public.time_logs where session_started_at_ms=:direct_start),'clock-out calculates approved start and original exact lunch');
select set_config('request.jwt.claim.sub','',false);
select public.test_clock_at(to_timestamp(:direct_start/1000.0));
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',false);
select public.test_expect_error('select public.gp_admin_correct_live_clock_in(''22222222-2222-4222-8222-222222222222'','||:direct_start||',to_timestamp('||:direct_start||'/1000.0)-interval ''45 minutes'',''A saved legacy timecard must first be recovered'')','timecard already matches');
select set_config('request.jwt.claim.sub','',false);
delete from public.active_time_sessions;

-- Preferences belong only to the authenticated account, even for administrators.
select set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',false);
set role authenticated;
select public.gp_save_navigation_preferences('{"hidden":["navLinkQuotes"],"favoritesOnly":true}','22222222-2222-4222-8222-222222222222');
select public.test_assert((select count(*)=1 from public.gp_navigation_preferences),'employee reads own menu');
select public.test_expect_error($q$select public.gp_save_navigation_preferences('{}','33333333-3333-4333-8333-333333333333')$q$,'active employee');
select public.test_expect_error($q$select public.gp_save_navigation_preferences('[]','22222222-2222-4222-8222-222222222222')$q$,'preference object');
select public.test_expect_error($q$select public.gp_save_navigation_preferences(jsonb_build_object('large',repeat('x',17000)),'22222222-2222-4222-8222-222222222222')$q$,'16 KB');
reset role;
select set_config('request.jwt.claim.sub','33333333-3333-4333-8333-333333333333',false);
set role authenticated;
select public.test_assert((select count(*)=0 from public.gp_navigation_preferences),'another employee cannot read menu preferences');
reset role;
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',false);
set role authenticated;
select public.test_assert((select count(*)=0 from public.gp_navigation_preferences),'admin does not inherit another user menu');
select public.gp_save_navigation_preferences('{"favorites":["navLinkAdmin"]}','11111111-1111-4111-8111-111111111111');
select public.test_assert((select count(*)=1 from public.gp_navigation_preferences),'admin owns separate preferences');
reset role;
update public.app_users set active=false where auth_user_id='22222222-2222-4222-8222-222222222222';
select set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',false);
set role authenticated;
select public.test_assert((select count(*)=0 from public.gp_navigation_preferences),'inactive account cannot read stored preferences');
select public.test_expect_error($q$select public.gp_save_navigation_preferences('{}','22222222-2222-4222-8222-222222222222')$q$,'active employee');
reset role;
update public.app_users set active=true where auth_user_id='22222222-2222-4222-8222-222222222222';
select public.test_assert(not has_table_privilege('authenticated','public.gp_navigation_preferences','insert'),'no direct preference writes');
select public.test_assert(not has_function_privilege('anon','public.gp_admin_correct_live_clock_in(uuid,bigint,timestamptz,text)','execute'),'anonymous live correction denied');
select public.test_assert(not has_function_privilege('anon','public.gp_save_navigation_preferences(jsonb,uuid)','execute'),'anonymous preference write denied');
\echo 'PASS: direct administrator corrections, immutable evidence, superseded requests, rollback, exact lunches and per-account navigation RLS.'
