-- Apply after the administrator live lunch correction migration.
begin;

create table if not exists public.gp_lunch_requests (
  id bigint generated always as identity primary key,
  employee_id uuid not null references auth.users(id),
  employee_name text not null,
  session_started_at_ms bigint,
  time_log_id bigint,
  shift_start timestamptz not null,
  shift_end_at_request timestamptz,
  previous_lunch jsonb not null,
  requested_out timestamptz not null,
  requested_back timestamptz not null,
  reason text not null check (length(btrim(reason)) between 10 and 1000),
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  created_at timestamptz not null default clock_timestamp(),
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz,
  review_note text,
  check (time_log_id is not null or session_started_at_ms is not null),
  check (requested_back > requested_out)
);

create index if not exists gp_lunch_requests_employee on public.gp_lunch_requests(employee_id, created_at desc);
create index if not exists gp_lunch_requests_review on public.gp_lunch_requests(created_at) where status = 'pending';
alter table public.gp_lunch_requests enable row level security;
revoke all on public.gp_lunch_requests from public, anon, authenticated;
grant select on public.gp_lunch_requests to authenticated;
drop policy if exists gp_lunch_requests_read on public.gp_lunch_requests;
create policy gp_lunch_requests_read on public.gp_lunch_requests for select to authenticated
using ((select private.gp_is_admin()) or (employee_id = (select auth.uid()) and (select private.gp_has_permission('time'))));

-- Called only from the two authorized wrappers, under the existing per-employee shift lock.
create or replace function private.gp_lunch_request_shift(employee uuid, start_ms bigint, card_id bigint)
returns table(employee_name text, session_ms bigint, timecard_id bigint, starts timestamptz,
              ends timestamptz, previous jsonb)
language plpgsql set search_path = '' as $$
declare
  live public.active_time_sessions%rowtype;
  card public.time_logs%rowtype;
  original_start timestamptz;
begin
  if card_id is null then
    select * into live from public.active_time_sessions s
      where s.auth_user_id = employee and s.started_at_ms = start_ms for update;
    if found then
      if exists (select 1 from private.gp_saved_shift_candidates(employee, start_ms, live.started_at)) then
        raise exception 'This shift has a saved timecard. Select the saved shift or ask a manager to clear the leftover clock.';
      end if;
      employee_name := live.employee_name;
      session_ms := live.started_at_ms;
      starts := coalesce(live.approved_clock_in_at, live.started_at, to_timestamp(start_ms / 1000.0));
      previous := jsonb_build_object('out', live.lunch_out_at, 'back', live.lunch_in_at,
        'minutes', coalesce(live.break_minutes, 0),
        'wall_out', to_char(live.lunch_out_at at time zone 'America/New_York', 'HH24:MI'),
        'wall_back', to_char(live.lunch_in_at at time zone 'America/New_York', 'HH24:MI'));
      return next;
      return;
    end if;
  end if;

  select * into card from public.time_logs t where t.auth_user_id = employee
    and ((card_id is not null and t.id = card_id) or (card_id is null and t.session_started_at_ms = start_ms))
    order by t.id limit 1 for update;
  if not found then raise exception 'The shift is unavailable. Refresh Time Clock and select your shift again.'; end if;

  employee_name := card.employee_name;
  session_ms := card.session_started_at_ms;
  timecard_id := card.id;
  starts := (card.work_date::timestamp + make_interval(mins => private.gp_punch_minutes(card.clock_in)))
    at time zone 'America/New_York';
  original_start := coalesce(card.approved_clock_in_at, to_timestamp(card.session_started_at_ms / 1000.0));
  if date_trunc('minute', original_start at time zone 'America/New_York') = starts at time zone 'America/New_York' then
    starts := original_start;
  end if;
  if starts is null then raise exception 'The timecard has an invalid clock-in. Ask a manager to review it.'; end if;
  ends := private.gp_saved_shift_end(card, starts);
  previous := jsonb_build_object('out', card.lunch_out_at, 'back', card.lunch_in_at,
    'minutes', coalesce(card.break_minutes, 0),
    'wall_out', nullif(card.lunch_out_time, ''), 'wall_back', nullif(card.lunch_in_time, ''));
  return next;
