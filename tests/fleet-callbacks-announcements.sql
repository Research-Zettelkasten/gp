\set ON_ERROR_STOP on
\ir fixtures/collections-base.sql
alter table public.app_users add column perm_vehicle_view boolean not null default false;
update public.app_users set perm_vehicle_view=true where auth_user_id='22222222-2222-4222-8222-222222222222';

create table public.fleet_vehicles (id bigint primary key);
insert into public.fleet_vehicles values (800);
create schema storage;
create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects (bucket_id text, name text);
alter table storage.objects enable row level security;
grant usage on schema storage to authenticated;
grant select, insert, delete on storage.objects to authenticated;
grant select, update on public.outstanding_quotes to authenticated;

\ir ../supabase/migrations/2026-11-23-fleet-callbacks-announcements.sql
\ir ../supabase/migrations/2026-11-23-fleet-callbacks-announcements.sql

create function pg_temp.check_that(ok boolean, message text) returns void language plpgsql as $$
begin
  if ok is distinct from true then raise exception 'ASSERTION FAILED: %',message; end if;
end$$;
create function pg_temp.expect_denied(statement text) returns void language plpgsql as $$
begin
  begin execute statement; exception when insufficient_privilege then return; end;
  raise exception 'Expected permission refusal: %', statement;
end$$;

select pg_temp.check_that((select asset_type='vehicle' and tag_expires_on is null from public.fleet_vehicles where id=800),'existing vehicles backfill safely');
insert into public.fleet_vehicles (id,asset_type,tag_expires_on) values (801,'trailer',current_date+10);
select pg_temp.check_that((select not public and file_size_limit=5242880 from storage.buckets where id='gp-fleet-photos'),'private bucket restricts upload size');
insert into public.outstanding_quotes(quote_number,customer_name,status,contact_attempts,call_data) values (900,'Synthetic customer','open',0,'{}');

select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',false);
set role authenticated;
insert into public.gp_announcements(title,body,pinned) values ('Staff notice','A synthetic message',true);
insert into public.gp_announcements(title,body,expires_at) values ('Archived notice','Synthetic archived announcement',now()+interval '1 day');
update public.gp_announcements set archived_at=now() where title='Archived notice';
select pg_temp.check_that((select count(*)=2 from public.gp_announcements),'admin can see archived notices');
insert into storage.objects values ('gp-fleet-photos','801/12345678-abcd-1234-abcd-123456789000.jpg');
select pg_temp.expect_denied($q$insert into storage.objects values ('gp-fleet-photos','999/12345678-abcd-1234-abcd-123456789000.jpg')$q$);
reset role;

select set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',false);
set role authenticated;
select pg_temp.check_that((select count(*)=1 and bool_and(title='Staff notice') from public.gp_announcements),'staff only see published current notices');
select pg_temp.expect_denied($q$insert into public.gp_announcements(title,body) values ('Staff post','Unauthorized')$q$);
select pg_temp.check_that((select count(*)=1 from storage.objects),'fleet viewer can read photos');
select pg_temp.expect_denied($q$insert into storage.objects values ('gp-fleet-photos','801/12345678-abcd-1234-abcd-123456789001.jpg')$q$);
select pg_temp.check_that((public.gp_request_manager_callback(900,'Review price','phone')->>'status')='admin_review','callback routes through the database');
select pg_temp.check_that((select contact_attempts=1 and call_data->>'manager_note'='Review price' from public.outstanding_quotes where quote_number=900),'handoff records actual contact method and notes');
select pg_temp.expect_denied($q$update public.outstanding_quotes set status='won' where quote_number=900$q$);
select pg_temp.expect_denied($q$update public.outstanding_quotes set call_data='{}' where quote_number=900$q$);
reset role;

select set_config('request.jwt.claim.sub','33333333-3333-4333-8333-333333333333',false);
set role authenticated;
select pg_temp.check_that((select count(*)=0 from storage.objects),'non-fleet user cannot read photos');
reset role;

select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',false);
set role authenticated;
update public.outstanding_quotes set status='won' where quote_number=900;
select pg_temp.check_that((select status='won' from public.outstanding_quotes where quote_number=900),'manager can close quote');
delete from storage.objects where bucket_id='gp-fleet-photos';
select pg_temp.check_that((select count(*)=0 from storage.objects),'manager can delete attached photo');
reset role;
select 'PASS: fleet defaults, private photos, staff announcements and manager handoff permissions';
