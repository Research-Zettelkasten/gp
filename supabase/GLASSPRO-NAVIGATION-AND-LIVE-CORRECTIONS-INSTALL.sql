-- GLASSPRO feature installation for the existing portal.
-- Run this COMPLETE file in Supabase SQL Editor. Atomic and rerunnable.
-- Cron setup is separate: this transaction does not install extensions,
-- change Cron permissions/jobs, or run an overdue clock-out sweep.
-- Existing scheduled jobs remain in place. For new scheduling, see
-- ENABLE-AUTO-CLOCK-OUT-CRON.sql after enabling Cron in the Dashboard.
begin;


-- Included: migrations/2026-11-16-admin-clock-out.sql
-- GLASSPRO 2026.11.16.4 — atomic employee and administrator clock-out.
-- Run in Supabase SQL Editor BEFORE deploying the matching website.
-- Requires the existing Auth/RLS, archive, exact-lunch and lunch-review updates.
-- Additive only: preserves existing timecards, permissions and RLS policies.

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


-- Included: migrations/2026-11-17-clock-out-text-hours-fix.sql
-- GLASSPRO 2026.11.17.2 — clock-out compatibility repair.
-- Run this entire SQL file in Supabase SQL Editor, then refresh GLASSPRO.
-- Supports existing text and numeric time_logs.decimal_hours columns.
-- Replaces only the clock-out function; does not alter column types or records.

do $check$
begin
  if to_regprocedure('public.gp_finish_active_shift(bigint,uuid,timestamptz,text,text,boolean,text,text)') is null then
    raise exception 'Install 2026-11-16-admin-clock-out.sql before this compatibility repair.';
  end if;
end
$check$;

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
        'decimal_hours',v_saved.decimal_hours::numeric,'ended_at',v_saved.session_ended_at);
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
  if v_saved.decimal_hours::numeric is distinct from v_hours or v_saved.break_minutes is distinct from v_break then
    raise exception 'The existing lunch rules changed the calculated duration. Review this shift in the timecard editor; its active punch was preserved.';
  end if;
  insert into public.audit_logs(actor_user_id,supervisor_name,action_type,details,"timestamp")
  values(v_uid,v_actor.employee_name,'TIME_CLOCK_OUT',jsonb_build_object(
    'employee_name',v_session.employee_name,'department',v_session.department,
    'auth_user_id',v_target,'started_at_ms',p_expected_start_ms,
    'ended_at',v_end,'ended_at_ms',floor(extract(epoch from v_end)*1000),
    'decimal_hours',v_saved.decimal_hours::numeric,'break_minutes',v_saved.break_minutes,
    'administrator_clock_out',v_admin_action,'reason',case when v_admin_action then v_reason end,
    'lunch_closed_at_clock_out',v_session.lunch_out_at is not null and v_session.lunch_in_at is null,
    'shift_id',v_saved.id
  )::text,clock_timestamp());
  delete from public.active_time_sessions
    where auth_user_id=v_target and started_at_ms=p_expected_start_ms;
  return jsonb_build_object('ok',true,'already_closed',false,'shift_id',v_saved.id::text,
    'decimal_hours',v_saved.decimal_hours::numeric,'ended_at',v_end,'work_date',v_saved.work_date);
end
$finish$;

revoke all on function public.gp_finish_active_shift(bigint,uuid,timestamptz,text,text,boolean,text,text) from public,anon,authenticated;
grant execute on function public.gp_finish_active_shift(bigint,uuid,timestamptz,text,text,boolean,text,text) to authenticated;
comment on function public.gp_finish_active_shift(bigint,uuid,timestamptz,text,text,boolean,text,text)
is 'Atomic authenticated clock-out. Explicit employee targets require an active administrator and an audit reason. Worksite timezone: America/New_York.';

notify pgrst,'reload schema';


-- Included: migrations/2026-11-23-weekly-time-and-auto-clock-out.sql
-- Existing GLASSPRO project; apply after the November 16/17 clock-out migrations.
-- No employee-specific records or credentials are included.

do $$begin
 if to_regprocedure('public.gp_finish_active_shift(bigint,uuid,timestamptz,text,text,boolean,text,text)') is null then raise exception 'Install the November 16/17 clock-out migrations first.';end if;
end$$;
alter table public.time_logs add column if not exists auto_clocked_out boolean not null default false;
alter table public.time_logs add column if not exists clock_out_review_status text not null default 'not_required' check(clock_out_review_status in ('not_required','pending','approved'));
create table if not exists public.gp_shift_close_reviews(
 id bigint generated by default as identity primary key,auth_user_id uuid not null references auth.users(id),session_started_at_ms bigint not null,
 employee_name text not null,due_at timestamptz not null,default_ended_at timestamptz not null,emergency boolean not null,
 time_log_id bigint references public.time_logs(id) on delete set null,status text not null default 'pending' check(status in ('pending','approved')),
 reason text not null,session_snapshot jsonb not null,candidate_time_log_ids jsonb not null default '[]'::jsonb,
 created_at timestamptz not null default now(),reviewed_by uuid references auth.users(id),reviewed_at timestamptz,review_note text,
 unique(auth_user_id,session_started_at_ms)
);
alter table public.gp_shift_close_reviews enable row level security;
revoke all on public.gp_shift_close_reviews from public,anon,authenticated;
grant select on public.gp_shift_close_reviews to authenticated;
drop policy if exists gp_shift_close_review_read on public.gp_shift_close_reviews;
create policy gp_shift_close_review_read on public.gp_shift_close_reviews for select to authenticated using(private.gp_is_admin() or (auth_user_id=(select auth.uid()) and private.gp_has_permission('time')));
create index if not exists gp_shift_close_pending on public.gp_shift_close_reviews(status,created_at desc);

create or replace function private.gp_shift_policy(p_start timestamptz)
returns table(due_at timestamptz,ended_at timestamptz,emergency boolean)
language sql stable set search_path='' as $$
 select ((d+1)+case when e then time '07:30' else time '00:01' end) at time zone 'America/New_York',
 ((case when e then d+1 else d end)+case when e then time '07:30' else time '17:00' end) at time zone 'America/New_York',e
 from (select (p_start at time zone 'America/New_York')::date d,(p_start at time zone 'America/New_York')::time>time '18:00' e) s;
$$;
create or replace function private.gp_punch_minutes(p_value text)
returns integer language plpgsql immutable set search_path='' as $$declare t time;begin
 if btrim(coalesce(p_value,''))!~*'^\d{1,2}:\d{2}\s*([ap]m)?$' then return null;end if;
 begin t:=btrim(p_value)::time;exception when others then return null;end;
 return extract(hour from t)::integer*60+extract(minute from t)::integer;
end$$;
create or replace function private.gp_saved_shift_candidates(p_user uuid,p_start_ms bigint,p_start timestamptz)
returns setof public.time_logs language sql stable security definer set search_path='' as $$
 select t.* from public.time_logs t where t.auth_user_id=p_user and (
 t.session_started_at_ms=p_start_ms or (t.session_started_at_ms is null and t.work_date=(p_start at time zone 'America/New_York')::date
 and private.gp_punch_minutes(t.clock_in)=extract(hour from p_start at time zone 'America/New_York')::integer*60+extract(minute from p_start at time zone 'America/New_York')::integer)) order by t.id;
