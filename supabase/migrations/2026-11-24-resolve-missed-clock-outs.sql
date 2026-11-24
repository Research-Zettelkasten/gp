-- Recover missed clock-outs whose default could not create a valid timecard.
begin;

create or replace function public.gp_missed_clock_out_candidates(p_review_id bigint)
returns table(id bigint, work_date date, clock_in text, clock_out text, decimal_hours numeric, break_minutes integer)
language plpgsql security definer set search_path = '' as $$
declare
  review public.gp_shift_close_reviews%rowtype;
  shift_start timestamptz;
begin
  if private.gp_is_admin() is not true then raise exception 'Active administrator permission required.'; end if;
  select * into review from public.gp_shift_close_reviews where gp_shift_close_reviews.id = p_review_id;
  if not found or review.status <> 'pending' then raise exception 'This review is no longer pending. Refresh the queue.'; end if;
  shift_start := coalesce((review.session_snapshot->>'effective_started_at')::timestamptz,
    (review.session_snapshot->>'approved_clock_in_at')::timestamptz, (review.session_snapshot->>'started_at')::timestamptz);
  return query select t.id, t.work_date, t.clock_in::text, t.clock_out::text,
    case when t.decimal_hours::text ~ '^[0-9]+(\.[0-9]+)?$' then t.decimal_hours::numeric end, t.break_minutes
    from private.gp_saved_shift_candidates(review.auth_user_id, review.session_started_at_ms, shift_start) t;
end $$;

create or replace function public.gp_resolve_missed_clock_out(p_review_id bigint, p_ended_at timestamptz,
  p_lunch_out timestamptz, p_lunch_back timestamptz, p_no_lunch boolean, p_note text)
returns bigint language plpgsql security definer set search_path = '' as $$
declare
  review public.gp_shift_close_reviews%rowtype;
  shift_start timestamptz;
  lunch_out timestamptz;
  note text := btrim(coalesce(p_note,''));
  gross integer;
  unpaid integer := 0;
  hours numeric;
  card_id bigint;
  manager text;
