\set ON_ERROR_STOP on
create role anon;
create role authenticated;
create schema auth;
create schema private;
create schema storage;
create table auth.users(id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$
 select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
$$;
grant usage on schema auth,storage to anon,authenticated;
grant usage on schema private to authenticated;
create table public.app_users(id bigint primary key,auth_user_id uuid unique references auth.users,
 employee_name text,department text,active boolean,perm_admin boolean,perm_quotes boolean,perm_commission boolean);
create function private.gp_is_admin() returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.app_users where auth_user_id=auth.uid() and active and perm_admin)
$$;
create table public.audit_logs(supervisor_name text,action_type text,details text);
create table public.gp_customers(id uuid primary key,display_name text);
create table public.outstanding_quotes(quote_number bigint primary key,customer_name text,customer_id uuid,total numeric,
 module text,parts jsonb,created_at timestamptz default now());
create table public.commission_logs(wo_number text,job_type text,glass_spec text,materials_used text,
 spec_notes text,work_date date,customer_id uuid,auth_user_id uuid);
create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
create table storage.objects(bucket_id text references storage.buckets,name text,primary key(bucket_id,name));
alter table storage.objects enable row level security;
alter table public.outstanding_quotes enable row level security;
alter table public.commission_logs enable row level security;
create policy quote_read on public.outstanding_quotes for select to authenticated using (exists(
 select 1 from public.app_users where auth_user_id=auth.uid() and active and (perm_admin or perm_quotes)));
create policy work_read on public.commission_logs for select to authenticated using (private.gp_is_admin() or auth_user_id=auth.uid());
grant select on public.app_users,public.gp_customers,public.outstanding_quotes,public.commission_logs to authenticated;
grant select,insert,delete on storage.objects to anon,authenticated;

insert into auth.users values ('11111111-1111-4111-8111-111111111111'),('22222222-2222-4222-8222-222222222222'),('33333333-3333-4333-8333-333333333333');
insert into public.app_users values
 (1,'11111111-1111-4111-8111-111111111111','Test Admin','Operations',true,true,true,true),
 (2,'22222222-2222-4222-8222-222222222222','Test Staff','Service',true,false,true,true),
 (3,'33333333-3333-4333-8333-333333333333','No Workspace','Shop',true,false,false,false);
insert into public.outstanding_quotes(quote_number,customer_name,total,module,parts)
 values(810,'Example storefront',245,'Door service','[{"desc":"Storefront door glass"}]');
insert into public.commission_logs values
 ('WO-10','Storefront door','Tempered','Closer','verify latch',current_date,null,'22222222-2222-4222-8222-222222222222'),
 ('WO-11','Storefront door','Tempered','Closer','another crew',current_date,null,'11111111-1111-4111-8111-111111111111');

\ir ../supabase/migrations/20261125152759_workspace_features.sql

