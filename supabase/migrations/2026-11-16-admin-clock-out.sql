-- GLASSPRO 2026.11.16.4 — atomic employee and administrator clock-out.
-- Run in Supabase SQL Editor BEFORE deploying the matching website.
-- Requires the existing Auth/RLS, archive, exact-lunch and lunch-review updates.
-- Additive only: preserves existing timecards, permissions and RLS policies.
begin;

do $preflight$
begin
  if to_regclass('public.active_time_sessions') is null
     or to_regclass('public.time_logs') is null
     or to_regclass('public.app_users') is null
     or to_regclass('public.audit_logs') is null then
    raise exception 'Install the existing GLASSPRO database schema first.';
  end if;
  if not exists(select 1 from information_schema.columns where table_schema='public' and table_name='active_time_sessions' and column_name='auth_user_id')
     or not exists(select 1 from information_schema.columns where table_schema='public' and table_name='time_logs' and column_name='lunch_review_status')
     or not exists(select 1 from information_schema.columns where table_schema='public' and table_name='audit_logs' and column_name='actor_user_id') then
    raise exception 'Install the GLASSPRO Auth/RLS and November 12 lunch-review migrations first.';
  end if;
  if exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relname in ('app_users','active_time_sessions','time_logs','audit_logs') and not c.relrowsecurity) then
    raise exception 'GLASSPRO RLS must already be enabled. Do not use the legacy compatibility-only setup.';
  end if;
end
$preflight$;

alter table public.time_logs
  add column if not exists session_started_at_ms bigint,
  add column if not exists session_ended_at timestamptz,
  add column if not exists clocked_out_by uuid references auth.users(id) on delete set null,
  add column if not exists admin_clock_out_reason text;

create unique index if not exists gp_time_logs_session_once
  on public.time_logs(auth_user_id,session_started_at_ms)
  where session_started_at_ms is not null;

-- Completion metadata is issued only by the atomic function, never by a
-- browser's direct timecard insert. Existing manual edits retain their metadata.
create or replace function public.gp_guard_shift_completion_metadata()
returns trigger language plpgsql security definer set search_path='' as $guard$
begin
  if (select auth.uid()) is null then return new; end if;
  if (tg_op='INSERT' and (
      new.session_started_at_ms is not null or new.session_ended_at is not null
      or new.clocked_out_by is not null or new.admin_clock_out_reason is not null))
    or (tg_op='UPDATE' and (
      new.session_started_at_ms is distinct from old.session_started_at_ms
      or new.session_ended_at is distinct from old.session_ended_at
      or new.clocked_out_by is distinct from old.clocked_out_by
      or new.admin_clock_out_reason is distinct from old.admin_clock_out_reason)) then
    if coalesce(current_setting('gp.verified_shift_completion',true),'')<>'yes' then
      raise exception 'Completion metadata is managed by the GLASSPRO clock-out service.';
    end if;
  end if;
  return new;
end
$guard$;
drop trigger if exists gp_shift_completion_metadata on public.time_logs;
create trigger gp_shift_completion_metadata before insert or update
  on public.time_logs for each row execute function public.gp_guard_shift_completion_metadata();
revoke all on function public.gp_guard_shift_completion_metadata() from public,anon,authenticated;

create or replace function public.gp_finish_active_shift(
  p_expected_start_ms bigint,
  p_employee_id uuid default null,
  p_ended_at timestamptz default null,
  p_reason text default '',
  p_no_lunch_reason text default '',
  p_close_lunch boolean default false,
  p_location text default '',
  p_coords text default ''
) returns jsonb
language plpgsql security definer set search_path='' as $finish$
declare
  v_uid uuid := (select auth.uid());
  v_target uuid;
  v_actor public.app_users%rowtype;
  v_session public.active_time_sessions%rowtype;
  v_saved public.time_logs%rowtype;
  v_admin_action boolean := p_employee_id is not null;
  v_start timestamptz;
  v_end timestamptz;
  v_lunch_end timestamptz;
  v_start_local timestamp;
  v_end_local timestamp;
  v_gross integer;
  v_break integer := 0;
  v_hours numeric;
  v_reason text := btrim(coalesce(p_reason,''));
  v_no_lunch text := btrim(coalesce(p_no_lunch_reason,''));
  v_notes text;