begin
  if private.gp_is_admin() is not true then raise exception 'Active administrator permission required.'; end if;
  if length(note) not between 10 and 1000 then raise exception 'Enter a manager note of 10–1000 characters.'; end if;
  -- Existing review approval also locks the review row before taking the shift lock.
  select * into review from public.gp_shift_close_reviews where id = p_review_id for update;
  if not found then raise exception 'Review record not found. Refresh the queue.'; end if;
  if review.status = 'approved' then return review.time_log_id; end if;
  if review.time_log_id is not null then raise exception 'A timecard is already linked. Review that timecard instead.'; end if;
  perform pg_advisory_xact_lock(hashtextextended('gp-shift:' || review.auth_user_id::text, 0));
  shift_start := coalesce((review.session_snapshot->>'effective_started_at')::timestamptz,
    (review.session_snapshot->>'approved_clock_in_at')::timestamptz, (review.session_snapshot->>'started_at')::timestamptz);
  if shift_start is null then raise exception 'Original clock-in is missing. Ask a manager to verify the shift record.'; end if;
  if exists (select 1 from public.active_time_sessions where auth_user_id = review.auth_user_id
      and started_at_ms = review.session_started_at_ms) then
    raise exception 'This shift is still active. End the live shift before reviewing it.';
  end if;
  if exists (select 1 from private.gp_saved_shift_candidates(review.auth_user_id, review.session_started_at_ms, shift_start)) then
    raise exception 'A matching timecard is already saved. Refresh the timecard choices and select it.';
  end if;
  if p_ended_at is null or p_ended_at <= shift_start or p_ended_at > clock_timestamp()
    or p_ended_at - shift_start >= interval '24 hours' then
    raise exception 'Enter the actual clock-out within 24 hours of clock-in and before the current time.';
  end if;
  gross := extract(epoch from (date_trunc('minute',p_ended_at) - date_trunc('minute',shift_start))) / 60;
  if p_no_lunch is true then
    if p_lunch_out is not null or p_lunch_back is not null then
      raise exception 'Clear the two lunch times before confirming no unpaid lunch.';
    end if;
  elsif p_no_lunch is false then
    if p_lunch_out is null or p_lunch_back is null or p_lunch_out < date_trunc('minute',shift_start)
      or p_lunch_back > p_ended_at or p_lunch_back <= greatest(p_lunch_out,shift_start) then
      raise exception 'Enter both actual lunch times. Lunch Back must follow Lunch Out and fall within the shift.';
    end if;
    lunch_out := greatest(p_lunch_out,shift_start);
    unpaid := extract(epoch from (date_trunc('minute',p_lunch_back) - date_trunc('minute',lunch_out))) / 60;
    if unpaid < 1 then raise exception 'The two lunch times must include at least one payroll minute.'; end if;
  else
    raise exception 'Choose actual lunch times or explicitly confirm no unpaid lunch.';
  end if;
  if gross <= unpaid then raise exception 'The shift must have paid time remaining after lunch.'; end if;
  hours := round((gross-unpaid)::numeric / 60,2);
  select employee_name into manager from public.app_users where auth_user_id = auth.uid();

  perform set_config('gp.verified_shift_completion','yes',true);
  perform set_config('gp.verified_auto_clock_out','yes',true);
  perform set_config('gp.approved_clock_in','yes',true);
  insert into public.time_logs(auth_user_id,employee_name,department,work_date,clock_in,clock_out,
    break_minutes,decimal_hours,lunch_out_time,lunch_in_time,lunch_out_at,lunch_in_at,no_lunch_reason,
    lunch_review_status,lunch_review_note,clock_in_location,clock_in_coords,clock_out_location,notes,
    session_started_at_ms,session_ended_at,auto_clocked_out,clock_out_review_status,
    clocked_out_by,admin_clock_out_reason,approved_clock_in_at,clock_in_correction_id)
  values(review.auth_user_id,review.employee_name,review.session_snapshot->>'department',
    (shift_start at time zone 'America/New_York')::date,
    to_char(shift_start at time zone 'America/New_York','HH24:MI'),
    to_char(p_ended_at at time zone 'America/New_York','HH24:MI'),unpaid,hours,
    to_char(lunch_out at time zone 'America/New_York','HH24:MI'),
    to_char(p_lunch_back at time zone 'America/New_York','HH24:MI'),lunch_out,p_lunch_back,
    case when p_no_lunch then note end,case when p_no_lunch then 'approved' else 'not_required' end,
    case when p_no_lunch then note end,review.session_snapshot->>'clock_in_location',
    review.session_snapshot->>'clock_in_coords','Manager verified clock-out; location not captured',
    '[ADMIN CLOCK OUT by ' || manager || '] ' || note,
    review.session_started_at_ms,p_ended_at,true,'approved',auth.uid(),left(note,500),
    (review.session_snapshot->>'approved_clock_in_at')::timestamptz,
    (review.session_snapshot->>'clock_in_correction_id')::bigint)
  returning id into card_id;
  if exists(select 1 from public.time_logs where id = card_id
    and (decimal_hours::numeric is distinct from hours or break_minutes is distinct from unpaid)) then
    raise exception 'Saved totals disagree with elapsed minutes. Check the punch times before retrying.';
  end if;
  update public.gp_shift_close_reviews set status = 'approved', time_log_id = card_id,
    reviewed_by = auth.uid(), reviewed_at = clock_timestamp(), review_note = note where id = p_review_id;
  insert into public.audit_logs(actor_user_id,supervisor_name,action_type,details,"timestamp")
  values(auth.uid(),manager,'TIME_AUTO_CLOCK_OUT_REVIEW',jsonb_build_object(
    'review_id',p_review_id,'shift_id',card_id,'note',note,'actual_clock_out',p_ended_at,
    'lunch_out',lunch_out,'lunch_back',p_lunch_back,'no_lunch_confirmed',p_no_lunch,
    'break_minutes',unpaid,'decimal_hours',hours)::text,clock_timestamp());
  return card_id;
end $$;

revoke all on function public.gp_missed_clock_out_candidates(bigint),
  public.gp_resolve_missed_clock_out(bigint,timestamptz,timestamptz,timestamptz,boolean,text) from public,anon,authenticated;
grant execute on function public.gp_missed_clock_out_candidates(bigint),
  public.gp_resolve_missed_clock_out(bigint,timestamptz,timestamptz,timestamptz,boolean,text) to authenticated;
notify pgrst,'reload schema';
commit;
