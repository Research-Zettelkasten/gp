\set ON_ERROR_STOP on
do $$begin if current_database() <> 'gp_operations_test' then raise exception 'Use disposable gp_operations_test'; end if; end$$;
grant select on public.app_users to authenticated;
\ir ../supabase/migrations/2026-11-24-targeted-announcements.sql
\ir ../supabase/migrations/2026-11-24-targeted-announcements.sql

create function pg_temp.assert_notice(ok boolean, message text) returns void language plpgsql as $$
begin if not coalesce(ok,false) then raise exception 'ASSERTION FAILED: %',message; end if; end $$;
create function pg_temp.expect_denied(statement text) returns void language plpgsql as $$
begin
  begin execute statement; exception when insufficient_privilege then return; end;
  raise exception 'Expected permission refusal: %',statement;
end $$;

begin;
\set manager '11111111-1111-4111-8111-111111111111'
\set recipient '22222222-2222-4222-8222-222222222222'
\set other '33333333-3333-4333-8333-333333333333'
\set inactive '44444444-4444-4444-8444-444444444444'
select set_config('request.jwt.claim.sub',:'manager',false);
set local role authenticated;
insert into public.gp_announcements(title,body,recipient_user_id)
  values ('One employee','Synthetic private announcement',:'recipient') returning id as private_id \gset
select pg_temp.expect_denied(format('update public.gp_announcements set recipient_user_id=null where id=%L', :'private_id'));
select pg_temp.expect_denied(format(
  'insert into public.gp_announcements(title,body,recipient_user_id) values (%L,%L,%L)',
  'Inactive recipient','Do not publish to an inactive account', :'inactive'));
reset role;

select set_config('request.jwt.claim.sub',:'recipient',false);
set local role authenticated;
select public.gp_save_push_device('https://web.push.apple.com/announcement-recipient',repeat('A',87),repeat('B',22));
select pg_temp.assert_notice((select count(*)=1 from public.gp_announcements where id=:'private_id'),
  'the recipient can read the private announcement');
reset role;

select set_config('request.jwt.claim.sub',:'other',false);
set local role authenticated;
select public.gp_save_push_device('https://web.push.apple.com/announcement-other',repeat('C',87),repeat('D',22));
select pg_temp.assert_notice((select count(*)=0 from public.gp_announcements where id=:'private_id'),
  'another employee cannot read the private announcement');
select pg_temp.expect_denied(format('select public.gp_claim_announcement_push(%L,%L)', :'private_id', :'manager'));
reset role;

set local role service_role;
select pg_temp.assert_notice((select count(*) > 0 and bool_and(
    endpoint not in ('https://web.push.apple.com/announcement-other','https://web.push.apple.com/other-location-test'))
  from public.gp_claim_announcement_push(:'private_id',:'manager')), 'only the recipient devices receive the alert');
reset role;
select pg_temp.assert_notice((select count(*)=0 from public.gp_push_deliveries l join public.gp_push_devices d on d.id=l.device_id
  where l.announcement_id=:'private_id' and d.user_id <> :'recipient'), 'the audience does not contain another user');

select set_config('request.jwt.claim.sub',:'manager',false);
insert into public.gp_announcements(title,body,published_at,expires_at,recipient_user_id)
  values ('Expires','Synthetic expired announcement',statement_timestamp()-interval '1 hour',statement_timestamp()-interval '1 minute',
    :'recipient') returning id as expire_id \gset
insert into public.gp_push_audiences(announcement_id,requested_by) values (:'expire_id',:'manager');
insert into public.gp_push_deliveries(announcement_id,device_id,registered_at)
  select :'expire_id',id,registered_at from public.gp_push_devices where endpoint='https://web.push.apple.com/announcement-recipient';

select set_config('request.jwt.claim.sub',:'recipient',false);
set local role authenticated;
select pg_temp.assert_notice((select count(*)=0 from public.gp_announcements where id=:'expire_id'),'expiration immediately hides it from the recipient');
select pg_temp.expect_denied('select private.gp_expire_announcements()');
reset role;
select set_config('request.jwt.claim.sub','',false);
select pg_temp.assert_notice(private.gp_expire_announcements() >= 1,'expiration worker archived the overdue message');
select pg_temp.assert_notice(private.gp_expire_announcements() = 0,'expiration worker is idempotent');
select pg_temp.assert_notice((select archived_at=expires_at from public.gp_announcements where id=:'expire_id'),
  'the announcement stays available as an archived record');
select pg_temp.assert_notice((select count(*)=1 from public.gp_push_deliveries where announcement_id=:'expire_id' and state='unavailable'),
  'expired deliveries leave the outgoing queue');
select pg_temp.assert_notice((select count(*)=1 and bool_and(details::jsonb->>'message'='Synthetic expired announcement')
  from public.audit_logs where action_type='ANNOUNCEMENT_EXPIRED' and details::jsonb->>'announcement_id'=:'expire_id'),
  'expiration is audited once and retains the announcement');
select pg_temp.assert_notice((select count(*)=1 and bool_and(actor_user_id=:'manager')
  from public.audit_logs where action_type='ANNOUNCEMENT_PUBLISHED' and details::jsonb->>'announcement_id'=:'private_id'),
  'the administrator publication is also audited');
rollback;