create function pg_temp.assert_true(ok boolean,message text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'Assertion failed: %',message; end if; end
$$;
create function pg_temp.expect_error(statement text,expected text) returns void language plpgsql as $$
begin
  begin execute statement;
  exception when others then
    if SQLERRM like expected then return; end if;
    raise;
  end;
  raise exception 'Expected error matching %',expected;
end
$$;

select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',false);
set role authenticated;
select pg_temp.assert_true((select gp_workspace_features()='{"photo_intake":false,"quote_links":false,"dispatch":false,"job_search":false}'),'all new features initially hidden even for the admin');
select pg_temp.assert_true((select count(*)=1 from outstanding_quotes),'base Quotes access unchanged');
select pg_temp.expect_error($q$select gp_search_past_jobs('storefront')$q$,'%insufficient_privilege%');
select gp_set_workspace_permission('photo_intake','pilot');
select gp_set_workspace_permission('photo_intake','allow',2);
select gp_set_workspace_permission('photo_intake','allow',3);
select gp_set_workspace_permission('dispatch','workspace');
select gp_set_workspace_permission('job_search','workspace');
select gp_set_workspace_permission('quote_links','pilot');
select gp_set_workspace_permission('quote_links','allow',2);
reset role;

select set_config('request.jwt.claim.sub','33333333-3333-4333-8333-333333333333',false);
set role authenticated;
select pg_temp.assert_true((select not (gp_workspace_features()->>'photo_intake')::boolean),'pilot does not grant parent module');
select pg_temp.expect_error($q$select gp_set_workspace_permission('dispatch','off')$q$,'%insufficient_privilege%');
select pg_temp.expect_error($q$select gp_reserve_photo_draft()$q$,'%insufficient_privilege%');
reset role;

select set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',false);
set role authenticated;
select pg_temp.assert_true((select count(*)=2 and count(*) filter (where reference='WO-11')=0 from gp_search_past_jobs('storefront door')),'search respects source row permissions');
select pg_temp.assert_true((select bool_and(gp_reserve_photo_draft()) from generate_series(1,10)), 'ten photo drafts allowed per day');
select pg_temp.assert_true(not gp_reserve_photo_draft(),'quota cannot be exceeded');
insert into storage.objects values ('gp-quote-intake','22222222-2222-4222-8222-222222222222/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jpg');
select gp_save_photo_intake(null,null,
 '{"title":"Storefront intake","customer":"Example storefront","site":"Synthetic site","observations":"Glass cracked","next_step":"site_visit","quote_number":810,"work_order":"WO-10","photo_path":"22222222-2222-4222-8222-222222222222/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jpg","markup":[{"x":0.5,"y":0.5,"label":"Left panel"}]}');
delete from storage.objects where bucket_id='gp-quote-intake';
select pg_temp.assert_true((select count(*)=1 from storage.objects where bucket_id='gp-quote-intake'),'attached photo protected from cleanup');
select pg_temp.assert_true((select count(*)=1 from gp_search_past_jobs('cracked') where source='intake'),'marked photo intake indexed in search results');

select set_config('gp.test.stop', '{"title":"Install","site":"Synthetic site","crew":"North","kind":"install","status":"scheduled","starts_at":"2026-11-25T14:00:00Z","ends_at":"2026-11-25T15:00:00Z","latitude":30.8,"longitude":-83.2,"notes":""}',false);
select gp_save_dispatch_stop(null,null,current_setting('gp.test.stop')::jsonb);
select pg_temp.expect_error($q$select gp_save_dispatch_stop(null,null,current_setting('gp.test.stop')::jsonb||'{"crew":"north"}')$q$,'%already has a stop%');
select set_config('gp.test.token',gp_publish_quote_link(810,'[{"label":"Panel","amount":"245.00","description":"Replace the glass panel"},{"label":"Full assembly","amount":"500","description":"Replace glass and frame"}]',14),false);
reset role;

select set_config('request.jwt.claim.sub','',false);
set role anon;
select pg_temp.assert_true(gp_customer_quote(repeat('a',64)) is null,'wrong token returns no data');
select pg_temp.assert_true((gp_customer_quote(current_setting('gp.test.token'))->>'quote_number')='810','token loads the published snapshot');
select pg_temp.assert_true(not(gp_customer_quote(current_setting('gp.test.token'))?'token_hash'),'snapshot excludes internal fields');
select gp_customer_quote(current_setting('gp.test.token'),'question','What is the lead time?');
select gp_customer_quote(current_setting('gp.test.token'),'approve','Test Customer',0);
select pg_temp.assert_true(
 (gp_customer_quote(current_setting('gp.test.token'),'approve','Other signer',1)#>>'{replies,1,approved_option}')='0',
 'repeat approval preserves the first option');
select set_config('gp.test.path',gp_customer_quote(current_setting('gp.test.token'),'photo')->>'photo_path',false);
insert into storage.objects values ('gp-quote-customer',current_setting('gp.test.path'));
select pg_temp.assert_true((select count(*)=0 from storage.objects),'anonymous users cannot list photos');
select pg_temp.expect_error($q$insert into storage.objects values ('gp-quote-customer','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jpg')$q$,'%row-level security%');
reset role;

select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',false);
set role authenticated;
select pg_temp.assert_true((gp_quote_link_staff(810)#>>'{0,replies,1,kind}')='approval','staff can see approval in the callback feature');
select pg_temp.assert_true(jsonb_array_length(gp_quote_link_staff(810)#>'{0,photos}')=1,'staff can see customer photo');
select gp_set_workspace_permission('quote_links','deny',2);
select pg_temp.assert_true(gp_customer_quote(current_setting('gp.test.token')) is null,'creator blocked in pilot pauses their active link');
select gp_set_workspace_permission('quote_links','inherit',2);
select pg_temp.assert_true(gp_customer_quote(current_setting('gp.test.token')) is null,'inheriting pilot no longer permits the link');
select gp_set_workspace_permission('quote_links','workspace');
select pg_temp.assert_true(gp_customer_quote(current_setting('gp.test.token')) is not null,'workspace release permits the active link');
select gp_manage_quote_link((gp_quote_link_staff(810)#>>'{0,id}')::uuid,'revoke');
select pg_temp.assert_true(gp_customer_quote(current_setting('gp.test.token')) is null,'revoked link denies subsequent access');
select gp_set_workspace_permission('dispatch','off');
select gp_set_workspace_permission('photo_intake','off');
select pg_temp.assert_true((select count(*)=0 from gp_dispatch_stops),'turning off dispatch removes raw row access');
select pg_temp.assert_true((select count(*)=0 from gp_photo_intakes),'turning off intake removes raw row access');
select pg_temp.assert_true((select count(*)=1 from outstanding_quotes),'base callback data still available');
reset role;
select pg_temp.assert_true((select count(*)>=10 from audit_logs where action_type='WORKSPACE_PERMISSION'),'release changes audited');
select pg_temp.assert_true((select count(*)=1 from gp_dispatch_stops),'schedule retained while off');
select pg_temp.assert_true((select count(*)=1 from gp_photo_intakes),'intakes retained while off');
select 'PASS: workspace gates, private quote links and photos, search RLS, dispatch conflicts';
