-- Apply after the GLASSPRO live punch approvals update. No Cron changes are required.
begin;

do $$ begin
  if to_regprocedure('public.gp_request_clock_in_change(bigint,timestamptz,text)') is null
    or to_regprocedure('private.gp_saved_shift_candidates(uuid,bigint,timestamptz)') is null then
    raise exception 'Install the Live Punch Approvals SQL update first.';
  end if;
end $$;

create or replace function public.gp_admin_correct_live_lunch(
  p_employee_id uuid,
  p_expected_start_ms bigint,
  p_expected_approved_start timestamptz,
  p_expected_lunch_out timestamptz,
  p_expected_lunch_back timestamptz,
  p_expected_break_minutes integer,
  p_lunch_out timestamptz,
  p_lunch_back timestamptz,
  p_reason text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  shift_row public.active_time_sessions%rowtype;
  shift_start timestamptz;
  checked_at timestamptz;
  unpaid_minutes integer := 0;
  reason text := btrim(coalesce(p_reason, ''));
begin
  if not private.gp_is_admin() then raise exception 'Active administrator permission required.'; end if;
  if p_employee_id is null or p_expected_start_ms is null then raise exception 'Choose a confirmed active shift.'; end if;
  if length(reason) not between 10 and 1000 then raise exception 'Enter an audit reason of 10–1000 characters.'; end if;

  perform pg_advisory_xact_lock(hashtextextended('gp-shift:' || p_employee_id::text, 0));
  select * into shift_row from public.active_time_sessions where auth_user_id = p_employee_id for update;
  if not found or shift_row.started_at_ms is distinct from p_expected_start_ms then
    raise exception 'This live shift changed or ended. Reopen the correction to review the latest punches.';
  end if;
  if shift_row.approved_clock_in_at is distinct from p_expected_approved_start
    or shift_row.lunch_out_at is distinct from p_expected_lunch_out
    or shift_row.lunch_in_at is distinct from p_expected_lunch_back
    or shift_row.break_minutes is distinct from p_expected_break_minutes then
    raise exception 'The clock-in or lunch punches changed while you were editing. Reopen the correction to review them.';
  end if;
  if exists (select 1 from private.gp_saved_shift_candidates(p_employee_id, p_expected_start_ms, shift_row.started_at)) then
    raise exception 'A timecard already matches this shift. Use Clock Out to clear the leftover live clock, then correct lunch with Edit Punch.';
  end if;

  shift_start := coalesce(shift_row.approved_clock_in_at, shift_row.started_at, to_timestamp(shift_row.started_at_ms / 1000.0));
  checked_at := clock_timestamp();
  if p_lunch_out is not null and (p_lunch_out < shift_start or p_lunch_out > checked_at) then
    raise exception 'Lunch Out must be within the active shift and cannot be in the future.';
  end if;
  if p_lunch_back is not null then
    if p_lunch_out is null or p_lunch_back <= p_lunch_out or p_lunch_back > checked_at then
      raise exception 'Lunch Back must be after Lunch Out and cannot be in the future.';
    end if;
    unpaid_minutes := (extract(epoch from (date_trunc('minute', p_lunch_back) - date_trunc('minute', p_lunch_out))) / 60)::integer;
    if unpaid_minutes < 1 then raise exception 'Lunch must contain at least one payroll minute.'; end if;
  end if;

  if shift_row.lunch_out_at is not distinct from p_lunch_out
    and shift_row.lunch_in_at is not distinct from p_lunch_back
    and shift_row.break_minutes is not distinct from unpaid_minutes then
    return jsonb_build_object('ok', true, 'unchanged', true, 'break_minutes', unpaid_minutes);
  end if;

  update public.active_time_sessions
     set lunch_out_at = p_lunch_out, lunch_in_at = p_lunch_back,
         break_minutes = unpaid_minutes, updated_at = checked_at
   where auth_user_id = p_employee_id;

  insert into public.audit_logs(actor_user_id, supervisor_name, action_type, details, "timestamp")
  values (auth.uid(), (select employee_name from public.app_users where auth_user_id = auth.uid()),
    'TIME_LUNCH_ADMIN_CORRECT', jsonb_build_object(
      'employee_name', shift_row.employee_name, 'auth_user_id', p_employee_id,
      'session_started_at_ms', shift_row.started_at_ms, 'reason', reason,
      'previous', jsonb_build_object('lunch_out_at', shift_row.lunch_out_at,
        'lunch_in_at', shift_row.lunch_in_at, 'break_minutes', shift_row.break_minutes),
      'corrected', jsonb_build_object('lunch_out_at', p_lunch_out,
        'lunch_in_at', p_lunch_back, 'break_minutes', unpaid_minutes)
    )::text, checked_at);

  return jsonb_build_object('ok', true, 'break_minutes', unpaid_minutes);
end $$;

revoke all on function public.gp_admin_correct_live_lunch(uuid,bigint,timestamptz,timestamptz,timestamptz,integer,timestamptz,timestamptz,text) from public, anon, authenticated;
grant execute on function public.gp_admin_correct_live_lunch(uuid,bigint,timestamptz,timestamptz,timestamptz,integer,timestamptz,timestamptz,text) to authenticated;
notify pgrst, 'reload schema';
commit;