begin
  if v_uid is null then raise exception 'Sign in before clocking out.' using errcode='42501'; end if;
  select u.* into v_actor from public.app_users u
    where u.auth_user_id=v_uid and u.active is true
      and (to_jsonb(u)->>'archived_at') is null;
  if not found then raise exception 'An active employee account is required.' using errcode='42501'; end if;
  if v_admin_action then
    if v_actor.perm_admin is distinct from true then
      raise exception 'Only an active administrator can clock out another employee.' using errcode='42501';
    end if;
    if length(v_reason)<10 or length(v_reason)>500 then
      raise exception 'Enter an administrator audit reason of 10–500 characters.';
    end if;
  elsif v_actor.perm_time is distinct from true and v_actor.perm_admin is distinct from true then
    raise exception 'Time-clock permission is required.' using errcode='42501';
  end if;
  if not v_admin_action and (p_ended_at is not null or p_close_lunch) then
    raise exception 'Employee clock-out uses server time and requires a completed lunch.';
  end if;
  if p_expected_start_ms is null or p_expected_start_ms<=0 then
    raise exception 'Refresh the employee active shift before clocking out.';
  end if;
  if length(v_no_lunch)>1000 or length(coalesce(p_location,''))>500 or length(coalesce(p_coords,''))>100 then
    raise exception 'One or more clock-out fields are too long.';
  end if;
  v_target := coalesce(p_employee_id,v_uid);

  -- Both employee and manager requests serialize on the same account and then
  -- lock the precise active session; lunch RPCs also lock this row when updating.
  perform pg_advisory_xact_lock(hashtextextended('gp-shift:'||v_target::text,0));
  select s.* into v_session from public.active_time_sessions s
    where s.auth_user_id=v_target for update;
  if not found then
    select t.* into v_saved from public.time_logs t
      where t.auth_user_id=v_target and t.session_started_at_ms=p_expected_start_ms;
    if found then
      return jsonb_build_object('ok',true,'already_closed',true,'shift_id',v_saved.id::text,
        'decimal_hours',v_saved.decimal_hours,'ended_at',v_saved.session_ended_at);
    end if;
    raise exception 'This employee is no longer clocked in. Refresh the active shifts.';
  end if;
  if v_session.started_at_ms is distinct from p_expected_start_ms then
    raise exception 'A different shift is now active. Refresh and review that shift before continuing.';
  end if;
  v_start := v_session.started_at;
  v_end := coalesce(p_ended_at,clock_timestamp());
  if v_start is null or abs(extract(epoch from v_start)*1000-v_session.started_at_ms)>1000 then
    raise exception 'The active shift start needs administrator review.';
  end if;
  if v_end>clock_timestamp() or v_end<=v_start or v_end-v_start>=interval '24 hours' then
    raise exception 'Clock-out must follow clock-in, cannot be in the future, and must be within 24 hours. Choose the actual end time for an older shift.';
  end if;
  v_start_local := v_start at time zone 'America/New_York';
  v_end_local := v_end at time zone 'America/New_York';
  v_gross := (extract(epoch from (date_trunc('minute',v_end)-date_trunc('minute',v_start)))/60)::integer;
  if v_gross<1 then raise exception 'The shift must contain at least one full payroll minute.'; end if;

  -- A legacy client may have saved a timecard before failing its separate
  -- session delete. Stop for review rather than insert that payroll row again.
  if exists(select 1 from public.time_logs t
    where t.auth_user_id=v_target and t.session_started_at_ms is null
      and t.work_date=v_start_local::date
      and regexp_replace(lower(btrim(t.clock_in)),'\s','','g') in (
        to_char(v_start_local,'HH24:MI'),lower(to_char(v_start_local,'HH12:MIAM')))) then
    raise exception 'An older client may already have saved this shift. Review its existing timecard before ending the active session; no duplicate was created.';
  end if;

  if v_session.lunch_out_at is not null then
    v_lunch_end := v_session.lunch_in_at;
    if v_lunch_end is null then
      if not v_admin_action or not coalesce(p_close_lunch,false) then
        raise exception 'Lunch is still in progress. Return from lunch or explicitly confirm an administrator lunch close.';
      end if;
      v_lunch_end := v_end;
    end if;
    if v_session.lunch_out_at<v_start or v_lunch_end>v_end
       or v_lunch_end<=v_session.lunch_out_at then
      raise exception 'The lunch punches must fall within the recorded shift.';
    end if;
    v_break := (extract(epoch from (date_trunc('minute',v_lunch_end)-date_trunc('minute',v_session.lunch_out_at)))/60)::integer;
    if v_break<1 then raise exception 'Review this lunch: it must contain at least one payroll minute.'; end if;
    v_no_lunch := '';
  else
    if v_session.lunch_in_at is not null then raise exception 'Lunch punches need administrator review.'; end if;
    if coalesce(v_session.break_minutes,0)>0 then
      raise exception 'Legacy break minutes lack exact lunch punches. Review and complete this shift through the timecard editor.';
    end if;
    if v_admin_action then v_no_lunch := 'Administrator clock-out without recorded lunch: '||v_reason; end if;
    if length(v_no_lunch)<10 then raise exception 'Enter a no-lunch explanation of at least 10 characters.'; end if;
  end if;
  if v_break>=v_gross then raise exception 'The shift must contain paid work time after lunch.'; end if;
  v_hours := round((v_gross-v_break)::numeric/60,2);
  v_notes := case when v_admin_action then '[ADMIN CLOCK OUT by '||v_actor.employee_name||'] '||v_reason
    else 'Employee clock-out' end;

  perform set_config('gp.verified_shift_completion','yes',true);
  insert into public.time_logs (
    auth_user_id,employee_name,department,work_date,clock_in,clock_out,
    break_minutes,decimal_hours,lunch_out_time,lunch_in_time,lunch_out_at,lunch_in_at,
    no_lunch_reason,lunch_review_status,clock_in_location,clock_in_coords,
    clock_out_location,clock_out_coords,notes,session_started_at_ms,
    session_ended_at,clocked_out_by,admin_clock_out_reason
  ) values (
    v_target,v_session.employee_name,v_session.department,v_start_local::date,
    to_char(v_start_local,'HH24:MI'),to_char(v_end_local,'HH24:MI'),v_break,v_hours,
    case when v_session.lunch_out_at is not null then to_char(v_session.lunch_out_at at time zone 'America/New_York','HH24:MI') end,
    case when v_lunch_end is not null then to_char(v_lunch_end at time zone 'America/New_York','HH24:MI') end,
    v_session.lunch_out_at,v_lunch_end,nullif(v_no_lunch,''),
    case when v_session.lunch_out_at is null then 'pending' else 'not_required' end,
    v_session.clock_in_location,v_session.clock_in_coords,
    case when v_admin_action then 'Administrator clock-out (location not captured)' else nullif(p_location,'') end,
    case when v_admin_action then null else nullif(p_coords,'') end,
    v_notes,p_expected_start_ms,v_end,v_uid,case when v_admin_action then v_reason end
  ) returning * into v_saved;
  -- Existing manual-lunch triggers still run. If they disagree (for example
  -- during a daylight-saving clock change), keep the shift active for review.
  if v_saved.decimal_hours is distinct from v_hours or v_saved.break_minutes is distinct from v_break then
    raise exception 'The existing lunch rules changed the calculated duration. Review this shift in the timecard editor; its active punch was preserved.';
  end if;
  insert into public.audit_logs(actor_user_id,supervisor_name,action_type,details,"timestamp")
  values(v_uid,v_actor.employee_name,'TIME_CLOCK_OUT',jsonb_build_object(
    'employee_name',v_session.employee_name,'department',v_session.department,
    'auth_user_id',v_target,'started_at_ms',p_expected_start_ms,
    'ended_at',v_end,'ended_at_ms',floor(extract(epoch from v_end)*1000),
    'decimal_hours',v_saved.decimal_hours,'break_minutes',v_saved.break_minutes,
    'administrator_clock_out',v_admin_action,'reason',case when v_admin_action then v_reason end,
    'lunch_closed_at_clock_out',v_session.lunch_out_at is not null and v_session.lunch_in_at is null,
    'shift_id',v_saved.id
  )::text,clock_timestamp());
  delete from public.active_time_sessions
    where auth_user_id=v_target and started_at_ms=p_expected_start_ms;
  return jsonb_build_object('ok',true,'already_closed',false,'shift_id',v_saved.id::text,
    'decimal_hours',v_saved.decimal_hours,'ended_at',v_end,'work_date',v_saved.work_date);
end
$finish$;

revoke all on function public.gp_finish_active_shift(bigint,uuid,timestamptz,text,text,boolean,text,text) from public,anon,authenticated;
grant execute on function public.gp_finish_active_shift(bigint,uuid,timestamptz,text,text,boolean,text,text) to authenticated;
comment on function public.gp_finish_active_shift(bigint,uuid,timestamptz,text,text,boolean,text,text)
is 'Atomic authenticated clock-out. Explicit employee targets require an active administrator and an audit reason. Worksite timezone: America/New_York.';
notify pgrst,'reload schema';
commit;