$$;
create or replace function private.gp_saved_shift_end(t public.time_logs,p_start timestamptz)
returns timestamptz language plpgsql stable set search_path='' as $$declare a integer;b integer;e timestamptz;begin
 a:=private.gp_punch_minutes(t.clock_in);b:=private.gp_punch_minutes(t.clock_out);
 if a is null or b is null or b=a then raise exception 'Existing timecard needs a valid, nonzero clock-out time.';end if;
 e:=(t.work_date::timestamp+make_interval(mins=>b)+case when b<a then interval '1 day' else interval '0 days' end) at time zone 'America/New_York';
 -- A manager may have corrected clock_out since automatic closure. Honor the
 -- corrected punch; retain exact seconds only when saved metadata still agrees.
 if t.session_ended_at is not null and date_trunc('minute',t.session_ended_at at time zone 'America/New_York')=date_trunc('minute',e at time zone 'America/New_York') then e:=t.session_ended_at;end if;
 if e is null or e<=p_start or e>clock_timestamp() or e-p_start>interval '25 hours' or coalesce(t.decimal_hours::text,'')!~'^\d+(\.\d+)?$' then raise exception 'Review the existing timecard duration before clearing the active clock.';end if;
 if t.decimal_hours::numeric<=0 or t.decimal_hours::numeric>25 then raise exception 'Review the existing timecard hours before clearing the active clock.';end if;
 return e;
end$$;

create or replace function public.gp_saved_timecards_for_session(p_employee_id uuid,p_expected_start_ms bigint)
returns jsonb language plpgsql security definer set search_path='' as $$declare s public.active_time_sessions%rowtype;begin
 if not private.gp_is_admin() then raise exception 'Active administrator permission required';end if;
 select * into s from public.active_time_sessions where auth_user_id=p_employee_id and started_at_ms=p_expected_start_ms;
 if not found then return '[]'::jsonb;end if;
 return coalesce((select jsonb_agg(jsonb_build_object('id',t.id,'work_date',t.work_date,'clock_in',t.clock_in,'clock_out',t.clock_out,'decimal_hours',t.decimal_hours,'break_minutes',t.break_minutes,'lunch_review_status',t.lunch_review_status,'notes',t.notes)) from private.gp_saved_shift_candidates(p_employee_id,p_expected_start_ms,s.started_at) t),'[]'::jsonb);
end$$;

