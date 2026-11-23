-- Apply after 2026-11-23-fleet-callbacks-announcements.sql.
begin;

create table if not exists public.gp_push_devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth_key text not null,
  registered_at timestamptz not null default clock_timestamp()
);

create table if not exists public.gp_push_audiences (
  announcement_id uuid primary key references public.gp_announcements(id) on delete cascade,
  requested_by uuid references auth.users(id) on delete set null,
  requested_at timestamptz not null default now()
);

create table if not exists public.gp_push_deliveries (
  id bigint generated always as identity primary key,
  announcement_id uuid not null references public.gp_push_audiences(announcement_id) on delete cascade,
  device_id uuid references public.gp_push_devices(id) on delete set null,
  registered_at timestamptz not null,
  state text not null default 'queued'
    check (state in ('queued', 'sending', 'sent', 'retry', 'unavailable')),
  attempts integer not null default 0,
  updated_at timestamptz not null default now(),
  unique (announcement_id, device_id)
);

alter table public.gp_push_devices enable row level security;
alter table public.gp_push_audiences enable row level security;
alter table public.gp_push_deliveries enable row level security;
revoke all on public.gp_push_devices, public.gp_push_audiences, public.gp_push_deliveries from public, anon, authenticated;
revoke all on sequence public.gp_push_deliveries_id_seq from public, anon, authenticated;
grant select, delete on public.gp_push_devices to service_role;
grant select, update on public.gp_push_deliveries to service_role;
create index if not exists gp_push_delivery_queue on public.gp_push_deliveries(announcement_id, state, id);
create index if not exists gp_push_delivery_device on public.gp_push_deliveries(device_id);

create or replace function public.gp_save_push_device(p_endpoint text, p_p256dh text, p_auth_key text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or not private.gp_can_read_announcements() then
    raise exception 'An active staff account is required.' using errcode = '42501';
  end if;
  if p_endpoint is null or length(p_endpoint) > 2048
      or p_endpoint !~ '^https://(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|[a-z0-9-]+(\.[a-z0-9-]+)*\.(push\.apple\.com|notify\.windows\.com))/[^[:space:]#]+$'
      or coalesce(p_p256dh, '') !~ '^[A-Za-z0-9_-]{87}$'
      or coalesce(p_auth_key, '') !~ '^[A-Za-z0-9_-]{22}$' then
    raise exception 'The browser supplied an unsupported push subscription.';
  end if;
  insert into public.gp_push_devices(user_id, endpoint, p256dh, auth_key)
  values (auth.uid(), p_endpoint, p_p256dh, p_auth_key)
  on conflict (endpoint) do update
  set user_id = excluded.user_id, p256dh = excluded.p256dh, auth_key = excluded.auth_key,
      registered_at = case
        when gp_push_devices.user_id is distinct from excluded.user_id
          or gp_push_devices.p256dh is distinct from excluded.p256dh
          or gp_push_devices.auth_key is distinct from excluded.auth_key
        then clock_timestamp() else gp_push_devices.registered_at end
  where gp_push_devices.user_id = excluded.user_id or
    (gp_push_devices.p256dh = excluded.p256dh and gp_push_devices.auth_key = excluded.auth_key);
  if not found then raise exception 'Reset notifications on this device and try again.'; end if;
end;
$$;

create or replace function public.gp_remove_push_device(p_endpoint text)
returns void language sql security definer set search_path = '' as $$
  delete from public.gp_push_devices where user_id = auth.uid() and endpoint = p_endpoint;
$$;

revoke all on function public.gp_save_push_device(text,text,text), public.gp_remove_push_device(text) from public, anon;
grant execute on function public.gp_save_push_device(text,text,text), public.gp_remove_push_device(text) to authenticated;

create or replace function public.gp_claim_announcement_push(p_announcement uuid, p_admin uuid)
returns table(delivery_id text, device_id uuid, registered_at timestamptz, endpoint text,
              p256dh text, auth_key text, attempts integer, ttl integer)
language plpgsql security definer set search_path = '' as $$
declare
  expiry timestamptz;
  remaining_seconds integer;
begin
  if not exists (
    select 1 from public.app_users u where u.auth_user_id = p_admin
       and u.active is true and u.perm_admin is true and (to_jsonb(u)->>'archived_at') is null
  ) then
    raise exception 'Only an active administrator can notify devices.' using errcode = '42501';
  end if;

  -- Serialize audience creation and batch claims for a given notice.
  select n.expires_at into expiry from public.gp_announcements n
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
    where exists (
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

create or replace function public.gp_announcement_push_summary(p_announcement uuid)
returns jsonb language sql security definer set search_path = '' as $$
  select jsonb_build_object(
    'accepted', count(*) filter (where state = 'sent'),
    'queued', count(*) filter (where state = 'queued'),
    'sending', count(*) filter (where state = 'sending'),
    'retry', count(*) filter (where state = 'retry'),
    'unavailable', count(*) filter (where state = 'unavailable')
  ) from public.gp_push_deliveries where announcement_id = p_announcement;
$$;

revoke all on function public.gp_claim_announcement_push(uuid,uuid), public.gp_announcement_push_summary(uuid) from public, anon, authenticated;
grant execute on function public.gp_claim_announcement_push(uuid,uuid), public.gp_announcement_push_summary(uuid) to service_role;

notify pgrst, 'reload schema';
commit;
