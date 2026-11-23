\set ON_ERROR_STOP on
do $$ begin if current_database() <> 'gp_clock_test' then raise exception 'Use disposable gp_clock_test'; end if; end $$;
\ir ../supabase/migrations/2026-11-23-admin-live-lunch-correction.sql
\ir ../supabase/migrations/2026-11-23-admin-live-lunch-correction.sql

begin;
select set_config('request.jwt.claim.sub', '', false);
delete from public.active_time_sessions;
\set employee '22222222-2222-4222-8222-222222222222'
\set admin '11111111-1111-4111-8111-111111111111'
select public.test_clock_at(date_trunc('minute', clock_timestamp() - interval '6 hours') + interval '37 seconds') as start_ms \gset
select to_timestamp(:start_ms / 1000.0) + interval '1 hour' as lunch_out,
       to_timestamp(:start_ms / 1000.0) + interval '102 minutes' as lunch_back \gset

select public.test_assert(not has_function_privilege('anon',
  'public.gp_admin_correct_live_lunch(uuid,bigint,timestamptz,timestamptz,timestamptz,integer,timestamptz,timestamptz,text)',
  'execute'), 'anonymous users cannot call lunch correction');
select set_config('request.jwt.claim.sub', :'employee', false);
set local role authenticated;
select public.test_expect_error(format(
  'select public.gp_admin_correct_live_lunch(%L,%s,null,null,null,0,%L,%L,%L)',
  :'employee', :start_ms, :'lunch_out', :'lunch_back', 'This employee cannot correct their own break'
), 'administrator');
reset role;
select set_config('request.jwt.claim.sub', :'admin', false);
select public.test_expect_error(format(
  'select public.gp_admin_correct_live_lunch(%L,%s,null,null,null,0,%L,%L,%L)',
  :'employee', :start_ms, :'lunch_out', :'lunch_back', 'short'
), 'audit reason');
select public.test_expect_error(format(
  'select public.gp_admin_correct_live_lunch(%L,%s,null,null,null,0,%L,%L,%L)',
  :'employee', :start_ms, :'lunch_back', :'lunch_out', 'Verified example of reversed punches'
), 'after Lunch Out');
select public.test_expect_error(format(
  'select public.gp_admin_correct_live_lunch(%L,%s,null,null,null,0,%L,clock_timestamp()+interval ''1 hour'',%L)',
  :'employee', :start_ms, :'lunch_out', 'Verified future timestamps are rejected'
), 'future');
select public.test_expect_error(format(
  'select public.gp_admin_correct_live_lunch(%L,%s,null,null,null,0,%L,%L,%L)',
  :'employee', :start_ms, to_timestamp(:start_ms / 1000.0) - interval '1 minute', :'lunch_back', 'Verified break cannot precede clock-in'
), 'within the active shift');

create trigger test_fail_audit before insert on public.audit_logs for each row execute function public.test_fail_audit();
select public.test_expect_error(format(
  'select public.gp_admin_correct_live_lunch(%L,%s,null,null,null,0,%L,%L,%L)',
  :'employee', :start_ms, :'lunch_out', :'lunch_back', 'Verified break must have an audit record'
), 'simulated audit failure');
select public.test_assert((select lunch_out_at is null and lunch_in_at is null and break_minutes = 0
  from public.active_time_sessions where auth_user_id = :'employee'), 'audit failure rolls back the lunch change');
drop trigger test_fail_audit on public.audit_logs;

set local role authenticated;
select public.gp_admin_correct_live_lunch(:'employee', :start_ms, null, null, null, 0,
  :'lunch_out', null, 'Confirmed missing Lunch Out with the employee');
reset role;
select public.test_assert((select lunch_out_at = :'lunch_out' and lunch_in_at is null and break_minutes = 0
  from public.active_time_sessions where auth_user_id = :'employee'), 'administrator can record an ongoing lunch');

select set_config('request.jwt.claim.sub', :'employee', false);
select public.gp_end_lunch();
select set_config('request.jwt.claim.sub', :'admin', false);
select public.test_expect_error(format(
  'select public.gp_admin_correct_live_lunch(%L,%s,null,%L,null,0,%L,%L,%L)',
  :'employee', :start_ms, :'lunch_out', :'lunch_out', :'lunch_back', 'A new employee punch cannot be overwritten'
), 'changed while you were editing');
select lunch_in_at as recorded_back, break_minutes as recorded_break
  from public.active_time_sessions where auth_user_id = :'employee' \gset
select public.gp_admin_correct_live_lunch(:'employee', :start_ms, null, :'lunch_out', :'recorded_back', :recorded_break,
  null, null, 'Confirmed those recorded break punches were incorrect');
select public.test_assert((select lunch_out_at is null and lunch_in_at is null and break_minutes = 0
  from public.active_time_sessions where auth_user_id = :'employee'), 'administrator can clear mistaken punches');

select public.gp_admin_correct_live_lunch(:'employee', :start_ms, null, null, null, 0,
  :'lunch_out', :'lunch_back', 'Verified the actual lunch interval with the supervisor');
select public.test_assert((select started_at_ms = :start_ms and approved_clock_in_at is null and break_minutes = 42
  from public.active_time_sessions where auth_user_id = :'employee'), 'exact lunch totals preserve the live clock-in');
select public.test_assert((public.gp_admin_correct_live_lunch(:'employee', :start_ms, null, :'lunch_out', :'lunch_back', 42,
  :'lunch_out', :'lunch_back', 'Retry after looking at the updated break')->>'unchanged')::boolean,
  'repeating the current values leaves only the original audit record');
select public.test_assert((select count(*) = 3 from public.audit_logs
  where actor_user_id = :'admin' and action_type = 'TIME_LUNCH_ADMIN_CORRECT'
  and (details::jsonb->>'session_started_at_ms')::bigint = :start_ms), 'one administrator audit per actual correction');
select public.test_assert((select exists (select 1 from public.audit_logs
  where action_type = 'TIME_LUNCH_ADMIN_CORRECT' and details::jsonb->>'reason' = 'Confirmed those recorded break punches were incorrect'
  and (details::jsonb->'previous'->>'lunch_in_at')::timestamptz = :'recorded_back'
  and details::jsonb->'corrected'->>'lunch_in_at' is null)), 'clearing a break preserves previous punches in the audit');
select public.gp_finish_active_shift(:start_ms, :'employee',
  to_timestamp(:start_ms / 1000.0) + interval '3 hours', 'Verified end after correcting the live lunch');
select public.test_assert((select lunch_out_at = :'lunch_out' and lunch_in_at = :'lunch_back'
  and break_minutes = 42 and decimal_hours::numeric = 2.30
  from public.time_logs where session_started_at_ms = :start_ms), 'clock-out uses corrected punches and calculates paid time');
rollback;
