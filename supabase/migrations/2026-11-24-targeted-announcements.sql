-- Add private, single-employee announcements and target their registered devices.
begin;

alter table public.gp_announcements add column if not exists recipient_user_id uuid
  references auth.users(id) on delete cascade;
grant insert (recipient_user_id) on public.gp_announcements to authenticated;
create index if not exists gp_announcements_recipient on public.gp_announcements(recipient_user_id)
  where recipient_user_id is not null;
create index if not exists gp_announcements_pending_expiration on public.gp_announcements(expires_at)
  where archived_at is null and expires_at is not null;

drop policy if exists gp_announcements_read on public.gp_announcements;
create policy gp_announcements_read on public.gp_announcements for select to authenticated
using ((select private.gp_is_admin()) or (
  (select private.gp_can_read_announcements()) and archived_at is null
  and published_at <= now() and (expires_at is null or expires_at > now())
  and (recipient_user_id is null or recipient_user_id = (select auth.uid()))
));

drop policy if exists gp_announcements_publish on public.gp_announcements;
create policy gp_announcements_publish on public.gp_announcements for insert to authenticated
with check ((select private.gp_is_admin()) and (recipient_user_id is null or exists (
  select 1 from public.app_users u where u.auth_user_id = recipient_user_id
    and u.active is true and (to_jsonb(u)->>'archived_at') is null
)));

create or replace function public.gp_claim_announcement_push(p_announcement uuid, p_admin uuid)
returns table(delivery_id text, device_id uuid, registered_at timestamptz, endpoint text,
              p256dh text, auth_key text, attempts integer, ttl integer)
language plpgsql security definer set search_path = '' as $$
declare
  expiry timestamptz;
  recipient uuid;
  remaining_seconds integer;
begin
  if not exists (
    select 1 from public.app_users u where u.auth_user_id = p_admin
       and u.active is true and u.perm_admin is true and (to_jsonb(u)->>'archived_at') is null
  ) then
    raise exception 'Only an active administrator can notify devices.' using errcode = '42501';
  end if;

  -- Serialize audience creation and batch claims for a given notice.
  select n.expires_at, n.recipient_user_id into expiry, recipient from public.gp_announcements n
  where n.id = p_announcement and n.archived_at is null and n.published_at <= now()
    and (n.expires_at is null or n.expires_at > now())
  for update;
  if not found then
    raise exception 'Choose a published announcement that is still active.' using errcode = '22023';
  end if;
  remaining_seconds := least(3600, coalesce(floor(extract(epoch from expiry - now())), 3600))::integer;

  insert into public.gp_push_audiences(announcement_id, requested_by) values (p_announcement, p_admin)
  on conflict (announcement_id) do nothing;
  if found then
    insert into public.gp_push_deliveries(announcement_id, device_id, registered_at)
    select p_announcement, d.id, d.registered_at
    from public.gp_push_devices d
    where (recipient is null or d.user_id = recipient) and exists (
      select 1 from public.app_users u where u.auth_user_id = d.user_id
        and u.active is true and (to_jsonb(u)->>'archived_at') is null
    );
    -- With no subscribers, let a later request set the first audience.
    if not found then
      delete from public.gp_push_audiences a where a.announcement_id = p_announcement;
      return;
    end if;
  end if;
  update public.gp_push_deliveries l set state = 'unavailable', updated_at = now()
  where l.announcement_id = p_announcement and l.state in ('queued', 'retry', 'sending')
    and (
      (l.attempts >= 3 and (l.state <> 'sending' or l.updated_at < now() - interval '5 minutes'))
      or not exists (
        select 1 from public.gp_push_devices d join public.app_users u on u.auth_user_id = d.user_id
        where d.id = l.device_id and d.registered_at = l.registered_at
          and (recipient is null or d.user_id = recipient)
          and u.active is true and (to_jsonb(u)->>'archived_at') is null
      )
    );
  return query
  with candidates as (
    select l.id from public.gp_push_deliveries l
    where l.announcement_id = p_announcement and l.attempts < 3 and (
      l.state = 'queued' or (l.state = 'retry' and l.updated_at < now() - interval '1 minute')
      or (l.state = 'sending' and l.updated_at < now() - interval '5 minutes')
    )
    order by l.id limit 24
  ), claimed as (
    update public.gp_push_deliveries l set state = 'sending', attempts = l.attempts + 1, updated_at = now()
    from candidates c where l.id = c.id returning l.*
  )
  select l.id::text, d.id, d.registered_at, d.endpoint, d.p256dh, d.auth_key, l.attempts, remaining_seconds
  from claimed l join public.gp_push_devices d on d.id = l.device_id and d.registered_at = l.registered_at;
end;
$$;

revoke all on function public.gp_claim_announcement_push(uuid,uuid) from public, anon, authenticated;
grant execute on function public.gp_claim_announcement_push(uuid,uuid) to service_role;

create or replace function private.gp_audit_announcement()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  actor_name text;
  event_name text;
begin
  if tg_op = 'INSERT' then
    event_name := 'ANNOUNCEMENT_PUBLISHED';
  elsif new is not distinct from old then
    return new;
  elsif new.archived_at is not null and old.archived_at is null then
    event_name := case when new.expires_at <= new.archived_at then 'ANNOUNCEMENT_EXPIRED' else 'ANNOUNCEMENT_ARCHIVED' end;
  else
    event_name := 'ANNOUNCEMENT_EDITED';
  end if;
  select employee_name into actor_name from public.app_users where auth_user_id = actor;
  insert into public.audit_logs(actor_user_id,supervisor_name,action_type,details,"timestamp")
  values (actor,coalesce(actor_name,'GLASSPRO announcements'),event_name,jsonb_build_object(
    'announcement_id',new.id,'title',new.title,'message',new.body,'recipient_user_id',new.recipient_user_id,
    'published_at',new.published_at,'expires_at',new.expires_at,'archived_at',new.archived_at
  )::text,clock_timestamp());
  return new;
end $$;

drop trigger if exists gp_audit_announcement on public.gp_announcements;
create trigger gp_audit_announcement after insert or update on public.gp_announcements
for each row execute function private.gp_audit_announcement();

create or replace function private.gp_expire_announcements()
returns integer language plpgsql security definer set search_path = '' as $$
declare
  cleared integer;
begin
  with expired as (
    update public.gp_announcements set archived_at = expires_at
    where archived_at is null and expires_at <= statement_timestamp()
    returning id
  ), stopped as (
    update public.gp_push_deliveries d set state = 'unavailable', updated_at = statement_timestamp()
    from expired e where d.announcement_id = e.id and d.state in ('queued','retry','sending')
  )
  select count(*) into cleared from expired;
  return cleared;
end $$;

revoke all on function private.gp_audit_announcement(), private.gp_expire_announcements()
  from public, anon, authenticated;
do $$begin
  if to_regprocedure('cron.schedule(text,text,text)') is not null then
    perform cron.schedule('glasspro-expire-announcements','* * * * *','select private.gp_expire_announcements();');
  end if;
end $$;

notify pgrst, 'reload schema';
commit;
