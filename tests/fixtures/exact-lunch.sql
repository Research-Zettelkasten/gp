-- GLASSPRO 2026.11.04.1: precise admin lunch punches.
-- Additive / safe for existing time_logs. Do not rerun full Auth/RLS setup.
-- Backup Supabase first. Run once in Supabase SQL Editor before updating GitHub.
begin;

alter table public.time_logs
  add column if not exists lunch_out_time text,
  add column if not exists lunch_in_time text;

-- A recorded lunch must have two valid local HH:MM punches. Older timecards
-- continue to have both columns NULL; their break_minutes are unchanged.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.time_logs'::regclass
      and conname = 'gp_time_lunch_pair_valid'
  ) then
    alter table public.time_logs add constraint gp_time_lunch_pair_valid
      check (
        (lunch_out_time is null and lunch_in_time is null)
        or (
          lunch_out_time is not null and lunch_in_time is not null
          and lunch_out_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
          and lunch_in_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
        )
      );
  end if;
end;
$$;

-- The database also verifies exact lunch chronology and recomputes payroll
-- minutes and decimal hours, so the server remains authoritative for a
-- manually entered lunch. Does not modify historical break-only timecards.
create or replace function public.gp_apply_exact_lunch()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  shift_start integer;
  shift_end integer;
  lunch_start integer;
  lunch_end integer;
begin
  if new.lunch_out_time is null and new.lunch_in_time is null then
    return new;
  end if;

  if new.lunch_out_time is null or new.lunch_in_time is null
     or new.lunch_out_time !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
     or new.lunch_in_time !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
  then
    raise exception 'Enter both valid HH:MM Lunch Out and Lunch Back values.';
  end if;

  if coalesce(new.clock_in, '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
     or coalesce(new.clock_out, '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
  then
    raise exception 'Exact lunch records require HH:MM shift clock-in and clock-out.';
  end if;

  shift_start := substring(new.clock_in from 1 for 2)::integer * 60
               + substring(new.clock_in from 4 for 2)::integer;
  shift_end := substring(new.clock_out from 1 for 2)::integer * 60
             + substring(new.clock_out from 4 for 2)::integer;
  if shift_end < shift_start then shift_end := shift_end + 1440; end if;
  if shift_end <= shift_start then
    raise exception 'Clock-in and clock-out must not be the same time.';
  end if;

  lunch_start := substring(new.lunch_out_time from 1 for 2)::integer * 60
               + substring(new.lunch_out_time from 4 for 2)::integer;
  lunch_end := substring(new.lunch_in_time from 1 for 2)::integer * 60
             + substring(new.lunch_in_time from 4 for 2)::integer;
  if lunch_start < shift_start then lunch_start := lunch_start + 1440; end if;
  if lunch_end < shift_start then lunch_end := lunch_end + 1440; end if;
  if lunch_end <= lunch_start then lunch_end := lunch_end + 1440; end if;

  if lunch_start < shift_start or lunch_end > shift_end or lunch_end <= lunch_start then
    raise exception 'Lunch must be within shift times; Lunch Back must be after Lunch Out.';
  end if;

  new.break_minutes := lunch_end - lunch_start;
  new.decimal_hours := round((shift_end - shift_start - new.break_minutes)::numeric / 60, 2);
  return new;
end;
$$;

drop trigger if exists gp_time_exact_lunch on public.time_logs;
create trigger gp_time_exact_lunch
  before insert or update of clock_in, clock_out, lunch_out_time, lunch_in_time, break_minutes, decimal_hours
  on public.time_logs
  for each row execute function public.gp_apply_exact_lunch();

comment on column public.time_logs.lunch_out_time is 'Exact admin-recorded lunch start in worksite local HH:MM time; NULL for legacy/manual break-only records.';
comment on column public.time_logs.lunch_in_time is 'Exact admin-recorded lunch return in worksite local HH:MM time; NULL for legacy/manual break-only records.';

commit;