end $$;

create or replace function private.gp_validate_requested_lunch(starts timestamptz, ends timestamptz,
  punch_out timestamptz, punch_back timestamptz)
returns integer language plpgsql set search_path = '' as $$
declare
  unpaid integer;
  shift_end timestamptz := coalesce(ends, clock_timestamp());
begin
  if punch_out is null or punch_back is null or punch_out < date_trunc('minute', starts)
    or punch_back <= punch_out or punch_back > shift_end then
    raise exception 'Enter both lunch punches within the shift. Lunch Back must follow Lunch Out.';
  end if;
  unpaid := extract(epoch from date_trunc('minute', punch_back) - date_trunc('minute', punch_out)) / 60;
  if unpaid < 1 or unpaid >= extract(epoch from date_trunc('minute', shift_end) - date_trunc('minute', starts)) / 60 then
    raise exception 'Lunch must include at least one unpaid minute and leave paid time in the shift.';
  end if;
  return unpaid;
end $$;

create or replace function public.gp_request_lunch_change(p_session_start_ms bigint, p_time_log_id bigint,
  p_lunch_out timestamptz, p_lunch_back timestamptz, p_reason text)
returns bigint language plpgsql security definer set search_path = '' as $$
declare
  employee uuid := auth.uid();
  shift record;
  request_id bigint;
  reason text := btrim(coalesce(p_reason, ''));
begin
  if employee is null or not private.gp_has_permission('time') then raise exception 'Active Time Clock access required.'; end if;
  if (p_session_start_ms is null) = (p_time_log_id is null) then raise exception 'Select a single shift.'; end if;
  if length(reason) not between 10 and 1000 then raise exception 'Enter a reason of 10–1000 characters.'; end if;
  perform pg_advisory_xact_lock(hashtextextended('gp-shift:' || employee::text, 0));
  select * into shift from private.gp_lunch_request_shift(employee, p_session_start_ms, p_time_log_id);
  perform private.gp_validate_requested_lunch(shift.starts, shift.ends, p_lunch_out, p_lunch_back);

  if date_trunc('minute', p_lunch_out) = date_trunc('minute', (shift.previous->>'out')::timestamptz)
    and date_trunc('minute', p_lunch_back) = date_trunc('minute', (shift.previous->>'back')::timestamptz)
    and to_char(p_lunch_out at time zone 'America/New_York', 'HH24:MI') = (shift.previous->>'wall_out')
    and to_char(p_lunch_back at time zone 'America/New_York', 'HH24:MI') = (shift.previous->>'wall_back') then
    raise exception 'These times already match the recorded lunch.';
  end if;
  if exists (select 1 from public.gp_lunch_requests r where r.employee_id = employee and r.status = 'pending'
    and ((shift.session_ms is not null and r.session_started_at_ms = shift.session_ms)
      or (shift.timecard_id is not null and r.time_log_id = shift.timecard_id))) then
    raise exception 'A lunch correction for this shift is already waiting for review.';
  end if;
  insert into public.gp_lunch_requests(employee_id,employee_name,session_started_at_ms,time_log_id,
    shift_start,shift_end_at_request,previous_lunch,requested_out,requested_back,reason)
  values (employee,shift.employee_name,shift.session_ms,shift.timecard_id,shift.starts,shift.ends,
    shift.previous,p_lunch_out,p_lunch_back,reason) returning id into request_id;
  return request_id;
end $$;

