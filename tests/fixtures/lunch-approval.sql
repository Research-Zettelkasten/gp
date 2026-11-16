-- GLASSPRO 2026.11.12.2 — exact employee lunch punches + no-lunch manager approval.
-- Run AFTER existing Auth/RLS and exact-lunch migrations. Designed to be additive.
-- Important: deploy the matching frontend in the same maintenance window.
-- Never use this in place of the original full schema or turn off RLS.
begin;

alter table public.active_time_sessions
  add column if not exists lunch_out_at timestamptz,
  add column if not exists lunch_in_at timestamptz;

alter table public.time_logs
  add column if not exists lunch_out_time text,
  add column if not exists lunch_in_time text,
  add column if not exists lunch_out_at timestamptz,
  add column if not exists lunch_in_at timestamptz,
  add column if not exists no_lunch_reason text,
  add column if not exists lunch_review_status text not null default 'not_required',
  add column if not exists lunch_review_note text,
  add column if not exists lunch_reviewed_by uuid references auth.users(id) on delete set null,
  add column if not exists lunch_reviewed_at timestamptz;

-- Existing historical shifts remain not_required; no retroactive approval task is created.
update public.time_logs set lunch_review_status = 'not_required'
 where lunch_review_status is null;

-- Server guards: only completed lunch punches are accepted as normal employee shifts;
-- no-lunch shifts require a meaningful explanation and remain pending manager review.
create or replace function public.gp_guard_time_lunch_review()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_admin boolean;
begin
  if (select auth.uid()) is null then return new; end if; -- trusted SQL Editor backfills
  v_admin := private.gp_is_admin();
  if coalesce(new.break_minutes,0) < 0 then
    raise exception 'Break minutes cannot be negative.';
  end if;
  if (new.lunch_out_at is null) <> (new.lunch_in_at is null) then
    raise exception 'Both exact lunch timestamps are required together.';
  end if;
  if new.lunch_out_at is not null and new.lunch_in_at <= new.lunch_out_at then
    raise exception 'Lunch Back must be after Lunch Out.';
  end if;
  if tg_op = 'INSERT' and not v_admin then
    if coalesce(new.break_minutes,0) = 0 then
      if length(btrim(coalesce(new.no_lunch_reason,''))) < 10 then
        raise exception 'No-lunch shifts require an explanation of at least 10 characters.';
      end if;
      new.lunch_review_status := 'pending';
    else
      if nullif(btrim(coalesce(new.lunch_out_time,'')), '') is null
        or nullif(btrim(coalesce(new.lunch_in_time,'')), '') is null then
        raise exception 'Exact Lunch Out and Lunch Back times are required for paid shifts with an unpaid lunch.';
      end if;
      new.no_lunch_reason := null;
      new.lunch_review_status := 'not_required';
    end if;
    new.lunch_review_note := null;
    new.lunch_reviewed_by := null;
    new.lunch_reviewed_at := null;
  elsif tg_op = 'UPDATE' and not v_admin then
    -- Existing policy already denies employee timecard updates; extra defense in depth.
    if new.lunch_review_status is distinct from old.lunch_review_status
       or new.lunch_review_note is distinct from old.lunch_review_note
       or new.lunch_reviewed_by is distinct from old.lunch_reviewed_by
       or new.lunch_reviewed_at is distinct from old.lunch_reviewed_at then
      raise exception 'Only a manager can review no-lunch exceptions.';
    end if;
  elsif v_admin then
    if tg_op='UPDATE' and new.lunch_review_status is distinct from old.lunch_review_status then
      if new.lunch_review_status in ('approved','rejected') then
        if length(btrim(coalesce(new.lunch_review_note,''))) < 10 then
          raise exception 'Manager review notes must be at least 10 characters.';
        end if;
        new.lunch_reviewed_by := (select auth.uid());
        new.lunch_reviewed_at := clock_timestamp();
      elsif new.lunch_review_status='not_required' then
        new.lunch_reviewed_by := null;
        new.lunch_reviewed_at := null;
      end if;
    elsif tg_op='INSERT' and new.lunch_review_status='approved' then
      if length(btrim(coalesce(new.lunch_review_note,''))) < 10 then
        raise exception 'An administratively approved no-lunch shift requires a manager audit note.';
      end if;
      new.lunch_reviewed_by := (select auth.uid());
      new.lunch_reviewed_at := clock_timestamp();
    end if;
  end if;
  if new.lunch_review_status not in ('not_required','pending','approved','rejected') then
    raise exception 'Invalid lunch review status.';
  end if;
  return new;
