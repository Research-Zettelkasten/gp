\set ON_ERROR_STOP on
do $$begin if current_database() <> 'gp_operations_test' then raise exception 'Use disposable gp_operations_test'; end if; end$$;
alter table public.app_users add column perm_time boolean not null default true;
create or replace function private.gp_has_permission(needed text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.app_users where auth_user_id = auth.uid()
    and active is true and (perm_admin is true or (needed = 'time' and perm_time is true)));
$$;
create table public.active_time_sessions (auth_user_id uuid primary key, started_at_ms bigint not null);
alter table public.audit_logs add column actor_user_id uuid, add column "timestamp" timestamptz;
\ir ../supabase/migrations/2026-11-23-live-location-requests.sql
\ir ../supabase/migrations/2026-11-23-live-location-requests.sql

create function pg_temp.assert_location(ok boolean, message text) returns void language plpgsql as $$
begin if not coalesce(ok,false) then raise exception 'ASSERTION FAILED: %', message; end if; end$$;
create function pg_temp.location_error(statement text, expected text) returns void language plpgsql as $$
begin
  begin execute statement; exception when others then
    if position(expected in sqlerrm) > 0 then return; else raise; end if;
  end;
  raise exception 'Expected error containing %',expected;
end$$;

\set manager '11111111-1111-4111-8111-111111111111'
\set employee '22222222-2222-4222-8222-222222222222'
\set other '33333333-3333-4333-8333-333333333333'
insert into public.active_time_sessions values (:'employee', 7001);
insert into public.gp_push_devices (user_id,endpoint,p256dh,auth_key) values
  (:'employee','https://web.push.apple.com/location-test',repeat('A',87),repeat('B',22)),
  (:'other','https://web.push.apple.com/other-location-test',repeat('C',87),repeat('D',22));

select set_config('request.jwt.claim.sub', :'employee', false);
set role authenticated;
select pg_temp.location_error(format('select public.gp_request_live_location(%L,7001)', :'employee'), 'administrator');
reset role;

select set_config('request.jwt.claim.sub', :'manager', false);
set role authenticated;
select pg_temp.location_error(format('select public.gp_request_live_location(%L,7000)', :'employee'), 'shift changed or ended');
select public.gp_request_live_location(:'employee',7001)->>'id' as request_id \gset
select pg_temp.assert_location((public.gp_request_live_location(:'employee',7001)->>'created')::boolean is false,
  'an outstanding request is reused');
select pg_temp.location_error(format('select public.gp_claim_live_location_push(%L,%L)', :'request_id', :'manager'), 'permission denied');
reset role;

set role service_role;
select pg_temp.assert_location((select count(*) = 1 and bool_and(endpoint='https://web.push.apple.com/location-test')
  from public.gp_claim_live_location_push(:'request_id', :'manager')), 'alerts only go to the selected employee');
select pg_temp.assert_location((select count(*) = 0 from public.gp_claim_live_location_push(:'request_id', :'manager')),
  'same request can only notify once');
reset role;

select set_config('request.jwt.claim.sub', :'other', false);
set role authenticated;
select pg_temp.assert_location((select count(*) = 0 from public.gp_live_location_requests), 'employees can only read their requests');
select pg_temp.location_error(format('select public.gp_respond_live_location(%L,true,30,-83,14)', :'request_id'), 'unavailable');
reset role;

select set_config('request.jwt.claim.sub', :'employee', false);
set role authenticated;
select pg_temp.assert_location((select count(*) = 1 from public.gp_live_location_requests where status = 'pending' and latitude is null),
  'employee sees a request before any point is shared');
select pg_temp.location_error(format('select public.gp_respond_live_location(%L,true,500,-83,2)', :'request_id'), 'valid accuracy');
select public.gp_respond_live_location(:'request_id', false, 30,-83,14);
select pg_temp.assert_location((select count(*) = 1 from public.gp_live_location_requests
  where status = 'declined' and latitude is null and longitude is null and accuracy_m is null), 'declines discard coordinates');
select pg_temp.location_error(format('select public.gp_respond_live_location(%L,true,30,-83,14)', :'request_id'), 'already has a response');
reset role;

select set_config('request.jwt.claim.sub', :'manager', false);
select pg_temp.location_error(format('select public.gp_request_live_location(%L,7001)', :'employee'), 'Wait two minutes');
update public.gp_live_location_requests set requested_at = now() - interval '3 minutes';
select public.gp_request_live_location(:'employee',7001)->>'id' as fresh_id \gset
select set_config('request.jwt.claim.sub', :'employee', false);
select public.gp_respond_live_location(:'fresh_id', true, 30.83344,-83.28877,14);
select set_config('request.jwt.claim.sub', :'manager', false);
set role authenticated;
select pg_temp.assert_location((select count(*)=1 from public.gp_live_location_requests where id=:'fresh_id'
    and status='shared' and accuracy_m=14 and latitude=30.83344), 'manager sees consented location and accuracy');
reset role;
select pg_temp.assert_location((select count(*)=4 and bool_and(details not like '%30.83344%') from public.audit_logs
    where action_type in ('TIME_LIVE_LOCATION_REQUEST', 'TIME_LIVE_LOCATION_RESPONSE')),
  'request and response audit trail excludes precise coordinates');

delete from public.active_time_sessions where auth_user_id = :'employee';
select pg_temp.assert_location((select count(*) = 0 from public.gp_live_location_requests), 'closing the shift removes the live location');
select pg_temp.location_error(format('select public.gp_request_live_location(%L,7001)', :'employee'), 'shift changed or ended');
