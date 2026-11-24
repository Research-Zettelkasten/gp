\set ON_ERROR_STOP on
do $$begin
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role bypassrls; end if;
end$$;
\ir ../supabase/migrations/2026-11-23-announcement-web-push.sql
\ir ../supabase/migrations/2026-11-23-announcement-web-push.sql

create function pg_temp.assert_push(ok boolean, message text) returns void language plpgsql as $$
begin
  if ok is distinct from true then raise exception 'ASSERTION FAILED: %',message; end if;
end$$;
create function pg_temp.push_expected_error(statement text, expected text) returns void language plpgsql as $$
begin
  begin execute statement; exception when others then
    if position(expected in sqlerrm) > 0 then return; else raise; end if;
  end;
  raise exception 'Expected error containing %', expected;
end$$;

insert into public.gp_announcements(id,title,body) values
 ('80000000-0000-0000-0000-000000000001','Synthetic push notice','Private announcement content'),
 ('80000000-0000-0000-0000-000000000002','Archived push notice','Private announcement content');
update public.gp_announcements set archived_at=now() where id='80000000-0000-0000-0000-000000000002';

select set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',false);
set role authenticated;
select public.gp_save_push_device('https://fcm.googleapis.com/fcm/send/fixture',repeat('a',87),repeat('b',22));
select public.gp_save_push_device('https://web.push.apple.com/fixture',repeat('a',87),repeat('b',22));
select public.gp_save_push_device('https://web.push.apple.com/fixture',repeat('a',87),repeat('b',22));
select pg_temp.push_expected_error($q$select public.gp_save_push_device('https://web.push.apple.com.example.test/private',repeat('a',87),repeat('b',22))$q$,'unsupported push');
select pg_temp.push_expected_error($q$select * from public.gp_push_devices$q$,'permission denied');
select pg_temp.push_expected_error($q$select public.gp_claim_announcement_push('80000000-0000-0000-0000-000000000001','11111111-1111-4111-8111-111111111111')$q$,'permission denied');
reset role;

select set_config('request.jwt.claim.sub','33333333-3333-4333-8333-333333333333',false);
set role authenticated;
select public.gp_remove_push_device('https://web.push.apple.com/fixture');
select pg_temp.push_expected_error($q$select public.gp_save_push_device('https://web.push.apple.com/fixture',repeat('c',87),repeat('d',22))$q$,'Reset notifications');
reset role;

set role service_role;
select pg_temp.push_expected_error($q$select public.gp_claim_announcement_push('80000000-0000-0000-0000-000000000001','33333333-3333-4333-8333-333333333333')$q$,'Only an active administrator');
select pg_temp.push_expected_error($q$select public.gp_claim_announcement_push('80000000-0000-0000-0000-000000000002','11111111-1111-4111-8111-111111111111')$q$,'still active');
select pg_temp.assert_push((select count(*)=2 and bool_and(attempts=1 and ttl=3600) from public.gp_claim_announcement_push('80000000-0000-0000-0000-000000000001','11111111-1111-4111-8111-111111111111')),'initial claim has each opted-in device exactly once');
select pg_temp.assert_push((select count(*)=0 from public.gp_claim_announcement_push('80000000-0000-0000-0000-000000000001','11111111-1111-4111-8111-111111111111')),'simultaneous send cannot claim in-flight devices');
update public.gp_push_deliveries set state='sent' where device_id=(select id from public.gp_push_devices where endpoint like '%googleapis.com%');
update public.gp_push_deliveries set state='retry', updated_at=now()-interval '2 minutes' where state='sending';
select pg_temp.assert_push((select count(*)=1 and bool_and(endpoint='https://web.push.apple.com/fixture' and attempts=2) from public.gp_claim_announcement_push('80000000-0000-0000-0000-000000000001','11111111-1111-4111-8111-111111111111')),'retry skips devices already accepted');
select pg_temp.assert_push((public.gp_announcement_push_summary('80000000-0000-0000-0000-000000000001')->>'accepted')::integer=1,'safe delivery count available to sender');
reset role;

select set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',false);
set role authenticated;
select public.gp_remove_push_device('https://web.push.apple.com/fixture');
reset role;
set role service_role;
select pg_temp.assert_push((select count(*)=1 from public.gp_push_devices),'owner can remove the opted-in device');
select pg_temp.assert_push((select count(*)=0 from public.gp_claim_announcement_push('80000000-0000-0000-0000-000000000001','11111111-1111-4111-8111-111111111111')),'opted-out device never retried');
select pg_temp.assert_push((public.gp_announcement_push_summary('80000000-0000-0000-0000-000000000001')->>'unavailable')::integer=1,'removed device retained only as an unavailable delivery');
reset role;
select 'PASS: device consent, administrator gate, endpoint restrictions, claims and opt-out';

-- Substitute only the Vault interface on this disposable database. The deployed
-- instance uses Supabase Vault to encrypt the persisted signing keys.
create schema vault;
create table vault.decrypted_secrets (id uuid default gen_random_uuid(),name text unique,decrypted_secret text);
create function vault.create_secret(secret text, name text, description text)
returns uuid language sql as $$
  insert into vault.decrypted_secrets(name,decrypted_secret) values($2,$1) returning id;
$$;
\ir ../supabase/migrations/2026-11-24-web-push-vault-keys.sql
begin;

set role authenticated;
select pg_temp.push_expected_error($q$select public.gp_push_vault_keys(repeat('a',87),repeat('b',43))$q$,'permission denied');
reset role;
set role service_role;
select pg_temp.push_expected_error($q$select public.gp_push_vault_keys(repeat('a',87),repeat('b',43))$q$,'Restore the original');
reset role;
delete from public.gp_push_devices;
set role service_role;
select pg_temp.assert_push(public.gp_push_vault_keys(repeat('a',87),repeat('b',43))->>'publicKey'=repeat('a',87),'first setup stores a keypair');
select pg_temp.assert_push(public.gp_push_vault_keys(repeat('c',87),repeat('d',43))->>'publicKey'=repeat('a',87),'later Edge instances reuse the same keypair');
reset role;
select pg_temp.assert_push((select count(*)=1 from vault.decrypted_secrets),'initializer creates one Vault entry');
rollback;
