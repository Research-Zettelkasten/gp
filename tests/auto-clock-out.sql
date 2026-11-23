\set ON_ERROR_STOP on
-- Run after the existing clock-out SQL/race/text-storage tests, never production.
do $$begin if current_database()<>'gp_clock_test' then raise exception 'Use disposable gp_clock_test';end if;end$$;
select set_config('request.jwt.claim.sub','',false);
\ir ../supabase/migrations/2026-11-23-weekly-time-and-auto-clock-out.sql
\ir ../supabase/migrations/2026-11-23-weekly-time-and-auto-clock-out.sql
delete from public.active_time_sessions;
create or replace function public.test_clock_at(p_start timestamptz,p_user uuid default '22222222-2222-4222-8222-222222222222') returns bigint language plpgsql as $$declare ms bigint:=floor(extract(epoch from p_start)*1000);begin
 insert into public.active_time_sessions(auth_user_id,employee_pin,employee_name,department,started_at,started_at_ms,clock_in_location) select p_user,p_user::text,employee_name,department,p_start,ms,'Synthetic shop' from public.app_users where auth_user_id=p_user;return ms;end$$;
select public.test_assert((select due_at='2026-11-20 00:01-05'::timestamptz and ended_at='2026-11-19 17:00-05'::timestamptz and not emergency from private.gp_shift_policy('2026-11-19 07:51-05')),'12:01 check and previous-day 17:00 default');
select public.test_assert((select not emergency from private.gp_shift_policy('2026-11-19 18:00-05')),'exactly 18:00 is regular');
select public.test_assert((select due_at='2026-11-20 07:30-05'::timestamptz and emergency from private.gp_shift_policy('2026-11-19 18:00:01-05')),'after 18:00 emergency exception');
select public.test_assert(not has_function_privilege('authenticated','public.gp_auto_clock_out_due()','execute') and not has_function_privilege('anon','public.gp_auto_clock_out_due()','execute'),'browser roles cannot invoke scheduler');
select public.test_clock_at('2026-11-18 07:51-05') as regular_start \gset
update public.active_time_sessions set lunch_out_at='2026-11-18 12:00-05',lunch_in_at='2026-11-18 13:01-05';
select public.test_assert(public.gp_auto_clock_out_due()=1,'overdue regular shift closes');
select public.test_assert((select clock_out='17:00' and decimal_hours::numeric=8.13 and break_minutes=61 and auto_clocked_out and clock_out_review_status='pending' and session_ended_at='2026-11-18 17:00-05'::timestamptz and clocked_out_by is null from public.time_logs where session_started_at_ms=:regular_start),'default 17:00 and exact lunch, system attribution and review flag');
select public.test_assert((select status='pending' and session_snapshot->>'lunch_in_at' is not null from public.gp_shift_close_reviews where session_started_at_ms=:regular_start),'original punches retained in durable queue');
select public.test_assert(public.gp_auto_clock_out_due()=0,'scheduler retry is idempotent');
select id as regular_review from public.gp_shift_close_reviews where session_started_at_ms=:regular_start \gset
select set_config('request.jwt.claim.sub','33333333-3333-4333-8333-333333333333',false);
select public.test_expect_error('select public.gp_review_auto_clock_out('||:regular_review||',''Verified actual punches with employee'')','administrator');
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',false);
select public.gp_review_auto_clock_out(:regular_review,'Verified actual end time and lunch punches with employee');
select public.test_assert((select clock_out_review_status='approved' from public.time_logs where session_started_at_ms=:regular_start),'review is explicitly approved');
select set_config('request.jwt.claim.sub','',false);
select public.test_clock_at('2026-11-11 08:00-05') as correction_start \gset
select public.gp_auto_clock_out_due();
select id as correction_review from public.gp_shift_close_reviews where session_started_at_ms=:correction_start \gset
update public.time_logs set clock_out='16:00',decimal_hours=8 where session_started_at_ms=:correction_start;
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',false);
select public.gp_review_auto_clock_out(:correction_review,'Corrected actual end time to 4 PM after employee verification');
select public.test_assert((select clock_out='16:00' and session_ended_at='2026-11-11 16:00-05'::timestamptz and decimal_hours::numeric=8 from public.time_logs where session_started_at_ms=:correction_start),'review updates completion metadata to match corrected actual punches');
-- Reproduce the legacy save-success/delete-failure collision without adding payroll.
select set_config('request.jwt.claim.sub','',false);
select public.test_clock_at('2026-11-19 07:51-05') as stale_start \gset
insert into public.time_logs(auth_user_id,employee_name,work_date,clock_in,clock_out,break_minutes,decimal_hours,notes,lunch_review_status) values('22222222-2222-4222-8222-222222222222','Test Employee','2026-11-19','07:51 AM','05:00 PM',61,8.13,'Preserve original payroll and manager decision','approved') returning id as legacy_card \gset
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',false);
select public.test_assert(jsonb_array_length(public.gp_saved_timecards_for_session('22222222-2222-4222-8222-222222222222',:stale_start))=1,'existing saved card is discoverable');
select public.gp_clear_saved_active_shift('22222222-2222-4222-8222-222222222222',:stale_start,:legacy_card,'Verified existing payroll record; clearing leftover active clock');
select public.test_assert((select count(*)=1 and min(decimal_hours::numeric)=8.13 from public.time_logs where work_date='2026-11-19'),'stale recovery adds no duplicate payroll');
select public.test_assert((select notes='Preserve original payroll and manager decision' and lunch_review_status='approved' and session_ended_at='2026-11-19 17:00-05'::timestamptz from public.time_logs where id=:legacy_card),'saved hours, notes and approval remain intact');
select public.test_assert((public.gp_clear_saved_active_shift('22222222-2222-4222-8222-222222222222',:stale_start,:legacy_card,'Retry clearing a previously confirmed saved shift')->>'already_closed')::boolean,'stale recovery retry is idempotent');
-- Scheduler also adopts one existing completed timecard without overwriting it.
select set_config('request.jwt.claim.sub','',false);
select public.test_clock_at('2026-11-17 08:00-05') as existing_start \gset
insert into public.time_logs(auth_user_id,employee_name,work_date,clock_in,clock_out,decimal_hours,notes) values('22222222-2222-4222-8222-222222222222','Test Employee','2026-11-17','08:00','16:00',8,'Existing actual end is 16:00');
select public.gp_auto_clock_out_due();
select public.test_assert((select count(*)=1 and min(clock_out)='16:00' and min(decimal_hours::numeric)=8 from public.time_logs where work_date='2026-11-17'),'automatic stale cleanup preserves existing actual end');
-- Ambiguous timecards: remove stale active clock, retain full evidence, add no payroll.
select public.test_clock_at('2026-11-16 08:00-05') as ambiguous_start \gset
insert into public.time_logs(auth_user_id,employee_name,work_date,clock_in,clock_out,decimal_hours) values('22222222-2222-4222-8222-222222222222','Test Employee','2026-11-16','08:00','16:00',8),('22222222-2222-4222-8222-222222222222','Test Employee','2026-11-16','08:00','17:00',9);
select public.gp_auto_clock_out_due();
select public.test_assert((select time_log_id is null and jsonb_array_length(candidate_time_log_ids)=2 and status='pending' from public.gp_shift_close_reviews where session_started_at_ms=:ambiguous_start),'ambiguous saved cards remain pending with original references');
select public.test_assert((select count(*)=2 from public.time_logs where work_date='2026-11-16'),'ambiguity creates no third payroll record');
select public.test_assert((select count(*)=0 from public.active_time_sessions),'ambiguous stale clock is closed');
-- Late afternoon starts cannot produce negative hours from the 17:00 default.
select public.test_clock_at('2026-11-15 17:30-05') as late_start \gset
select public.gp_auto_clock_out_due();
select public.test_assert((select time_log_id is null and reason like '%at or before clock-in%' from public.gp_shift_close_reviews where session_started_at_ms=:late_start),'impossible default requires actual time review');
select public.test_assert((select count(*)=0 from public.time_logs where session_started_at_ms=:late_start),'no negative payroll shift invented');
-- Emergency overnight + daylight saving fall-back uses real elapsed time.
select public.test_clock_at('2026-10-31 19:00-04') as emergency_start \gset
select public.gp_auto_clock_out_due();
select public.test_assert((select work_date='2026-10-31' and clock_out='07:30' and decimal_hours::numeric=13.50 and clock_out_review_status='pending' and lunch_review_status='pending' from public.time_logs where session_started_at_ms=:emergency_start),'emergency exception and DST elapsed hours preserved');
-- Open lunch closes at default end, with the exact original snapshot retained.
select public.test_clock_at('2026-11-14 08:00-05') as open_lunch_start \gset
update public.active_time_sessions set lunch_out_at='2026-11-14 16:00-05';
select public.gp_auto_clock_out_due();
select public.test_assert((select break_minutes=60 and decimal_hours::numeric=8 and lunch_in_at=session_ended_at from public.time_logs where session_started_at_ms=:open_lunch_start),'open lunch remains unpaid to default end');
-- A later lunch cannot be silently truncated to force the default to fit.
select public.test_clock_at('2026-11-13 08:00-05') as bad_lunch_start \gset
update public.active_time_sessions set lunch_out_at='2026-11-13 18:00-05';
select public.gp_auto_clock_out_due();
select public.test_assert((select time_log_id is null and reason like '%Lunch punches extend beyond%' from public.gp_shift_close_reviews where session_started_at_ms=:bad_lunch_start),'inconsistent lunch is held for review');
-- An audit failure preserves all-or-nothing behavior.
select public.test_clock_at('2026-11-12 08:00-05') as rollback_auto_start \gset
create trigger test_fail_audit before insert on public.audit_logs for each row execute function public.test_fail_audit();
select public.test_expect_error('select public.gp_auto_clock_out_due()','simulated audit failure');
select public.test_assert((select count(*)=1 from public.active_time_sessions where started_at_ms=:rollback_auto_start),'failed audit preserves active session');
select public.test_assert((select count(*)=0 from public.time_logs where session_started_at_ms=:rollback_auto_start),'failed audit rolls back default timecard');
drop trigger test_fail_audit on public.audit_logs;
select public.gp_auto_clock_out_due();
-- Future deadlines never close a not-yet-due shift.
select public.test_clock_at(clock_timestamp()) as future_start \gset
select public.test_assert(public.gp_auto_clock_out_due()=0,'not-yet-due sessions stay active');
delete from public.active_time_sessions where started_at_ms=:future_start;
-- Browser-visible review evidence retains account boundaries through actual RLS.
grant usage on schema auth,private to authenticated;
select set_config('request.jwt.claim.sub','33333333-3333-4333-8333-333333333333',false);
set role authenticated;
select public.test_assert((select count(*)=0 from public.gp_shift_close_reviews),'another employee cannot read review snapshots');
reset role;
select set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',false);
set role authenticated;
select public.test_assert((select count(*)>0 from public.gp_shift_close_reviews),'employee can see own automatic closure evidence');
reset role;
select set_config('request.jwt.claim.sub','',false);
-- Legacy text-hours installations use the identical automatic path.
drop trigger gp_time_exact_lunch on public.time_logs;
alter table public.time_logs alter column decimal_hours type text using decimal_hours::text;
create trigger gp_time_exact_lunch before insert or update of clock_in,clock_out,lunch_out_time,lunch_in_time,break_minutes,decimal_hours on public.time_logs for each row execute function public.gp_apply_exact_lunch();
\ir ../supabase/migrations/2026-11-23-weekly-time-and-auto-clock-out.sql
select public.test_clock_at('2026-11-10 08:00-05') as text_auto_start \gset
update public.active_time_sessions set lunch_out_at='2026-11-10 12:00-05',lunch_in_at='2026-11-10 13:00-05';
select public.gp_auto_clock_out_due();
select public.test_assert((select decimal_hours::numeric=8 and break_minutes=60 and auto_clocked_out from public.time_logs where session_started_at_ms=:text_auto_start),'automatic clock-out supports legacy text hours with exact lunch');
\echo 'PASS: missed clock-out policy, review queue, legacy recovery, duplicate protection, DST, lunches and atomic audit rollback.'
