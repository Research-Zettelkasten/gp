\set ON_ERROR_STOP on
\ir fixtures/collections-base.sql
alter table public.app_users add column perm_quotes boolean not null default false;
update public.app_users set perm_quotes=true where perm_admin;
create or replace function private.gp_has_permission(p_permission text) returns boolean language sql stable security definer set search_path='' as $$select coalesce((select active and (perm_admin or case p_permission when 'collections' then perm_collections when 'quotes' then perm_quotes else false end) from public.app_users where auth_user_id=auth.uid()),false)$$;
\ir ../supabase/migrations/2026-11-18-collections-intelligence.sql
\ir ../supabase/migrations/2026-11-18-quote-callback-import.sql
-- Fixture RLS mirrors the existing permission boundaries.
alter table public.collection_cases enable row level security;
alter table public.collection_actions enable row level security;
alter table public.collection_account_notes enable row level security;
alter table public.outstanding_quotes enable row level security;
grant select on public.outstanding_quotes to authenticated;
create policy fixture_cases_read on public.collection_cases for select to authenticated using(private.gp_has_permission('collections'));
create policy fixture_actions_read on public.collection_actions for select to authenticated using(private.gp_has_permission('collections'));
create policy fixture_account_notes_read on public.collection_account_notes for select to authenticated using(private.gp_has_permission('collections'));
create policy fixture_quotes_read on public.outstanding_quotes for select to authenticated using(private.gp_has_permission('quotes'));
\ir ../supabase/migrations/2026-11-18-customer-registry.sql
\ir ../supabase/migrations/2026-11-18-customer-registry.sql
create function pg_temp.check_that(ok boolean,msg text) returns void language plpgsql as $$begin if ok is distinct from true then raise exception 'ASSERTION FAILED: %',msg;end if;end$$;
create function pg_temp.expect_error(statement text,needle text) returns void language plpgsql as $$begin begin execute statement;exception when others then if position(needle in sqlerrm)>0 then return;else raise;end if;end;raise exception 'Expected error containing %',needle;end$$;
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',false);
set role authenticated;
select public.gp_customer_save(null,'{"display_name":"Example Customer","customer_number":"001","phone":"555-010-0100"}','Created and verified customer from original record') as customer_id \gset
select pg_temp.check_that((select identity_status='verified' from public.gp_customers where id=:'customer_id'),'profile saved and verified');
select public.gp_customer_add_note(:'customer_id','shared','contact','AP contact','Contact the verified accounts payable team.',true);
select public.gp_customer_add_note(:'customer_id','collections','payment','Payment research','Financial details only for collections.',false);
select public.gp_customer_add_note(:'customer_id','quotes','general','Quote preference','Sales note only for quote staff.',false);
select public.gp_customer_add_note(:'customer_id','admin','general','Manager review','Manager-only customer information.',false);
select public.gp_import_customer_directory('[{"import_key":"legacy-directory:002","customer_number":"002","customer_name":"Second Customer","identity_review_required":false,"review_required":false,"phone":"555-010-0200","source_page":1,"report_as_of":"2026-07-10"},{"import_key":"legacy-directory:003","customer_number":"003","customer_name":"Uncertain OCR","identity_review_required":true,"review_required":true,"review_reason":"Customer number needs verification"}]','Synthetic directory.csv',repeat('a',64));
select pg_temp.expect_error($q$select public.gp_import_customer_directory('[{"import_key":"x","customer_name":"Example"}]','same.csv',repeat('a',64))$q$,'already imported');
reset role;
insert into public.outstanding_quotes(quote_number,customer_name,status,total,parts,call_data,admin_coaching_note) values(101,'Example Customer','open',50,'[]','{"notes":"Original quote conversation"}','Original coaching');
insert into public.collection_cases(case_key,customer_name,normalized_customer,invoice_number,invoice_date,mainstreet_balance) values('INV|EXAMPLE CUSTOMER|100','Example Customer','EXAMPLE CUSTOMER','100','2026-01-01',50);
select id as case_id from public.collection_cases where invoice_number='100' \gset
insert into public.collection_actions(case_id,action_type,note,recorded_by) values(:'case_id','note','Original invoice collection note','11111111-1111-4111-8111-111111111111');
insert into public.collection_account_notes(customer_name,normalized_customer,category,subject,note,recorded_by) values('Example Customer','EXAMPLE CUSTOMER','contact','Account contact','Original account-wide instructions','11111111-1111-4111-8111-111111111111');
select pg_temp.check_that((select customer_id=:'customer_id' from public.outstanding_quotes where quote_number=101),'quote attached by exact name');
select pg_temp.check_that((select customer_id=:'customer_id' from public.collection_cases where id=:'case_id'),'invoice attached by exact name');
update public.outstanding_quotes set call_data='{"notes":"Second conversation with customer"}' where quote_number=101;
select pg_temp.check_that((select count(*)=2 from public.gp_customer_quote_history where quote_number=101),'quote history append-only snapshots');
set role authenticated;
select pg_temp.check_that((select count(*)>=8 from public.gp_customer_timeline where customer_id=:'customer_id'),'unified timeline contains notes from source modules');
select public.gp_customer_add_alias(:'customer_id','Example Customer Accounts','Verified alternate billing name from QBO');
reset role;
insert into public.collection_cases(case_key,customer_name,normalized_customer,invoice_number) values('INV|EXAMPLE CUSTOMER ACCOUNTS|200','Example Customer Accounts','EXAMPLE CUSTOMER ACCOUNTS','200');
select pg_temp.check_that((select customer_id=:'customer_id' from public.collection_cases where invoice_number='200'),'verified alias attaches source record');
-- Different entities with identical display names require explicit record links.
set role authenticated;
select public.gp_customer_save(null,'{"display_name":"Duplicate Name"}','Verified separate first customer') as duplicate_one \gset
select public.gp_customer_save(null,'{"display_name":"Duplicate Name"}','Verified separate second customer') as duplicate_two \gset
reset role;
insert into public.collection_cases(case_key,customer_name,normalized_customer,invoice_number) values('INV|DUPLICATE NAME|300','Duplicate Name','DUPLICATE NAME','300');
select id as ambiguous_case from public.collection_cases where invoice_number='300' \gset
select pg_temp.check_that((select customer_id is null from public.collection_cases where id=:'ambiguous_case'),'ambiguous name not auto-merged');
set role authenticated;
select public.gp_customer_link_record(:'duplicate_one','collections',:'ambiguous_case','Verified invoice belongs to first separate customer');
select public.gp_customer_relink_reports();
select pg_temp.check_that((select customer_id=:'duplicate_one' from public.collection_cases where id=:'ambiguous_case'),'manual identity decision survives re-linking');
reset role;
-- Quote-only employee sees shared and sales notes, not financial or manager notes.
update public.app_users set perm_quotes=true where auth_user_id='33333333-3333-4333-8333-333333333333';
select set_config('request.jwt.claim.sub','33333333-3333-4333-8333-333333333333',false);
set role authenticated;
select pg_temp.check_that((select count(*)=2 from public.gp_customer_notes where customer_id=:'customer_id'),'quote-only note scope');
select pg_temp.check_that((select count(*)=0 from public.gp_customer_timeline where source='collections'),'invoker timeline preserves collections RLS');
select pg_temp.check_that((select count(*)=0 from public.gp_customer_timeline where source='registry'),'manager audit details hidden');
select pg_temp.expect_error(format('select public.gp_customer_add_note(%L,%L,%L,%L,%L)',:'customer_id','collections','payment','Unauthorized','Should not save'),'not permitted');
select pg_temp.expect_error($q$select public.gp_customer_save(null,'{"display_name":"Not allowed"}','Employee cannot edit contacts')$q$,'Administrator');
reset role;
select set_config('request.jwt.claim.sub','44444444-4444-4444-8444-444444444444',false);
set role authenticated;
select pg_temp.check_that((select count(*)=0 from public.gp_customers),'inactive administrators cannot read registry');
reset role;
select 'PASS: customer directory, aliases, ambiguous identity, append-only histories, source links and module-level RLS';
