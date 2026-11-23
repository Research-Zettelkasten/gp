-- Requires the live-punch approval migration. Safe to rerun.
begin;
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