end;
$$;

drop trigger if exists gp_time_lunch_review_guard on public.time_logs;
create trigger gp_time_lunch_review_guard
before insert or update on public.time_logs
for each row execute function public.gp_guard_time_lunch_review();

-- Block client-side editing of server-issued lunch punches. Only the two RPCs below
-- set this transaction-local flag while changing the precise event timestamps.
create or replace function public.gp_guard_active_lunch_fields()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if (select auth.uid()) is not null and not private.gp_is_admin()
    and (
      new.lunch_out_at is distinct from old.lunch_out_at or
      new.lunch_in_at is distinct from old.lunch_in_at or
      new.break_minutes is distinct from old.break_minutes
    ) and coalesce(current_setting('gp.verified_lunch_punch',true),'') <> 'yes' then
    raise exception 'Use Start Lunch or Return from Lunch; lunch timestamps cannot be edited directly.';
  end if;
  return new;
end;
$$;

drop trigger if exists gp_active_lunch_guard on public.active_time_sessions;
create trigger gp_active_lunch_guard
before update on public.active_time_sessions
for each row execute function public.gp_guard_active_lunch_fields();

create or replace function public.gp_start_lunch()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_row public.active_time_sessions%rowtype;
begin
  if (select auth.uid()) is null or not private.gp_has_permission('time') then
    raise exception 'An active time-clock account is required.';
  end if;
  perform set_config('gp.verified_lunch_punch','yes',true);
  update public.active_time_sessions s
     set lunch_out_at = clock_timestamp(), updated_at=clock_timestamp()
   where s.auth_user_id=(select auth.uid())
     and s.lunch_out_at is null
     and s.started_at <= clock_timestamp()
   returning s.* into v_row;
  if not found then
    raise exception 'Cannot start lunch. You are not clocked in or lunch is already recorded.';
  end if;
  return jsonb_build_object('started_at_ms',v_row.started_at_ms,
     'lunch_out_at',v_row.lunch_out_at,'lunch_in_at',v_row.lunch_in_at,
     'break_minutes',v_row.break_minutes);
end;
$$;

create or replace function public.gp_end_lunch()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_row public.active_time_sessions%rowtype;
begin
  if (select auth.uid()) is null or not private.gp_has_permission('time') then
    raise exception 'An active time-clock account is required.';
  end if;
  perform set_config('gp.verified_lunch_punch','yes',true);
  update public.active_time_sessions s
     set lunch_in_at = clock_timestamp(),
         break_minutes = greatest(1,round(extract(epoch from (clock_timestamp()-s.lunch_out_at))/60)::integer),
         updated_at=clock_timestamp()
   where s.auth_user_id=(select auth.uid())
     and s.lunch_out_at is not null and s.lunch_in_at is null
     and s.lunch_out_at <= clock_timestamp()
   returning s.* into v_row;
  if not found then
    raise exception 'Cannot return from lunch. No lunch is currently in progress.';
  end if;
  return jsonb_build_object('started_at_ms',v_row.started_at_ms,
     'lunch_out_at',v_row.lunch_out_at,'lunch_in_at',v_row.lunch_in_at,
     'break_minutes',v_row.break_minutes);
end;
$$;

revoke all on function public.gp_start_lunch() from public,anon;
revoke all on function public.gp_end_lunch() from public,anon;
grant execute on function public.gp_start_lunch() to authenticated;
grant execute on function public.gp_end_lunch() to authenticated;

-- Preserve all existing RLS policies. No data truncation, table drops, or mass
-- status modifications are performed by this migration.
commit;