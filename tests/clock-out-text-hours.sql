\set ON_ERROR_STOP on
-- Run after clock-out.sql and clock-race.cjs in disposable gp_clock_test only.
do $$ begin
  if current_database()<>'gp_clock_test' then raise exception 'Use a disposable gp_clock_test database.'; end if;
end $$;

select set_config('request.jwt.claim.sub','',false);
alter table public.time_logs alter column decimal_hours type text using decimal_hours::text;
select public.test_seed_shift('22222222-2222-4222-8222-222222222222',2) as short_start \gset
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',false);

-- Reproduce the exact production error before applying the compatibility repair.
select public.test_expect_error(
  'select public.gp_finish_active_shift('||:short_start||',''22222222-2222-4222-8222-222222222222'',to_timestamp('||:short_start||'/1000.0)+interval ''1 minute'',''Correcting an employee clock-out time'')',
  'operator does not exist: text = numeric');
select public.test_assert((select count(*)=0 from public.time_logs where session_started_at_ms=:short_start),'failed comparison rolls back the timecard');
select public.test_assert((select count(*)=1 from public.active_time_sessions where started_at_ms=:short_start),'failed comparison preserves the active punch');

\ir ../supabase/migrations/2026-11-17-clock-out-text-hours-fix.sql
-- Reapplying the same repair is safe.
\ir ../supabase/migrations/2026-11-17-clock-out-text-hours-fix.sql

select public.gp_finish_active_shift(:short_start,'22222222-2222-4222-8222-222222222222',
  to_timestamp(:short_start/1000.0)+interval '1 minute','Correcting an employee clock-out time') as short_result \gset
select public.test_assert((select decimal_hours::numeric=0.02 from public.time_logs where session_started_at_ms=:short_start),'one-minute admin shift saves as 0.02 hours with text storage');
select public.test_assert(jsonb_typeof(:'short_result'::jsonb->'decimal_hours')='number','text-storage response exposes numeric hours');
select public.test_assert((select count(*)=0 from public.active_time_sessions where started_at_ms=:short_start),'successful repair removes only the completed active punch');
select public.test_assert((public.gp_finish_active_shift(:short_start,'22222222-2222-4222-8222-222222222222',null,'Retry after a network timeout')->>'already_closed')::boolean,'text-storage retry stays idempotent');
select public.test_assert((select count(*)=1 from public.time_logs where session_started_at_ms=:short_start),'text-storage retry creates no duplicate');

-- The employee endpoint uses the same repaired operation.
select set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',false);
select public.test_seed_shift('22222222-2222-4222-8222-222222222222',1) as own_text_start \gset
select public.gp_finish_active_shift(:own_text_start,null,null,'','Customer workload prevented lunch');
select public.test_assert((select decimal_hours::numeric>=1 and decimal_hours::numeric<1.1 and lunch_review_status='pending'
  from public.time_logs where session_started_at_ms=:own_text_start),'employee clock-out works with text hours');

-- Existing exact-lunch triggers also assign to the legacy text column.
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',false);
select public.test_seed_shift('22222222-2222-4222-8222-222222222222',9) as lunch_text_start \gset
update public.active_time_sessions set lunch_out_at=started_at+interval '3 hours',lunch_in_at=started_at+interval '3 hours 30 minutes';
select public.gp_finish_active_shift(:lunch_text_start,'22222222-2222-4222-8222-222222222222',
  to_timestamp(:lunch_text_start/1000.0)+interval '7 hours','Employee left after the recorded lunch');
select public.test_assert((select decimal_hours::numeric=6.50 and break_minutes=30
  from public.time_logs where session_started_at_ms=:lunch_text_start),'lunch deduction works with text hours');

-- A later audit failure must still roll back the whole operation after the fix.
select public.test_seed_shift('22222222-2222-4222-8222-222222222222',11) as text_rollback_start \gset
create trigger test_fail_audit before insert on public.audit_logs for each row execute function public.test_fail_audit();
select public.test_expect_error(
  'select public.gp_finish_active_shift('||:text_rollback_start||',''22222222-2222-4222-8222-222222222222'',null,''Employee forgot to clock out'')',
  'simulated audit failure');
select public.test_assert((select count(*)=0 from public.time_logs where session_started_at_ms=:text_rollback_start),'audit failure still rolls back text payroll row');
select public.test_assert((select count(*)=1 from public.active_time_sessions where started_at_ms=:text_rollback_start),'audit failure still preserves text-schema active punch');
drop trigger test_fail_audit on public.audit_logs;
select public.gp_finish_active_shift(:text_rollback_start,'22222222-2222-4222-8222-222222222222',null,'Employee forgot to clock out');

-- The same replacement remains compatible with a standard numeric column.
select set_config('request.jwt.claim.sub','',false);
alter table public.time_logs alter column decimal_hours type numeric(10,2) using decimal_hours::numeric;
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',false);
select public.test_seed_shift('22222222-2222-4222-8222-222222222222',10) as numeric_start \gset
select public.gp_finish_active_shift(:numeric_start,'22222222-2222-4222-8222-222222222222',
  to_timestamp(:numeric_start/1000.0)+interval '1 minute','Checking standard numeric storage') as numeric_result \gset
select public.test_assert((select decimal_hours=0.02 from public.time_logs where session_started_at_ms=:numeric_start),'numeric schema remains compatible');
select public.test_assert(jsonb_typeof(:'numeric_result'::jsonb->'decimal_hours')='number','numeric schema response remains numeric');
select public.test_assert(not has_function_privilege('anon','public.gp_finish_active_shift(bigint,uuid,timestamptz,text,text,boolean,text,text)','EXECUTE'),'repair retains anonymous access denial');
select public.test_assert((select bool_and(relrowsecurity) from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and c.relname in ('app_users','time_logs','active_time_sessions','audit_logs')),'repair retains RLS');

\echo 'Exact text=numeric regression reproduced and repaired; text and numeric schemas passed.'