create or replace function public.gp_review_lunch_change(p_request_id bigint, p_approve boolean, p_note text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  employee uuid;
  request_row public.gp_lunch_requests%rowtype;
  shift record;
  note text := btrim(coalesce(p_note, ''));
  out_at timestamptz;
  back_at timestamptz;
  unpaid integer;
  paid_hours numeric;
begin
  if private.gp_is_admin() is not true then raise exception 'Active administrator permission required.'; end if;
  if p_approve is null or length(note) not between 10 and 1000 then raise exception 'Enter a review note of 10–1000 characters.'; end if;
  select employee_id into employee from public.gp_lunch_requests where id = p_request_id;
  if not found then raise exception 'Lunch correction request not found.'; end if;
  perform pg_advisory_xact_lock(hashtextextended('gp-shift:' || employee::text, 0));
  select * into request_row from public.gp_lunch_requests where id = p_request_id for update;
  if request_row.status <> 'pending' then raise exception 'This lunch correction was already reviewed.'; end if;

  if p_approve then
    select * into shift from private.gp_lunch_request_shift(employee, request_row.session_started_at_ms, request_row.time_log_id);
    if shift.starts is distinct from request_row.shift_start or shift.previous is distinct from request_row.previous_lunch
      or (request_row.shift_end_at_request is not null and shift.ends is distinct from request_row.shift_end_at_request) then
      raise exception 'The punches changed since this request. Reject it with an explanation and ask for a fresh request.';
    end if;
    out_at := greatest(request_row.requested_out, shift.starts);
    back_at := request_row.requested_back;
    unpaid := private.gp_validate_requested_lunch(shift.starts, shift.ends, out_at, back_at);

    if shift.timecard_id is null then
      perform public.gp_admin_correct_live_lunch(employee, shift.session_ms,
        (select s.approved_clock_in_at from public.active_time_sessions s where s.auth_user_id = employee),
        (shift.previous->>'out')::timestamptz, (shift.previous->>'back')::timestamptz,
        (select s.break_minutes from public.active_time_sessions s where s.auth_user_id = employee),
        out_at, back_at, note);
    else
      paid_hours := round((extract(epoch from date_trunc('minute', shift.ends) - date_trunc('minute', shift.starts)) / 60 - unpaid) / 60, 2);
      update public.time_logs set lunch_out_at = out_at, lunch_in_at = back_at,
        lunch_out_time = to_char(out_at at time zone 'America/New_York', 'HH24:MI'),
        lunch_in_time = to_char(back_at at time zone 'America/New_York', 'HH24:MI'),
        break_minutes = unpaid, decimal_hours = paid_hours, no_lunch_reason = null,
        lunch_review_status = 'not_required', lunch_review_note = null, lunch_reviewed_by = null, lunch_reviewed_at = null
      where id = shift.timecard_id;
      if exists (select 1 from public.time_logs where id = shift.timecard_id
        and (break_minutes is distinct from unpaid or decimal_hours::numeric is distinct from paid_hours)) then
        raise exception 'The timecard calculation disagrees with elapsed minutes. Review the exact punches before approving.';
      end if;
    end if;
  end if;

  update public.gp_lunch_requests set status = case when p_approve then 'approved' else 'rejected' end,
    reviewed_by = auth.uid(), reviewed_at = clock_timestamp(), review_note = note
  where id = p_request_id;
  insert into public.audit_logs(actor_user_id,supervisor_name,action_type,details,"timestamp")
  values (auth.uid(), (select employee_name from public.app_users where auth_user_id = auth.uid()),
    'TIME_LUNCH_REQUEST_REVIEW', jsonb_build_object('request_id', p_request_id, 'employee_id', employee,
      'session_started_at_ms', request_row.session_started_at_ms, 'approved', p_approve, 'reason', request_row.reason,
      'review_note', note, 'previous_lunch', request_row.previous_lunch,
      'requested_out', request_row.requested_out, 'requested_back', request_row.requested_back,
      'applied_out', out_at, 'applied_back', back_at)::text, clock_timestamp());
end $$;

revoke all on function private.gp_lunch_request_shift(uuid,bigint,bigint),
  private.gp_validate_requested_lunch(timestamptz,timestamptz,timestamptz,timestamptz) from public, anon, authenticated;
revoke all on function public.gp_request_lunch_change(bigint,bigint,timestamptz,timestamptz,text),
  public.gp_review_lunch_change(bigint,boolean,text) from public, anon, authenticated;
grant execute on function public.gp_request_lunch_change(bigint,bigint,timestamptz,timestamptz,text),
  public.gp_review_lunch_change(bigint,boolean,text) to authenticated;
notify pgrst, 'reload schema';
commit;
