\set ON_ERROR_STOP on
do $$ begin if current_database() <> 'gp_clock_test' then raise exception 'Use disposable gp_clock_test'; end if; end $$;
\ir ../supabase/migrations/2026-11-24-resolve-missed-clock-outs.sql
\ir ../supabase/migrations/2026-11-24-resolve-missed-clock-outs.sql
begin;
\set employee '22222222-2222-4222-8222-222222222222'
\set manager '11111111-1111-4111-8111-111111111111'
select set_config('request.jwt.claim.sub','',false);
delete from public.active_time_sessions;
select public.test_clock_at('2026-11-07T08:07:35-05:00') as start_ms \gset
update public.active_time_sessions set lunch_out_at = '2026-11-07T17:19:46-05:00' where auth_user_id = :'employee';
select public.test_assert(private.gp_auto_finish_shift(:'employee',:start_ms),'automatic rule preserves late lunch evidence');
select id as review_id from public.gp_shift_close_reviews where session_started_at_ms = :start_ms \gset
select public.test_assert((select status = 'pending' and time_log_id is null from public.gp_shift_close_reviews
  where id=:review_id),'a conflicting late lunch cannot create a default timecard');

select set_config('request.jwt.claim.sub',:'employee',false);
set local role authenticated;
select public.test_expect_error(format('select public.gp_missed_clock_out_candidates(%s)',:review_id),'administrator');
select public.test_expect_error(format('select public.gp_resolve_missed_clock_out(%s,%L,null,null,true,%L)',
  :review_id,'2026-11-07T17:22:00-05:00','Employee cannot approve this review'), 'administrator');
reset role;

select set_config('request.jwt.claim.sub',:'manager',false);
set local role authenticated;
select public.test_assert((select count(*) = 0 from public.gp_missed_clock_out_candidates(:review_id)),
  'manager sees that no timecard matches');
select public.test_expect_error(format('select public.gp_resolve_missed_clock_out(%s,%L,%L,null,false,%L)',:review_id,
  '2026-11-07T17:22:00-05:00','2026-11-07T17:19:46-05:00','Require verified return before approving'), 'both actual lunch times');
reset role;
create trigger test_fail_audit before insert on public.audit_logs for each row execute function public.test_fail_audit();
select public.test_expect_error(format('select public.gp_resolve_missed_clock_out(%s,%L,%L,%L,false,%L)',:review_id,
  '2026-11-07T17:22:00-05:00','2026-11-07T17:19:46-05:00','2026-11-07T17:21:00-05:00',
  'Verified clock-out and both exact lunch times'), 'simulated audit failure');
select public.test_assert((select time_log_id is null and status='pending' from public.gp_shift_close_reviews where id = :review_id),
  'audit failure does not approve review');
select public.test_assert((select count(*)=0 from public.time_logs where session_started_at_ms = :start_ms),
  'audit failure does not create payroll');
drop trigger test_fail_audit on public.audit_logs;
set local role authenticated;
select public.gp_resolve_missed_clock_out(:review_id,'2026-11-07T17:22:00-05:00',
  '2026-11-07T17:19:46-05:00','2026-11-07T17:21:00-05:00',false,'Verified actual clock-out and lunch punches') as saved_card \gset
reset role;
select public.test_assert((select clock_out = '17:22' and break_minutes = 2 and decimal_hours::numeric = 9.22
  and clock_out_review_status = 'approved' and lunch_review_status = 'not_required'
  from public.time_logs where id = :saved_card),'actual punches and paid hours are saved');
select public.test_assert((select status='approved' and time_log_id=:saved_card and reviewed_by=:'manager'
  and session_snapshot->>'lunch_in_at' is null from public.gp_shift_close_reviews where id=:review_id),
  'review retains the original missing lunch back and links the new timecard');
select public.test_assert(public.gp_resolve_missed_clock_out(:review_id,'2026-11-07T17:22:00-05:00',
  null,null,true,'Retry should return the existing timecard') = :saved_card,'retry returns the existing card');

select set_config('request.jwt.claim.sub','',false);
select public.test_clock_at('2026-11-06T08:00:30-05:00') as other_start \gset
update public.active_time_sessions set lunch_out_at = '2026-11-06T17:10:00-05:00' where auth_user_id = :'employee';
select private.gp_auto_finish_shift(:'employee',:other_start);
select id as other_review from public.gp_shift_close_reviews where session_started_at_ms = :other_start \gset
insert into public.time_logs(auth_user_id,employee_name,work_date,clock_in,clock_out,break_minutes,decimal_hours)
  values (:'employee','Test Employee','2026-11-06','08:00','17:22',0,9.37) returning id as existing_card \gset
select set_config('request.jwt.claim.sub',:'manager',false);
select public.test_assert((select count(*)=1 and min(id)=:existing_card from public.gp_missed_clock_out_candidates(:other_review)),
  'the existing card is available as a choice');
select public.test_expect_error(format('select public.gp_resolve_missed_clock_out(%s,%L,null,null,true,%L)',
  :other_review,'2026-11-06T17:22:00-05:00','Do not create a duplicate timecard'), 'matching timecard is already saved');
select public.gp_review_auto_clock_out(:other_review,'Verified the existing matching saved timecard.',:existing_card);
select public.test_assert((select count(*)=1 from public.time_logs where work_date='2026-11-06' and auth_user_id=:'employee'),
  'linking preserves only the existing timecard');

select set_config('request.jwt.claim.sub','',false);
select public.test_clock_at('2026-11-05T08:00:30-05:00') as no_lunch_start \gset
update public.active_time_sessions set lunch_out_at = '2026-11-05T17:10:00-05:00' where auth_user_id = :'employee';
select private.gp_auto_finish_shift(:'employee',:no_lunch_start);
select id as no_lunch_review from public.gp_shift_close_reviews where session_started_at_ms = :no_lunch_start \gset
select set_config('request.jwt.claim.sub',:'manager',false);
select public.gp_resolve_missed_clock_out(:no_lunch_review,'2026-11-05T17:22:00-05:00',
  null,null,true,'Verified the recorded lunch punch was accidental.') as no_lunch_card \gset
select public.test_assert((select lunch_out_at is null and lunch_in_at is null and break_minutes = 0
  and lunch_review_status = 'approved' and lunch_reviewed_by=:'manager' and decimal_hours::numeric = 9.37
  from public.time_logs where id=:no_lunch_card),'explicit no-lunch approval keeps verified time and reviewer');
rollback;