create or replace function public.gp_clear_saved_active_shift(p_employee_id uuid,p_expected_start_ms bigint,p_time_log_id bigint,p_reason text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare s public.active_time_sessions%rowtype;t public.time_logs%rowtype;e timestamptz;begin
 if not private.gp_is_admin() then raise exception 'Active administrator permission required';end if;
 if length(btrim(coalesce(p_reason,''))) not between 10 and 500 then raise exception 'Enter an audit reason of 10–500 characters.';end if;
 perform pg_advisory_xact_lock(hashtextextended('gp-shift:'||p_employee_id::text,0));
 select * into s from public.active_time_sessions where auth_user_id=p_employee_id for update;
 if not found then
  if exists(select 1 from public.time_logs where id=p_time_log_id and auth_user_id=p_employee_id and session_started_at_ms=p_expected_start_ms) then return jsonb_build_object('ok',true,'already_closed',true,'reused_timecard',true,'shift_id',p_time_log_id);end if;
  raise exception 'This shift already ended. Refresh active shifts.';
 end if;
 if s.started_at_ms is distinct from p_expected_start_ms then raise exception 'A different shift is now active. Refresh before continuing.';end if;
 select * into t from public.time_logs where id=p_time_log_id and id in(select id from private.gp_saved_shift_candidates(p_employee_id,p_expected_start_ms,s.started_at)) for update;
 if not found then raise exception 'The selected timecard no longer matches this active shift.';end if;
 e:=private.gp_saved_shift_end(t,s.started_at);
 perform set_config('gp.verified_shift_completion','yes',true);
 update public.time_logs set session_started_at_ms=p_expected_start_ms,session_ended_at=e,clocked_out_by=auth.uid(),admin_clock_out_reason=btrim(p_reason) where id=t.id;
 insert into public.audit_logs(actor_user_id,supervisor_name,action_type,details,"timestamp") values(auth.uid(),(select employee_name from public.app_users where auth_user_id=auth.uid()),'TIME_STALE_CLOCK_CLEARED',jsonb_build_object('employee_name',s.employee_name,'auth_user_id',p_employee_id,'started_at_ms',p_expected_start_ms,'shift_id',t.id,'reason',btrim(p_reason),'existing_timecard_preserved',true,'active_snapshot',to_jsonb(s))::text,clock_timestamp());
 delete from public.active_time_sessions where auth_user_id=p_employee_id and started_at_ms=p_expected_start_ms;
 return jsonb_build_object('ok',true,'already_closed',false,'reused_timecard',true,'shift_id',t.id,'decimal_hours',t.decimal_hours::numeric,'ended_at',e);
end$$;

-- Caller is the database scheduler. No browser can invoke this private worker.
create or replace function private.gp_auto_finish_shift(p_user uuid,p_start_ms bigint)
returns boolean language plpgsql security definer set search_path='' as $$
declare s public.active_time_sessions%rowtype;t public.time_logs%rowtype;p record;ids jsonb;cnt integer;row_id bigint;
 e timestamptz;l_end timestamptz;gross integer;brk integer:=0;hrs numeric;why text;failure text;new_card boolean:=false;
begin
 perform pg_advisory_xact_lock(hashtextextended('gp-shift:'||p_user::text,0));
 select * into s from public.active_time_sessions where auth_user_id=p_user for update;
 if not found or s.started_at_ms is distinct from p_start_ms then return false;end if;
 select * into p from private.gp_shift_policy(s.started_at);
 if p.due_at is null or p.due_at>clock_timestamp() then return false;end if;
 e:=p.ended_at;
 select count(*),coalesce(jsonb_agg(id),'[]'::jsonb) into cnt,ids from private.gp_saved_shift_candidates(p_user,p_start_ms,s.started_at);
 why:=case when p.emergency then 'Emergency shift automatically ended at 7:30 AM Eastern the next day; manager review required.' else 'Missed 12:01 AM Eastern cutoff: default clock-out recorded as 5:00 PM on the clock-in date; manager review required.' end;
 begin
  if abs(extract(epoch from s.started_at)*1000-s.started_at_ms)>1000 then raise exception 'Active start timestamp and session identifier disagree.';end if;
  if cnt>1 then raise exception 'Multiple existing timecards match; select the correct timecard in the review queue.';end if;
  perform set_config('gp.verified_shift_completion','yes',true);
  perform set_config('gp.verified_auto_clock_out','yes',true);
  if cnt=1 then
   select * into t from public.time_logs where id in(select id from private.gp_saved_shift_candidates(p_user,p_start_ms,s.started_at)) for update;
   e:=private.gp_saved_shift_end(t,s.started_at);row_id:=t.id;
   update public.time_logs set session_started_at_ms=p_start_ms,session_ended_at=e,clock_out_review_status='pending' where id=t.id;
   why:=why||' An existing completed timecard was retained without changing its punches or hours.';
  else
   if e<=s.started_at then raise exception 'The 5:00 PM default is at or before clock-in; an actual end time is required.';end if;
   gross:=(extract(epoch from (date_trunc('minute',e)-date_trunc('minute',s.started_at)))/60)::integer;
   if s.lunch_out_at is not null then
    l_end:=coalesce(s.lunch_in_at,e);
    if s.lunch_out_at<s.started_at or l_end>e or l_end<=s.lunch_out_at then raise exception 'Lunch punches extend beyond the default end; review actual punches.';end if;
    brk:=(extract(epoch from(date_trunc('minute',l_end)-date_trunc('minute',s.lunch_out_at)))/60)::integer;
    if brk<1 then raise exception 'Lunch duration needs review.';end if;
   elsif s.lunch_in_at is not null or coalesce(s.break_minutes,0)>0 then raise exception 'Legacy lunch information needs exact punch review.';end if;
   if gross<=brk then raise exception 'Default shift has no positive paid time.';end if;
   hrs:=round((gross-brk)::numeric/60,2);
   insert into public.time_logs(auth_user_id,employee_name,department,work_date,clock_in,clock_out,break_minutes,decimal_hours,lunch_out_time,lunch_in_time,lunch_out_at,lunch_in_at,no_lunch_reason,lunch_review_status,clock_in_location,clock_in_coords,clock_out_location,notes,session_started_at_ms,session_ended_at,auto_clocked_out,clock_out_review_status)
   values(p_user,s.employee_name,s.department,(s.started_at at time zone 'America/New_York')::date,to_char(s.started_at at time zone 'America/New_York','HH24:MI'),to_char(e at time zone 'America/New_York','HH24:MI'),brk,hrs,
   case when s.lunch_out_at is not null then to_char(s.lunch_out_at at time zone 'America/New_York','HH24:MI') end,case when l_end is not null then to_char(l_end at time zone 'America/New_York','HH24:MI') end,s.lunch_out_at,l_end,
   case when s.lunch_out_at is null then 'Automatic missed clock-out: no lunch punches; manager must verify.' end,case when s.lunch_out_at is null then 'pending' else 'not_required' end,s.clock_in_location,s.clock_in_coords,'Automatic clock-out; location not captured',why,p_start_ms,e,true,'pending') returning id into row_id;
   if (select decimal_hours::numeric<>hrs or break_minutes<>brk from public.time_logs where id=row_id) then raise exception 'Existing lunch calculation disagrees with elapsed payroll minutes.';end if;
   new_card:=true;
  end if;
 exception when others then failure:=sqlerrm;row_id:=null;new_card:=false;why:=why||' No new payroll timecard was created: '||failure;
 end;
 insert into public.gp_shift_close_reviews(auth_user_id,session_started_at_ms,employee_name,due_at,default_ended_at,emergency,time_log_id,reason,session_snapshot,candidate_time_log_ids)
 values(p_user,p_start_ms,s.employee_name,p.due_at,p.ended_at,p.emergency,row_id,why,to_jsonb(s),ids);
 insert into public.audit_logs(actor_user_id,supervisor_name,action_type,details,"timestamp") values(null,'GLASSPRO automatic timekeeping','TIME_AUTO_CLOCK_OUT',jsonb_build_object('employee_name',s.employee_name,'auth_user_id',p_user,'started_at_ms',p_start_ms,'due_at',p.due_at,'default_ended_at',p.ended_at,'recorded_ended_at',case when row_id is not null then e end,'shift_id',row_id,'created_timecard',new_card,'review_required',true,'reason',why)::text,clock_timestamp());
 delete from public.active_time_sessions where auth_user_id=p_user and started_at_ms=p_start_ms;
 return true;
end$$;
create or replace function public.gp_auto_clock_out_due()
returns integer language plpgsql security definer set search_path='' as $$declare s record;n integer:=0;begin
 for s in select a.auth_user_id,a.started_at_ms from public.active_time_sessions a cross join lateral private.gp_shift_policy(a.started_at) p where p.due_at<=clock_timestamp() order by a.started_at limit 500 loop
  if private.gp_auto_finish_shift(s.auth_user_id,s.started_at_ms) then n:=n+1;end if;
 end loop;return n;
end$$;

create or replace function public.gp_review_auto_clock_out(p_review_id bigint,p_note text,p_time_log_id bigint default null)
returns void language plpgsql security definer set search_path='' as $$declare r public.gp_shift_close_reviews%rowtype;t public.time_logs%rowtype;e timestamptz;begin
 if not private.gp_is_admin() then raise exception 'Active administrator permission required';end if;
 if length(btrim(coalesce(p_note,''))) not between 10 and 1000 then raise exception 'Explain the reviewed punches in 10–1000 characters.';end if;
 select * into r from public.gp_shift_close_reviews where id=p_review_id for update;
 if not found then raise exception 'Review record not found.';end if;
 if r.status='approved' then return;end if;
 perform pg_advisory_xact_lock(hashtextextended('gp-shift:'||r.auth_user_id::text,0));
 select * into t from public.time_logs where id=coalesce(p_time_log_id,r.time_log_id) and auth_user_id=r.auth_user_id for update;
 if not found then raise exception 'Save or select the corrected timecard before approving this review.';end if;
 if t.work_date<>((r.session_snapshot->>'started_at')::timestamptz at time zone 'America/New_York')::date or private.gp_punch_minutes(t.clock_in) is distinct from private.gp_punch_minutes(to_char((r.session_snapshot->>'started_at')::timestamptz at time zone 'America/New_York','HH24:MI')) or (t.session_started_at_ms is not null and t.session_started_at_ms<>r.session_started_at_ms) then raise exception 'Selected timecard does not match the original shift.';end if;
 e:=private.gp_saved_shift_end(t,(r.session_snapshot->>'started_at')::timestamptz);
 perform set_config('gp.verified_shift_completion','yes',true);perform set_config('gp.verified_auto_clock_out','yes',true);
 update public.time_logs set session_started_at_ms=r.session_started_at_ms,session_ended_at=e,clock_out_review_status='approved' where id=t.id;
 update public.gp_shift_close_reviews set status='approved',time_log_id=t.id,reviewed_by=auth.uid(),reviewed_at=clock_timestamp(),review_note=btrim(p_note) where id=r.id;
 insert into public.audit_logs(actor_user_id,supervisor_name,action_type,details,"timestamp") values(auth.uid(),(select employee_name from public.app_users where auth_user_id=auth.uid()),'TIME_AUTO_CLOCK_OUT_REVIEW',jsonb_build_object('review_id',r.id,'shift_id',t.id,'note',btrim(p_note))::text,clock_timestamp());
end$$;

create or replace function private.gp_guard_automatic_clock_fields()
returns trigger language plpgsql security definer set search_path='' as $$begin
 if auth.uid() is not null and current_setting('gp.verified_auto_clock_out',true) is distinct from 'yes' and ((tg_op='INSERT' and (new.auto_clocked_out or new.clock_out_review_status<>'not_required')) or (tg_op='UPDATE' and (new.auto_clocked_out is distinct from old.auto_clocked_out or new.clock_out_review_status is distinct from old.clock_out_review_status))) then raise exception 'Automatic clock-out flags are managed by the timekeeping service.';end if;return new;
end$$;
drop trigger if exists gp_auto_clock_metadata on public.time_logs;
create trigger gp_auto_clock_metadata before insert or update on public.time_logs for each row execute function private.gp_guard_automatic_clock_fields();
revoke all on function private.gp_shift_policy(timestamptz),private.gp_punch_minutes(text),private.gp_saved_shift_candidates(uuid,bigint,timestamptz),private.gp_saved_shift_end(public.time_logs,timestamptz),private.gp_auto_finish_shift(uuid,bigint),private.gp_guard_automatic_clock_fields() from public,anon,authenticated;
revoke all on function public.gp_auto_clock_out_due() from public,anon,authenticated;
revoke all on function public.gp_saved_timecards_for_session(uuid,bigint),public.gp_clear_saved_active_shift(uuid,bigint,bigint,text),public.gp_review_auto_clock_out(bigint,text,bigint) from public,anon;
grant execute on function public.gp_saved_timecards_for_session(uuid,bigint),public.gp_clear_saved_active_shift(uuid,bigint,bigint,text),public.gp_review_auto_clock_out(bigint,text,bigint) to authenticated;
notify pgrst,'reload schema';


-- Included: migrations/2026-11-23-clock-in-approval.sql
-- Additive approval workflow; requires November 23 weekly/automatic clock-out update.

create table if not exists public.gp_clock_in_requests(
 id bigint generated by default as identity primary key,auth_user_id uuid not null references auth.users(id),employee_name text not null,
 session_started_at_ms bigint not null,recorded_clock_in_at timestamptz not null,based_on_clock_in_at timestamptz not null,requested_clock_in_at timestamptz not null,
 reason text not null check(length(btrim(reason)) between 10 and 1000),status text not null default 'pending' check(status in ('pending','approved','rejected','cancelled')),
 session_snapshot jsonb not null,created_at timestamptz not null default now(),reviewed_by uuid references auth.users(id),reviewed_at timestamptz,review_note text,result jsonb
);
create unique index if not exists gp_clock_in_one_pending on public.gp_clock_in_requests(auth_user_id,session_started_at_ms) where status='pending';
alter table public.active_time_sessions add column if not exists approved_clock_in_at timestamptz;
alter table public.active_time_sessions add column if not exists clock_in_correction_id bigint references public.gp_clock_in_requests(id);
alter table public.time_logs add column if not exists approved_clock_in_at timestamptz;
alter table public.time_logs add column if not exists clock_in_correction_id bigint references public.gp_clock_in_requests(id);
alter table public.gp_clock_in_requests enable row level security;
revoke all on public.gp_clock_in_requests from public,anon,authenticated;
grant select on public.gp_clock_in_requests to authenticated;
drop policy if exists gp_clock_in_request_read on public.gp_clock_in_requests;
create policy gp_clock_in_request_read on public.gp_clock_in_requests for select to authenticated using(private.gp_is_admin() or (auth_user_id=(select auth.uid()) and private.gp_has_permission('time')));
create index if not exists gp_clock_in_review_pending on public.gp_clock_in_requests(status,created_at);

create or replace function private.gp_record_live_clock_in()
returns trigger language plpgsql security definer set search_path='' as $$begin
 if auth.uid() is null then return new;end if;
 if tg_op='INSERT' then
  new.started_at:=clock_timestamp();new.started_at_ms:=floor(extract(epoch from new.started_at)*1000);
 elsif new.started_at is distinct from old.started_at or new.started_at_ms is distinct from old.started_at_ms then
  raise exception 'The recorded clock-in is immutable. Request an administrator-approved correction.';
 end if;return new;
end$$;
drop trigger if exists gp_recorded_clock_in on public.active_time_sessions;
create trigger gp_recorded_clock_in before insert or update on public.active_time_sessions for each row execute function private.gp_record_live_clock_in();

create or replace function private.gp_guard_clock_in_approval()
returns trigger language plpgsql security definer set search_path='' as $$begin
 if auth.uid() is not null and current_setting('gp.approved_clock_in',true) is distinct from 'yes' and ((tg_op='INSERT' and (new.approved_clock_in_at is not null or new.clock_in_correction_id is not null)) or (tg_op='UPDATE' and (new.approved_clock_in_at is distinct from old.approved_clock_in_at or new.clock_in_correction_id is distinct from old.clock_in_correction_id))) then raise exception 'Clock-in corrections require administrator approval.';end if;return new;
end$$;
drop trigger if exists gp_clock_in_approved_fields on public.active_time_sessions;
create trigger gp_clock_in_approved_fields before insert or update on public.active_time_sessions for each row execute function private.gp_guard_clock_in_approval();
drop trigger if exists gp_clock_in_approved_fields on public.time_logs;
create trigger gp_clock_in_approved_fields before insert or update on public.time_logs for each row execute function private.gp_guard_clock_in_approval();
create or replace function private.gp_require_live_time_entry()
returns trigger language plpgsql security definer set search_path='' as $$begin
 if auth.uid() is not null and not private.gp_is_admin() and current_setting('gp.verified_shift_completion',true) is distinct from 'yes' then raise exception 'Use live clock-in and clock-out. Missing shifts must be entered by an administrator.';end if;return new;
end$$;
drop trigger if exists gp_time_live_only on public.time_logs;
create trigger gp_time_live_only before insert on public.time_logs for each row execute function private.gp_require_live_time_entry();

create or replace function public.gp_request_clock_in_change(p_expected_start_ms bigint,p_requested_at timestamptz,p_reason text)
returns bigint language plpgsql security definer set search_path='' as $$declare s public.active_time_sessions%rowtype;v_id bigint;begin
 if not private.gp_has_permission('time') then raise exception 'Active time-clock permission required.';end if;
 if length(btrim(coalesce(p_reason,''))) not between 10 and 1000 then raise exception 'Explain the requested change in 10–1000 characters.';end if;
 perform pg_advisory_xact_lock(hashtextextended('gp-shift:'||auth.uid()::text,0));
 select * into s from public.active_time_sessions where auth_user_id=auth.uid() for update;
 if not found or s.started_at_ms is distinct from p_expected_start_ms then raise exception 'This active shift changed or ended. Refresh before requesting a correction.';end if;
 if p_requested_at is null or p_requested_at>clock_timestamp() or abs(extract(epoch from(p_requested_at-s.started_at)))>86400 then raise exception 'Choose an actual clock-in within 24 hours of the recorded punch, not in the future.';end if;
 if p_requested_at=coalesce(s.approved_clock_in_at,s.started_at) then raise exception 'The requested clock-in already matches the current punch.';end if;
 if exists(select 1 from public.gp_clock_in_requests where auth_user_id=auth.uid() and session_started_at_ms=p_expected_start_ms and status='pending') then raise exception 'A change for this shift is already awaiting review.';end if;
 if exists(select 1 from private.gp_saved_shift_candidates(auth.uid(),p_expected_start_ms,s.started_at)) then raise exception 'This clock has a saved timecard. Ask an administrator to recover the stale clock and review that timecard.';end if;
 insert into public.gp_clock_in_requests(auth_user_id,employee_name,session_started_at_ms,recorded_clock_in_at,based_on_clock_in_at,requested_clock_in_at,reason,session_snapshot)
 values(auth.uid(),s.employee_name,p_expected_start_ms,s.started_at,coalesce(s.approved_clock_in_at,s.started_at),p_requested_at,btrim(p_reason),to_jsonb(s)) returning id into v_id;
 return v_id;
end$$;
create or replace function public.gp_cancel_clock_in_change(p_request_id bigint)
returns void language plpgsql security definer set search_path='' as $$begin
 if not private.gp_has_permission('time') then raise exception 'Active time-clock permission required.';end if;
 update public.gp_clock_in_requests set status='cancelled',review_note='Withdrawn by employee',reviewed_at=clock_timestamp() where id=p_request_id and auth_user_id=auth.uid() and status='pending';
 if not found then raise exception 'This request is no longer pending.';end if;
end$$;
create or replace function public.gp_review_clock_in_change(p_request_id bigint,p_approve boolean,p_note text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.gp_clock_in_requests%rowtype;s public.active_time_sessions%rowtype;t public.time_logs%rowtype;target uuid;v_end timestamptz;v_current timestamptz;gross integer;brk integer;hrs numeric;v_result jsonb;before_row jsonb;begin
 if not private.gp_is_admin() then raise exception 'Active administrator permission required.';end if;
 if p_approve is null or length(btrim(coalesce(p_note,''))) not between 10 and 1000 then raise exception 'Add an approval or rejection explanation of 10–1000 characters.';end if;
 select auth_user_id into target from public.gp_clock_in_requests where id=p_request_id;
 if target is null then raise exception 'Request not found.';end if;
 perform pg_advisory_xact_lock(hashtextextended('gp-shift:'||target::text,0));
 select * into r from public.gp_clock_in_requests where id=p_request_id for update;
 if r.status='approved' and p_approve then return r.result;end if;
 if r.status<>'pending' then raise exception 'This request was already reviewed or withdrawn.';end if;
 if p_approve then
  select * into s from public.active_time_sessions where auth_user_id=target and started_at_ms=r.session_started_at_ms for update;
  if found then
   v_current:=coalesce(s.approved_clock_in_at,s.started_at);v_end:=clock_timestamp();before_row:=to_jsonb(s);
   if v_current is distinct from r.based_on_clock_in_at then raise exception 'The clock-in was changed after this request. Reject it and request a new correction.';end if;
   if s.lunch_out_at is not null and r.requested_clock_in_at>s.lunch_out_at then raise exception 'Requested clock-in would fall after the recorded lunch.';end if;
  else
   select * into t from public.time_logs where auth_user_id=target and session_started_at_ms=r.session_started_at_ms for update;
   if not found then raise exception 'No completed timecard is available yet. Resolve its automatic-close review or missing shift first.';end if;
   v_current:=(t.work_date::timestamp+make_interval(mins=>private.gp_punch_minutes(t.clock_in))) at time zone 'America/New_York';
   if date_trunc('minute',v_current) is distinct from date_trunc('minute',r.based_on_clock_in_at) then raise exception 'A manager already changed this timecard. Reject the stale request and review actual punches.';end if;
   v_end:=private.gp_saved_shift_end(t,v_current);before_row:=to_jsonb(t);
   if t.lunch_out_at is not null and r.requested_clock_in_at>t.lunch_out_at then raise exception 'Requested clock-in would fall after the recorded lunch.';end if;
  end if;
  if r.requested_clock_in_at>=v_end or v_end-r.requested_clock_in_at>=interval '24 hours' then raise exception 'Corrected shift must have positive duration under 24 hours.';end if;
  perform set_config('gp.approved_clock_in','yes',true);
  if s.auth_user_id is not null then
   update public.active_time_sessions set approved_clock_in_at=r.requested_clock_in_at,clock_in_correction_id=r.id where auth_user_id=target and started_at_ms=r.session_started_at_ms;
   v_result:=jsonb_build_object('applied_to','active_shift','started_at_ms',r.session_started_at_ms,'approved_clock_in_at',r.requested_clock_in_at);
  else
   gross:=(extract(epoch from(date_trunc('minute',v_end)-date_trunc('minute',r.requested_clock_in_at)))/60)::integer;brk:=coalesce(t.break_minutes,0);
   if brk<0 or brk>=gross then raise exception 'Corrected shift must contain paid work after lunch.';end if;
   hrs:=round((gross-brk)::numeric/60,2);
   update public.time_logs set work_date=(r.requested_clock_in_at at time zone 'America/New_York')::date,clock_in=to_char(r.requested_clock_in_at at time zone 'America/New_York','HH24:MI'),decimal_hours=hrs,approved_clock_in_at=r.requested_clock_in_at,clock_in_correction_id=r.id where id=t.id;
   if (select decimal_hours::numeric is distinct from hrs or break_minutes is distinct from brk from public.time_logs where id=t.id) then raise exception 'Existing lunch calculations disagree. Review the exact punches before approving.';end if;
   v_result:=jsonb_build_object('applied_to','timecard','shift_id',t.id,'approved_clock_in_at',r.requested_clock_in_at,'decimal_hours',hrs);
  end if;
 else v_result:=jsonb_build_object('applied_to','rejected');end if;
 update public.gp_clock_in_requests set status=case when p_approve then 'approved' else 'rejected' end,reviewed_by=auth.uid(),reviewed_at=clock_timestamp(),review_note=btrim(p_note),result=v_result where id=r.id;
 insert into public.audit_logs(actor_user_id,supervisor_name,action_type,details,"timestamp") values(auth.uid(),(select employee_name from public.app_users where auth_user_id=auth.uid()),'TIME_CLOCK_IN_REVIEW',jsonb_build_object('request_id',r.id,'employee_name',r.employee_name,'auth_user_id',target,'approved',p_approve,'reason',r.reason,'review_note',btrim(p_note),'recorded_clock_in_at',r.recorded_clock_in_at,'requested_clock_in_at',r.requested_clock_in_at,'previous_record',before_row,'result',v_result)::text,clock_timestamp());
 return v_result;
end$$;

-- The original session identifier stays immutable; approved time is effective payroll time.
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
        'decimal_hours',v_saved.decimal_hours::numeric,'ended_at',v_saved.session_ended_at);
    end if;
    raise exception 'This employee is no longer clocked in. Refresh the active shifts.';
  end if;
  if v_session.started_at_ms is distinct from p_expected_start_ms then
    raise exception 'A different shift is now active. Refresh and review that shift before continuing.';
  end if;
  v_start := coalesce(v_session.approved_clock_in_at,v_session.started_at);
  v_end := coalesce(p_ended_at,clock_timestamp());
  if v_session.started_at is null or abs(extract(epoch from v_session.started_at)*1000-v_session.started_at_ms)>1000 then
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
  perform set_config('gp.approved_clock_in','yes',true);
  insert into public.time_logs (
    auth_user_id,employee_name,department,work_date,clock_in,clock_out,
    break_minutes,decimal_hours,lunch_out_time,lunch_in_time,lunch_out_at,lunch_in_at,
    no_lunch_reason,lunch_review_status,clock_in_location,clock_in_coords,
    clock_out_location,clock_out_coords,notes,session_started_at_ms,
    session_ended_at,clocked_out_by,admin_clock_out_reason,approved_clock_in_at,clock_in_correction_id
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
    v_notes,p_expected_start_ms,v_end,v_uid,case when v_admin_action then v_reason end,v_session.approved_clock_in_at,v_session.clock_in_correction_id
  ) returning * into v_saved;
  -- Existing manual-lunch triggers still run. If they disagree (for example
  -- during a daylight-saving clock change), keep the shift active for review.
  if v_saved.decimal_hours::numeric is distinct from v_hours or v_saved.break_minutes is distinct from v_break then
    raise exception 'The existing lunch rules changed the calculated duration. Review this shift in the timecard editor; its active punch was preserved.';
  end if;
  insert into public.audit_logs(actor_user_id,supervisor_name,action_type,details,"timestamp")
  values(v_uid,v_actor.employee_name,'TIME_CLOCK_OUT',jsonb_build_object(
    'employee_name',v_session.employee_name,'department',v_session.department,
    'auth_user_id',v_target,'started_at_ms',p_expected_start_ms,
    'ended_at',v_end,'ended_at_ms',floor(extract(epoch from v_end)*1000),
    'decimal_hours',v_saved.decimal_hours::numeric,'break_minutes',v_saved.break_minutes,
    'administrator_clock_out',v_admin_action,'reason',case when v_admin_action then v_reason end,
    'lunch_closed_at_clock_out',v_session.lunch_out_at is not null and v_session.lunch_in_at is null,
    'shift_id',v_saved.id
  )::text,clock_timestamp());
  delete from public.active_time_sessions
    where auth_user_id=v_target and started_at_ms=p_expected_start_ms;
  return jsonb_build_object('ok',true,'already_closed',false,'shift_id',v_saved.id::text,
    'decimal_hours',v_saved.decimal_hours::numeric,'ended_at',v_end,'work_date',v_saved.work_date);
end
$finish$;

create or replace function private.gp_auto_finish_shift(p_user uuid,p_start_ms bigint)
returns boolean language plpgsql security definer set search_path='' as $$
declare s public.active_time_sessions%rowtype;t public.time_logs%rowtype;p record;ids jsonb;cnt integer;row_id bigint;
 v_start timestamptz;e timestamptz;l_end timestamptz;gross integer;brk integer:=0;hrs numeric;why text;failure text;new_card boolean:=false;
begin
 perform pg_advisory_xact_lock(hashtextextended('gp-shift:'||p_user::text,0));
 select * into s from public.active_time_sessions where auth_user_id=p_user for update;
 if not found or s.started_at_ms is distinct from p_start_ms then return false;end if;
 v_start:=coalesce(s.approved_clock_in_at,s.started_at);
 select * into p from private.gp_shift_policy(v_start);
 if p.due_at is null or p.due_at>clock_timestamp() then return false;end if;
 e:=p.ended_at;
 select count(*),coalesce(jsonb_agg(id),'[]'::jsonb) into cnt,ids from private.gp_saved_shift_candidates(p_user,p_start_ms,v_start);
 why:=case when p.emergency then 'Emergency shift automatically ended at 7:30 AM Eastern the next day; manager review required.' else 'Missed 12:01 AM Eastern cutoff: default clock-out recorded as 5:00 PM on the clock-in date; manager review required.' end;
 begin
  if abs(extract(epoch from s.started_at)*1000-s.started_at_ms)>1000 then raise exception 'Active start timestamp and session identifier disagree.';end if;
  if cnt>1 then raise exception 'Multiple existing timecards match; select the correct timecard in the review queue.';end if;
  perform set_config('gp.verified_shift_completion','yes',true);perform set_config('gp.approved_clock_in','yes',true);
  perform set_config('gp.verified_auto_clock_out','yes',true);
  if cnt=1 then
   select * into t from public.time_logs where id in(select id from private.gp_saved_shift_candidates(p_user,p_start_ms,v_start)) for update;
   e:=private.gp_saved_shift_end(t,v_start);row_id:=t.id;
   update public.time_logs set session_started_at_ms=p_start_ms,session_ended_at=e,clock_out_review_status='pending' where id=t.id;
   why:=why||' An existing completed timecard was retained without changing its punches or hours.';
  else
   if e<=v_start then raise exception 'The 5:00 PM default is at or before clock-in; an actual end time is required.';end if;
   gross:=(extract(epoch from (date_trunc('minute',e)-date_trunc('minute',v_start)))/60)::integer;
   if s.lunch_out_at is not null then
    l_end:=coalesce(s.lunch_in_at,e);
    if s.lunch_out_at<v_start or l_end>e or l_end<=s.lunch_out_at then raise exception 'Lunch punches extend beyond the default end; review actual punches.';end if;
    brk:=(extract(epoch from(date_trunc('minute',l_end)-date_trunc('minute',s.lunch_out_at)))/60)::integer;
    if brk<1 then raise exception 'Lunch duration needs review.';end if;
   elsif s.lunch_in_at is not null or coalesce(s.break_minutes,0)>0 then raise exception 'Legacy lunch information needs exact punch review.';end if;
   if gross<=brk then raise exception 'Default shift has no positive paid time.';end if;
   hrs:=round((gross-brk)::numeric/60,2);
   insert into public.time_logs(auth_user_id,employee_name,department,work_date,clock_in,clock_out,break_minutes,decimal_hours,lunch_out_time,lunch_in_time,lunch_out_at,lunch_in_at,no_lunch_reason,lunch_review_status,clock_in_location,clock_in_coords,clock_out_location,notes,session_started_at_ms,session_ended_at,auto_clocked_out,clock_out_review_status,approved_clock_in_at,clock_in_correction_id)
   values(p_user,s.employee_name,s.department,(v_start at time zone 'America/New_York')::date,to_char(v_start at time zone 'America/New_York','HH24:MI'),to_char(e at time zone 'America/New_York','HH24:MI'),brk,hrs,
   case when s.lunch_out_at is not null then to_char(s.lunch_out_at at time zone 'America/New_York','HH24:MI') end,case when l_end is not null then to_char(l_end at time zone 'America/New_York','HH24:MI') end,s.lunch_out_at,l_end,
   case when s.lunch_out_at is null then 'Automatic missed clock-out: no lunch punches; manager must verify.' end,case when s.lunch_out_at is null then 'pending' else 'not_required' end,s.clock_in_location,s.clock_in_coords,'Automatic clock-out; location not captured',why,p_start_ms,e,true,'pending',s.approved_clock_in_at,s.clock_in_correction_id) returning id into row_id;
   if (select decimal_hours::numeric<>hrs or break_minutes<>brk from public.time_logs where id=row_id) then raise exception 'Existing lunch calculation disagrees with elapsed payroll minutes.';end if;
   new_card:=true;
  end if;
 exception when others then failure:=sqlerrm;row_id:=null;new_card:=false;why:=why||' No new payroll timecard was created: '||failure;
 end;
 insert into public.gp_shift_close_reviews(auth_user_id,session_started_at_ms,employee_name,due_at,default_ended_at,emergency,time_log_id,reason,session_snapshot,candidate_time_log_ids)
 values(p_user,p_start_ms,s.employee_name,p.due_at,p.ended_at,p.emergency,row_id,why,to_jsonb(s)||jsonb_build_object('effective_started_at',v_start),ids);
 insert into public.audit_logs(actor_user_id,supervisor_name,action_type,details,"timestamp") values(null,'GLASSPRO automatic timekeeping','TIME_AUTO_CLOCK_OUT',jsonb_build_object('employee_name',s.employee_name,'auth_user_id',p_user,'started_at_ms',p_start_ms,'due_at',p.due_at,'default_ended_at',p.ended_at,'recorded_ended_at',case when row_id is not null then e end,'shift_id',row_id,'created_timecard',new_card,'review_required',true,'reason',why)::text,clock_timestamp());
 delete from public.active_time_sessions where auth_user_id=p_user and started_at_ms=p_start_ms;
 return true;
end$$;

create or replace function public.gp_auto_clock_out_due()
returns integer language plpgsql security definer set search_path='' as $$declare s record;n integer:=0;begin
 for s in select a.auth_user_id,a.started_at_ms from public.active_time_sessions a cross join lateral private.gp_shift_policy(coalesce(a.approved_clock_in_at,a.started_at)) p where p.due_at<=clock_timestamp() order by a.started_at limit 500 loop
  if private.gp_auto_finish_shift(s.auth_user_id,s.started_at_ms) then n:=n+1;end if;
 end loop;return n;
end$$;

create or replace function public.gp_review_auto_clock_out(p_review_id bigint,p_note text,p_time_log_id bigint default null)
returns void language plpgsql security definer set search_path='' as $$declare r public.gp_shift_close_reviews%rowtype;t public.time_logs%rowtype;e timestamptz;v_start timestamptz;begin
 if not private.gp_is_admin() then raise exception 'Active administrator permission required';end if;
 if length(btrim(coalesce(p_note,''))) not between 10 and 1000 then raise exception 'Explain the reviewed punches in 10–1000 characters.';end if;
 select * into r from public.gp_shift_close_reviews where id=p_review_id for update;
 if not found then raise exception 'Review record not found.';end if;
 if r.status='approved' then return;end if;
 perform pg_advisory_xact_lock(hashtextextended('gp-shift:'||r.auth_user_id::text,0));
 select * into t from public.time_logs where id=coalesce(p_time_log_id,r.time_log_id) and auth_user_id=r.auth_user_id for update;
 if not found then raise exception 'Save or select the corrected timecard before approving this review.';end if;
 v_start:=coalesce(t.approved_clock_in_at,(r.session_snapshot->>'effective_started_at')::timestamptz,(r.session_snapshot->>'started_at')::timestamptz);
 if t.work_date<>(v_start at time zone 'America/New_York')::date or private.gp_punch_minutes(t.clock_in) is distinct from private.gp_punch_minutes(to_char(v_start at time zone 'America/New_York','HH24:MI')) or (t.session_started_at_ms is not null and t.session_started_at_ms<>r.session_started_at_ms) then raise exception 'Selected timecard does not match the original shift.';end if;
 e:=private.gp_saved_shift_end(t,v_start);
 perform set_config('gp.verified_shift_completion','yes',true);perform set_config('gp.verified_auto_clock_out','yes',true);
 update public.time_logs set session_started_at_ms=r.session_started_at_ms,session_ended_at=e,clock_out_review_status='approved' where id=t.id;
 update public.gp_shift_close_reviews set status='approved',time_log_id=t.id,reviewed_by=auth.uid(),reviewed_at=clock_timestamp(),review_note=btrim(p_note) where id=r.id;
 insert into public.audit_logs(actor_user_id,supervisor_name,action_type,details,"timestamp") values(auth.uid(),(select employee_name from public.app_users where auth_user_id=auth.uid()),'TIME_AUTO_CLOCK_OUT_REVIEW',jsonb_build_object('review_id',r.id,'shift_id',t.id,'note',btrim(p_note))::text,clock_timestamp());
end$$;

revoke all on function private.gp_guard_clock_in_approval(),private.gp_require_live_time_entry(),private.gp_record_live_clock_in() from public,anon,authenticated;
revoke all on function public.gp_request_clock_in_change(bigint,timestamptz,text),public.gp_cancel_clock_in_change(bigint),public.gp_review_clock_in_change(bigint,boolean,text) from public,anon;
grant execute on function public.gp_request_clock_in_change(bigint,timestamptz,text),public.gp_cancel_clock_in_change(bigint),public.gp_review_clock_in_change(bigint,boolean,text) to authenticated;
notify pgrst,'reload schema';


-- Included: migrations/2026-11-18-quote-callback-import.sql
-- Atomic insert-only quote import. Existing callbacks, receipts and notes are retained.

create or replace function public.gp_import_quote_callbacks(p_rows jsonb,p_source text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare accepted jsonb; n integer;begin
 if not private.gp_is_admin() then raise exception 'Only administrators can import quotes';end if;
 if p_rows is null or jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows) not between 1 and 5000 or octet_length(p_rows::text)>10000000 then raise exception 'Supply between 1 and 5,000 quotes';end if;
 if exists(select 1 from jsonb_array_elements(p_rows) r where coalesce(r->>'quote_number','')!~'^[0-9]+$' or length(btrim(coalesce(r->>'customer_name',''))) not between 1 and 250 or jsonb_typeof(r->'parts') is distinct from 'array') then raise exception 'Invalid quote identity or parts';end if;
 if exists(select 1 from jsonb_array_elements(p_rows) r where (r->>'quote_number')::numeric not between 1 and 9007199254740991) then raise exception 'Invalid quote number';end if;
 if exists(select r->>'quote_number' from jsonb_array_elements(p_rows) r group by r->>'quote_number' having count(*)>1) then raise exception 'Group line items by quote number first';end if;
 with inserted as(
  insert into public.outstanding_quotes(quote_number,normalized_customer_name,customer_name,quote_date,module,phone,has_cell,subtotal,tax,total,original_csr,parts,status,contact_attempts,call_data,admin_coaching_note)
  select quote_number,upper(regexp_replace(btrim(customer_name),'\s+',' ','g')),btrim(customer_name),quote_date,module,phone,coalesce(has_cell,false),coalesce(subtotal,0),coalesce(tax,0),coalesce(total,0),original_csr,parts,'open',0,'{}'::jsonb,''
  from jsonb_to_recordset(p_rows) as r(quote_number bigint,customer_name text,quote_date text,module text,phone text,has_cell boolean,subtotal numeric,tax numeric,total numeric,original_csr text,parts jsonb)
  on conflict(quote_number) do nothing returning quote_number
 )select coalesce(jsonb_agg(quote_number),'[]'::jsonb),count(*) into accepted,n from inserted;
 insert into public.audit_logs(supervisor_name,action_type,details)
 select employee_name,'CSV_UPLOAD',format('Quote Call-Backs: %s new quotes; %s duplicate numbers skipped; source %s',n,jsonb_array_length(p_rows)-n,left(coalesce(p_source,'Quotes.csv'),200)) from public.app_users where auth_user_id=auth.uid() and active limit 1;
 return jsonb_build_object('accepted',accepted,'added',n,'duplicates',jsonb_array_length(p_rows)-n);
end$$;
revoke all on function public.gp_import_quote_callbacks(jsonb,text) from public,anon;
grant execute on function public.gp_import_quote_callbacks(jsonb,text) to authenticated;
notify pgrst,'reload schema';


-- Included: migrations/2026-11-23-navigation-and-admin-live-corrections.sql
-- Requires the live-punch approval migration. Safe to rerun.

do $$begin
 if to_regprocedure('public.gp_review_clock_in_change(bigint,boolean,text)') is null then
  raise exception 'Run GLASSPRO-LIVE-PUNCH-APPROVALS-INSTALL.sql before this update.';
 end if;
end$$;

create table if not exists public.gp_navigation_preferences(
 auth_user_id uuid primary key references auth.users(id) on delete cascade,
 preferences jsonb not null default '{}'::jsonb check(jsonb_typeof(preferences)='object' and octet_length(preferences::text)<=16000),
 updated_at timestamptz not null default now()
);
alter table public.gp_navigation_preferences enable row level security;
revoke all on public.gp_navigation_preferences from public,anon,authenticated;
grant select on public.gp_navigation_preferences to authenticated;
drop policy if exists gp_navigation_own_read on public.gp_navigation_preferences;
create or replace function private.gp_navigation_active()
returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.app_users u where u.auth_user_id=auth.uid() and u.active is true and (to_jsonb(u)->>'archived_at') is null)
$$;
revoke all on function private.gp_navigation_active() from public,anon;
grant execute on function private.gp_navigation_active() to authenticated;
create policy gp_navigation_own_read on public.gp_navigation_preferences for select to authenticated using(
 auth_user_id=(select auth.uid()) and private.gp_navigation_active()
);
create or replace function public.gp_save_navigation_preferences(p_preferences jsonb,p_expected_user uuid)
returns jsonb language plpgsql security definer set search_path='' as $$begin
 if auth.uid() is null or p_expected_user is distinct from auth.uid() or not exists(select 1 from public.app_users u where u.auth_user_id=auth.uid() and u.active is true and (to_jsonb(u)->>'archived_at') is null) then raise exception 'An active employee account is required.';end if;
 if p_preferences is null or jsonb_typeof(p_preferences)<>'object' or octet_length(p_preferences::text)>16000 then raise exception 'Supply a navigation preference object under 16 KB.';end if;
 insert into public.gp_navigation_preferences(auth_user_id,preferences,updated_at) values(auth.uid(),p_preferences,clock_timestamp())
 on conflict(auth_user_id) do update set preferences=excluded.preferences,updated_at=excluded.updated_at;
 return p_preferences;
