-- Run after the announcement Web Push migration.
begin;

create table if not exists public.gp_live_location_requests (
  employee_id uuid primary key references auth.users(id) on delete cascade,
  id uuid not null unique default gen_random_uuid(),
  session_started_at_ms bigint not null,
  requested_by uuid references auth.users(id) on delete set null,
  requester_name text not null,
  requested_at timestamptz not null,
  expires_at timestamptz not null,
  push_claimed_at timestamptz,
  status text not null check (status in ('pending', 'shared', 'declined')),
  responded_at timestamptz,
  latitude double precision,
  longitude double precision,
  accuracy_m double precision
);

alter table public.gp_live_location_requests enable row level security;
revoke all on public.gp_live_location_requests from public, anon, authenticated;
grant select on public.gp_live_location_requests to authenticated;
drop policy if exists gp_location_read on public.gp_live_location_requests;
create policy gp_location_read on public.gp_live_location_requests for select to authenticated
using (
  private.gp_is_admin() or (employee_id = (select auth.uid()) and private.gp_has_permission('time'))
);

create or replace function public.gp_request_live_location(p_employee_id uuid, p_expected_start_ms bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  request_row public.gp_live_location_requests%rowtype;
  requested timestamptz;
  manager_name text;
begin
  if not private.gp_is_admin() then raise exception 'Active administrator permission required.' using errcode = '42501'; end if;
  if p_employee_id is null or p_expected_start_ms is null then raise exception 'Select a confirmed active shift.'; end if;
  perform pg_advisory_xact_lock(hashtextextended('gp-shift:' || p_employee_id::text, 0));
  perform 1 from public.active_time_sessions
    where auth_user_id = p_employee_id and started_at_ms = p_expected_start_ms for update;
  if not found then raise exception 'This shift changed or ended. Refresh Live Time Monitoring.'; end if;
  if not exists (select 1 from public.app_users u
    where auth_user_id = p_employee_id and active is true and (to_jsonb(u)->>'archived_at') is null
      and (perm_time is true or perm_admin is true)) then
    raise exception 'Select an active employee with Time Clock access.';
  end if;

  requested := clock_timestamp();
  select * into request_row from public.gp_live_location_requests where employee_id = p_employee_id for update;
  if found and request_row.session_started_at_ms = p_expected_start_ms then
    if request_row.status = 'pending' and request_row.expires_at > requested then
      return jsonb_build_object('id', request_row.id, 'created', false);
    end if;
    if request_row.requested_at > requested - interval '2 minutes' then
      raise exception 'Wait two minutes between location requests for this employee.';
    end if;
  end if;
  select employee_name into manager_name from public.app_users where auth_user_id = auth.uid();
  insert into public.gp_live_location_requests (employee_id, session_started_at_ms, requested_by,
    requester_name, requested_at, expires_at, status)
  values (p_employee_id, p_expected_start_ms, auth.uid(), manager_name, requested, requested + interval '10 minutes', 'pending')
  on conflict (employee_id) do update set id = excluded.id, session_started_at_ms = excluded.session_started_at_ms,
    requested_by = excluded.requested_by, requester_name = excluded.requester_name,
    requested_at = excluded.requested_at, expires_at = excluded.expires_at, status = excluded.status,
    push_claimed_at = null, responded_at = null, latitude = null, longitude = null, accuracy_m = null
  returning * into request_row;
  insert into public.audit_logs(actor_user_id, supervisor_name, action_type, details, "timestamp")
  values (auth.uid(), manager_name, 'TIME_LIVE_LOCATION_REQUEST',
    jsonb_build_object('request_id', request_row.id, 'employee_id', p_employee_id, 'session_started_at_ms', p_expected_start_ms)::text, requested);
  return jsonb_build_object('id', request_row.id, 'created', true);
end $$;

create or replace function public.gp_respond_live_location(
  p_request_id uuid, p_share boolean, p_latitude double precision default null,
  p_longitude double precision default null, p_accuracy_m double precision default null
) returns void language plpgsql security definer set search_path = '' as $$
declare
  employee uuid := auth.uid();
  request_row public.gp_live_location_requests%rowtype;
  response_time timestamptz;
  decision text;
begin
  if employee is null or not private.gp_has_permission('time') then
    raise exception 'Active Time Clock access required.' using errcode = '42501';
  end if;
  if p_share is null then raise exception 'Choose Share location or Decline.'; end if;
  perform pg_advisory_xact_lock(hashtextextended('gp-shift:' || employee::text, 0));
  select * into request_row from public.gp_live_location_requests where employee_id = employee and id = p_request_id;
  if not found then raise exception 'This location request is unavailable.'; end if;
  perform 1 from public.active_time_sessions
    where auth_user_id = employee and started_at_ms = request_row.session_started_at_ms for update;
  if not found then raise exception 'This shift has ended.'; end if;
  response_time := clock_timestamp();
  if request_row.status <> 'pending' or request_row.expires_at <= response_time then
    raise exception 'This location request has expired or already has a response.';
  end if;
  if p_share and not coalesce(p_latitude between -90 and 90 and p_longitude between -180 and 180
    and p_accuracy_m > 0 and p_accuracy_m < 'Infinity'::double precision, false) then
    raise exception 'Share a fresh location with a valid accuracy reading.';
  end if;

  decision := case when p_share then 'shared' else 'declined' end;
  update public.gp_live_location_requests set status = decision, responded_at = response_time,
    latitude = case when p_share then p_latitude end, longitude = case when p_share then p_longitude end,
    accuracy_m = case when p_share then p_accuracy_m end
    where employee_id = employee and id = p_request_id;
  insert into public.audit_logs(actor_user_id, supervisor_name, action_type, details, "timestamp")
  values (employee, (select employee_name from public.app_users where auth_user_id = employee),
    'TIME_LIVE_LOCATION_RESPONSE', jsonb_build_object('request_id', p_request_id, 'response', decision)::text, response_time);
end $$;

create or replace function public.gp_claim_live_location_push(p_request_id uuid, p_admin uuid)
returns table(device_id uuid, registered_at timestamptz, endpoint text, p256dh text, auth_key text, ttl integer)
language plpgsql security definer set search_path = '' as $$
declare
  request_row public.gp_live_location_requests%rowtype;
begin
  if not exists (select 1 from public.app_users u where auth_user_id = p_admin
    and active is true and perm_admin is true and (to_jsonb(u)->>'archived_at') is null) then
    raise exception 'Active administrator permission required.' using errcode = '42501';
  end if;
  update public.gp_live_location_requests r set push_claimed_at = clock_timestamp()
    where r.id = p_request_id and r.requested_by = p_admin and r.status = 'pending'
      and r.push_claimed_at is null and r.expires_at > clock_timestamp()
      and exists (select 1 from public.active_time_sessions s
        where s.auth_user_id = r.employee_id and s.started_at_ms = r.session_started_at_ms)
    returning r.* into request_row;
  if not found then return; end if;
  return query select d.id, d.registered_at, d.endpoint, d.p256dh, d.auth_key,
    greatest(0, floor(extract(epoch from request_row.expires_at - clock_timestamp()))::integer)
    from public.gp_push_devices d where d.user_id = request_row.employee_id
    order by d.registered_at desc limit 12;
end $$;

create or replace function private.gp_clear_live_location_request()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    if new.auth_user_id is not distinct from old.auth_user_id
      and new.started_at_ms is not distinct from old.started_at_ms then return new; end if;
  end if;
  delete from public.gp_live_location_requests
    where employee_id = old.auth_user_id and session_started_at_ms = old.started_at_ms;
  return old;
end $$;
drop trigger if exists gp_clear_live_location_request on public.active_time_sessions;
create trigger gp_clear_live_location_request
after delete or update of auth_user_id, started_at_ms on public.active_time_sessions
for each row execute function private.gp_clear_live_location_request();

revoke all on function public.gp_request_live_location(uuid,bigint),
  public.gp_respond_live_location(uuid,boolean,double precision,double precision,double precision),
  public.gp_claim_live_location_push(uuid,uuid) from public, anon, authenticated;
grant execute on function public.gp_request_live_location(uuid,bigint),
  public.gp_respond_live_location(uuid,boolean,double precision,double precision,double precision) to authenticated;
grant execute on function public.gp_claim_live_location_push(uuid,uuid) to service_role;
notify pgrst, 'reload schema';
commit;
