\set ON_ERROR_STOP on
do $$ begin if current_database() <> 'gp_clock_test' then raise exception 'Use disposable gp_clock_test'; end if; end $$;
\ir ../supabase/migrations/2026-11-23-employee-lunch-requests.sql
\ir ../supabase/migrations/2026-11-23-employee-lunch-requests.sql

begin;
\set employee '22222222-2222-4222-8222-222222222222'
\set other '33333333-3333-4333-8333-333333333333'
\set manager '11111111-1111-4111-8111-111111111111'
select set_config('request.jwt.claim.sub', '', false);
delete from public.active_time_sessions;
select public.test_clock_at(date_trunc('minute', clock_timestamp() - interval '6 hours') + interval '48 seconds') as start_ms \gset
select to_timestamp(:start_ms / 1000.0) + interval '1 hour' as lunch_out,
       to_timestamp(:start_ms / 1000.0) + interval '90 minutes' as lunch_back,
       to_timestamp(:start_ms / 1000.0) + interval '4 hours' as shift_end \gset
select public.test_assert(not has_function_privilege('anon',
  'public.gp_request_lunch_change(bigint,bigint,timestamptz,timestamptz,text)', 'execute'), 'anonymous requests are denied');

select set_config('request.jwt.claim.sub', :'employee', false);
set local role authenticated;
select public.gp_request_lunch_change(:start_ms,null,:'lunch_out',:'lunch_back','I forgot to record my lunch at the job site.') as req \gset
select public.test_expect_error(format('select public.gp_request_lunch_change(%s,null,%L,%L,%L)',
  :start_ms, :'lunch_out', :'lunch_back', 'A duplicate request for this same live shift'), 'already waiting');
select public.test_expect_error(format('select public.gp_review_lunch_change(%s,true,%L)', :req,
  'Employees cannot approve their own requests.'), 'administrator');
reset role;
select public.test_assert((select lunch_out_at is null and lunch_in_at is null
  from public.active_time_sessions where auth_user_id = :'employee'), 'submitting does not change punches');

select set_config('request.jwt.claim.sub', :'other', false);
set local role authenticated;
select public.test_assert((select count(*) = 0 from public.gp_lunch_requests where id = :req), 'other employees cannot see the request');
reset role;

select set_config('request.jwt.claim.sub', :'manager', false);
select public.gp_finish_active_shift(:start_ms,:'employee',:'shift_end','Supervisor confirmed actual shift end.');
select id::text as card from public.time_logs where session_started_at_ms = :start_ms \gset
select public.gp_review_lunch_change(:req,true,'Confirmed lunch with the on-site supervisor.');
select public.test_assert((select lunch_out_at = :'lunch_out' and lunch_in_at = :'lunch_back'
    and decimal_hours::numeric = 3.50 and break_minutes = 30
    and session_started_at_ms = :start_ms and lunch_review_status = 'not_required'
  from public.time_logs where id = :card), 'live request applies to the saved timecard after clock-out');

select set_config('request.jwt.claim.sub', :'employee', false);
select public.test_expect_error(format('select public.gp_request_lunch_change(null,%s,%L,%L,%L)',
  :card, :'lunch_back', :'lunch_out', 'Lunch Back may not precede Lunch Out'), 'within the shift');
select public.gp_request_lunch_change(null,:card,:'lunch_out',:'lunch_back'::timestamptz + interval '10 minutes',
  'The return punch should be ten minutes later.') as card_req \gset
select set_config('request.jwt.claim.sub', :'manager', false);
update public.time_logs set break_minutes = 40,
  lunch_in_at = lunch_in_at + interval '10 minutes',
  lunch_in_time = to_char((lunch_in_at + interval '10 minutes') at time zone 'America/New_York','HH24:MI')
  where id = :card;
select public.test_expect_error(format('select public.gp_review_lunch_change(%s,true,%L)', :card_req,
  'This request is stale after another manager changes the timecard.'), 'punches changed');
select public.gp_review_lunch_change(:card_req,false,'The manager already corrected the recorded return time.');
select public.test_assert((select status = 'rejected' and reviewed_by = :'manager' from public.gp_lunch_requests where id = :card_req),
  'rejection is persisted with the reviewer');

select set_config('request.jwt.claim.sub', '', false);
select public.test_clock_at(date_trunc('minute', clock_timestamp() - interval '5 hours') + interval '46 seconds') as live_ms \gset
select set_config('request.jwt.claim.sub', :'employee', false);
select public.gp_request_lunch_change(:live_ms,null,to_timestamp(:live_ms / 1000.0) + interval '1 hour',
  to_timestamp(:live_ms / 1000.0) + interval '80 minutes','I forgot both punches while taking my break.') as live_req \gset
select set_config('request.jwt.claim.sub', :'manager', false);
select public.gp_review_lunch_change(:live_req,true,'Confirmed actual lunch with the shift supervisor.');
select public.test_assert((select break_minutes = 20 and lunch_in_at is not null from public.active_time_sessions
  where auth_user_id = :'employee' and started_at_ms = :live_ms), 'approval updates a live shift through the administrator correction');
select public.test_assert((select count(*) = 3 from public.audit_logs where action_type = 'TIME_LUNCH_REQUEST_REVIEW'
  and (details::jsonb->>'request_id')::bigint in (:req,:card_req,:live_req)), 'each decision produces an audit record');
rollback;