end$$;
revoke all on function public.gp_save_navigation_preferences(jsonb,uuid) from public,anon;
grant execute on function public.gp_save_navigation_preferences(jsonb,uuid) to authenticated;

alter table public.gp_clock_in_requests add column if not exists requested_by uuid references auth.users(id);
update public.gp_clock_in_requests set requested_by=auth_user_id where requested_by is null;
alter table public.gp_clock_in_requests alter column requested_by set default auth.uid();
alter table public.gp_clock_in_requests alter column requested_by set not null;

create or replace function public.gp_admin_correct_live_clock_in(p_employee_id uuid,p_expected_start_ms bigint,p_requested_at timestamptz,p_reason text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare s public.active_time_sessions%rowtype;pending_id bigint;request_id bigint;result jsonb;reason text:=btrim(coalesce(p_reason,''));superseded bigint[]:='{}';begin
 if not private.gp_is_admin() then raise exception 'Active administrator permission required.';end if;
 if p_employee_id is null or p_expected_start_ms is null then raise exception 'Choose a confirmed active shift.';end if;
 if length(reason) not between 10 and 1000 then raise exception 'Explain the actual start in 10–1000 characters.';end if;
 perform pg_advisory_xact_lock(hashtextextended('gp-shift:'||p_employee_id::text,0));
 select * into s from public.active_time_sessions where auth_user_id=p_employee_id for update;
 if not found or s.started_at_ms is distinct from p_expected_start_ms then raise exception 'This live shift changed or ended. Refresh before correcting its clock-in.';end if;
 if abs(extract(epoch from s.started_at)*1000-s.started_at_ms)>1 then raise exception 'Original clock-in identifiers disagree. Review the active shift before correcting it.';end if;
 if p_requested_at is null or p_requested_at>clock_timestamp() or abs(extract(epoch from(p_requested_at-s.started_at)))>86400 then raise exception 'Choose an actual clock-in within 24 hours of the recorded punch, not in the future.';end if;
 if p_requested_at=coalesce(s.approved_clock_in_at,s.started_at) then return jsonb_build_object('applied_to','active_shift','unchanged',true,'approved_clock_in_at',p_requested_at);end if;
 if exists(select 1 from private.gp_saved_shift_candidates(p_employee_id,p_expected_start_ms,s.started_at)) then raise exception 'A timecard already matches this clock. Keep that timecard and clear the stale active clock, then use Edit Punch.';end if;
 -- Resolve any conflicting pending employee request inside this same transaction.
 -- Its explanation and decision remain in request history and the audit trail.
 for pending_id in select id from public.gp_clock_in_requests where auth_user_id=p_employee_id and session_started_at_ms=p_expected_start_ms and status='pending' for update loop
  perform public.gp_review_clock_in_change(pending_id,false,'Superseded by administrator live clock-in correction: '||left(reason,900));
  superseded:=array_append(superseded,pending_id);
 end loop;
 insert into public.gp_clock_in_requests(auth_user_id,employee_name,session_started_at_ms,recorded_clock_in_at,based_on_clock_in_at,requested_clock_in_at,reason,session_snapshot,requested_by)
 values(p_employee_id,s.employee_name,s.started_at_ms,s.started_at,coalesce(s.approved_clock_in_at,s.started_at),p_requested_at,reason,to_jsonb(s),auth.uid()) returning id into request_id;
 result:=public.gp_review_clock_in_change(request_id,true,reason);
 insert into public.audit_logs(actor_user_id,supervisor_name,action_type,details,"timestamp") values(
  auth.uid(),(select employee_name from public.app_users where auth_user_id=auth.uid()),'TIME_CLOCK_IN_ADMIN_CORRECT',
  jsonb_build_object('request_id',request_id,'employee_name',s.employee_name,'auth_user_id',p_employee_id,'original_punch',to_jsonb(s),'approved_clock_in_at',p_requested_at,'reason',reason,'superseded_requests',superseded)::text,clock_timestamp());
 return result||jsonb_build_object('request_id',request_id,'superseded_requests',superseded);
end$$;
revoke all on function public.gp_admin_correct_live_clock_in(uuid,bigint,timestamptz,text) from public,anon;
grant execute on function public.gp_admin_correct_live_clock_in(uuid,bigint,timestamptz,text) to authenticated;
notify pgrst,'reload schema';


commit;
