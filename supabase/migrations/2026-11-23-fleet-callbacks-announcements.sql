-- Apply to the existing GLASSPRO project, after the core fleet and quote tables.
begin;

alter table public.fleet_vehicles
  add column if not exists asset_type text not null default 'vehicle'
    check (asset_type in ('vehicle', 'trailer')),
  add column if not exists tag_expires_on date,
  add column if not exists tag_renewed_on date;

create or replace function private.gp_can_view_fleet_photos()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.app_users
    where auth_user_id = (select auth.uid())
      and active is true
      and (to_jsonb(app_users)->>'archived_at') is null
      and (perm_admin is true or perm_vehicle_view is true)
  );
$$;

create or replace function private.gp_can_upload_fleet_photo(p_name text)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.gp_is_admin()
    and p_name ~ '^[a-zA-Z0-9-]+/[a-f0-9-]{36}\.(jpg|png|webp)$'
    and exists (select 1 from public.fleet_vehicles where id::text = split_part(p_name, '/', 1));
$$;

revoke all on function private.gp_can_view_fleet_photos(), private.gp_can_upload_fleet_photo(text) from public, anon;
grant execute on function private.gp_can_view_fleet_photos(), private.gp_can_upload_fleet_photo(text) to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('gp-fleet-photos', 'gp-fleet-photos', false, 5242880, array['image/jpeg','image/png','image/webp'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists gp_fleet_photo_read on storage.objects;
create policy gp_fleet_photo_read on storage.objects for select to authenticated
  using (bucket_id = 'gp-fleet-photos' and (select private.gp_can_view_fleet_photos()));
drop policy if exists gp_fleet_photo_add on storage.objects;
create policy gp_fleet_photo_add on storage.objects for insert to authenticated
  with check (bucket_id = 'gp-fleet-photos' and private.gp_can_upload_fleet_photo(name));
drop policy if exists gp_fleet_photo_remove on storage.objects;
create policy gp_fleet_photo_remove on storage.objects for delete to authenticated
  using (bucket_id = 'gp-fleet-photos' and (select private.gp_is_admin()));

create or replace function private.gp_guard_manager_callback()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or private.gp_is_admin() then
    return new;
  end if;
  if old.status = 'admin_review' and old.call_data->>'manager_close_required' = 'true' then
    if new.status is distinct from old.status or new.call_data is distinct from old.call_data
      or new.contact_attempts is distinct from old.contact_attempts then
      raise exception 'A manager must resolve this callback.' using errcode = '42501';
    end if;
  elsif new.call_data->>'manager_close_required' = 'true' and
      (old.status not in ('open','follow_up') or new.status <> 'admin_review') then
    raise exception 'Refresh this quote before sending it to a manager.';
  end if;
  return new;
end;
$$;
revoke all on function private.gp_guard_manager_callback() from public, anon, authenticated;
drop trigger if exists gp_guard_manager_callback on public.outstanding_quotes;
create trigger gp_guard_manager_callback before update on public.outstanding_quotes
  for each row execute function private.gp_guard_manager_callback();

create table if not exists public.gp_announcements (
  id uuid primary key default gen_random_uuid(),
  title text not null check (length(btrim(title)) between 1 and 120),
  body text not null check (length(btrim(body)) between 1 and 2000),
  pinned boolean not null default false,
  published_at timestamptz not null default now(),
  expires_at timestamptz check (expires_at > published_at),
  archived_at timestamptz,
  author_id uuid default auth.uid()
);

create or replace function private.gp_can_read_announcements()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.app_users where auth_user_id = (select auth.uid())
      and active is true and (to_jsonb(app_users)->>'archived_at') is null
  );
$$;

revoke all on function private.gp_can_read_announcements() from public, anon;
grant execute on function private.gp_can_read_announcements() to authenticated;
alter table public.gp_announcements enable row level security;
revoke all on public.gp_announcements from public, anon, authenticated;
grant select on public.gp_announcements to authenticated;
grant insert (title, body, pinned, expires_at), update (title, body, pinned, expires_at, archived_at)
  on public.gp_announcements to authenticated;
drop policy if exists gp_announcements_read on public.gp_announcements;
create policy gp_announcements_read on public.gp_announcements for select to authenticated
  using ((select private.gp_is_admin()) or (
    (select private.gp_can_read_announcements()) and archived_at is null
    and published_at <= now() and (expires_at is null or expires_at > now())
  ));
drop policy if exists gp_announcements_publish on public.gp_announcements;
create policy gp_announcements_publish on public.gp_announcements for insert to authenticated
  with check ((select private.gp_is_admin()));
drop policy if exists gp_announcements_edit on public.gp_announcements;
create policy gp_announcements_edit on public.gp_announcements for update to authenticated
  using ((select private.gp_is_admin())) with check ((select private.gp_is_admin()));

notify pgrst, 'reload schema';
commit;
