\set ON_ERROR_STOP on
\ir fixtures/collections-base.sql
\ir ../supabase/migrations/2026-11-18-collections-intelligence.sql
\ir ../supabase/migrations/2026-11-18-quote-callback-import.sql
-- Installation must be rerunnable without erasing history or changing locked baselines.
\ir ../supabase/migrations/2026-11-18-collections-intelligence.sql
\ir ../supabase/migrations/2026-11-18-quote-callback-import.sql
create function pg_temp.check_that(ok boolean,msg text) returns void language plpgsql as $$begin if ok is distinct from true then raise exception 'ASSERTION FAILED: %',msg;end if;end$$;
create function pg_temp.expect_error(statement text,needle text) returns void language plpgsql as $$begin begin execute statement;exception when others then if position(needle in sqlerrm)>0 then return;else raise;end if;end;raise exception 'Expected error containing %',needle;end$$;
select set_config('request.jwt.claim.sub','33333333-3333-4333-8333-333333333333',false);
set role authenticated;
select pg_temp.expect_error($q$select public.gp_collections_begin_snapshot('qbo','fixture.csv','2026-11-18','open_invoices','full',repeat('a',64),1)$q$,'Administrator');
select pg_temp.expect_error($q$select public.gp_collections_clear_verified(gen_random_uuid(),'A valid reason')$q$,'Collections permission');
reset role;
select set_config('request.jwt.claim.sub','44444444-4444-4444-8444-444444444444',false);
set role authenticated;
select pg_temp.expect_error($q$select public.gp_collections_begin_snapshot('qbo','fixture.csv','2026-11-18','open_invoices','full',repeat('a',64),1)$q$,'Administrator');
reset role;
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',false);
set role authenticated;
select public.gp_collections_begin_snapshot('qbo','current.csv','2026-11-18','open_invoices','full',repeat('a',64),1) as current_id \gset
select pg_temp.expect_error(format('select public.gp_collections_commit_snapshot(%L)',:'current_id'),'incomplete');
insert into public.collection_source_rows(import_id,source,external_key,case_key,customer_name,normalized_customer,invoice_number,transaction_type,transaction_date,original_amount,open_balance,raw)
values(:'current_id','qbo','INV|EXAMPLE CUSTOMER|100','INV|EXAMPLE CUSTOMER|100','Example Customer','EXAMPLE CUSTOMER','100','invoice','2026-01-01',100,70,'{"balance_present":true}');
select public.gp_collections_commit_snapshot(:'current_id');
select pg_temp.check_that((select qbo_balance=70 from public.collection_cases where invoice_number='100'),'current snapshot set');
select pg_temp.expect_error(format($q$insert into public.collection_source_rows(import_id,source,external_key,customer_name,normalized_customer,transaction_type) values(%L,'qbo','late','Example','EXAMPLE','payment')$q$,:'current_id'),'unsealed batch');
select pg_temp.expect_error($q$select public.gp_collections_begin_snapshot('qbo','duplicate.csv','2026-11-18','open_invoices','full',repeat('a',64),1)$q$,'already been imported');
select public.gp_collections_begin_snapshot('qbo','old.csv','2026-01-01','open_invoices','full',repeat('b',64),1) as old_id \gset
insert into public.collection_source_rows(import_id,source,external_key,case_key,customer_name,normalized_customer,invoice_number,transaction_type,transaction_date,original_amount,open_balance,raw)
values(:'old_id','qbo','INV|EXAMPLE CUSTOMER|100','INV|EXAMPLE CUSTOMER|100','Example Customer','EXAMPLE CUSTOMER','100','invoice','2026-01-01',100,100,'{"balance_present":true}');
select pg_temp.check_that((public.gp_collections_commit_snapshot(:'old_id')->>'historical_only')::boolean,'old import historical');
select pg_temp.check_that((select qbo_balance=70 from public.collection_cases where invoice_number='100'),'old import cannot replace current amount');
select public.gp_collections_begin_snapshot('glassquest','quest.xlsx','2026-11-17','legacy_baseline','unknown',repeat('c',64),1) as quest_id \gset
insert into public.collection_source_rows(import_id,source,external_key,case_key,customer_name,normalized_customer,invoice_number,transaction_type,transaction_date,original_amount,open_balance,raw)
values(:'quest_id','glassquest','GQ|100','GQ|100','GlassQuest customer not provided','GLASSQUEST CUSTOMER NOT PROVIDED','100','invoice','2026-01-01',100,70,'{"balance_present":true,"customer_missing":true}');
select public.gp_collections_commit_snapshot(:'quest_id');
select id as case_id from public.collection_cases where case_key='INV|EXAMPLE CUSTOMER|100' \gset
select id as legacy_id from public.collection_cases where case_key='GQ|100' \gset
select pg_temp.expect_error($q$select public.gp_collections_begin_snapshot('glassquest','quest-again.xlsx','2026-11-18','legacy_baseline','unknown',repeat('d',64),1)$q$,'one-time');
select pg_temp.expect_error(format('select public.gp_collections_clear_verified(%L,%L)',:'legacy_id','Verified payment'),'Match the customer');
select public.gp_collections_link_quest(:'legacy_id',:'case_id',null,'Verified original invoice and customer in the source ledger');
select pg_temp.check_that((select glassquest_balance=70 and glassquest_case_key='GQ|100' from public.collection_cases where id=:'case_id'),'legacy linked without losing baseline');
select pg_temp.expect_error(format('select public.gp_collections_clear_verified(%L,%L)',:'case_id','Missing from QBO means paid'),'does not verify');
select public.gp_collections_begin_snapshot('qbo','verification.csv','2026-11-18','invoice_verification','partial',repeat('e',64),1) as verify_id \gset
insert into public.collection_source_rows(import_id,source,external_key,case_key,customer_name,normalized_customer,invoice_number,transaction_type,transaction_date,original_amount,open_balance,raw)
values(:'verify_id','qbo','INV|EXAMPLE CUSTOMER|100','INV|EXAMPLE CUSTOMER|100','Example Customer','EXAMPLE CUSTOMER','100','invoice','2026-01-01',100,0,'{"balance_present":true,"ar_paid":"Paid"}');
select public.gp_collections_commit_snapshot(:'verify_id');
reset role;
update public.collection_cases set status='promise',next_follow_up='2026-11-19' where id=:'case_id';
insert into public.collection_actions(case_id,action_type,note,recorded_by) values(:'case_id','note','Original collector note must survive.','11111111-1111-4111-8111-111111111111');
select set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',false);
set role authenticated;
select public.gp_collections_clear_verified(:'case_id','Verified invoice is settled in Invoice List; payment reference checked.');
select pg_temp.check_that((select status='reconciled' and cleared_import_id=:'verify_id' and glassquest_balance=70 from public.collection_cases where id=:'case_id'),'verified archive retains baseline and evidence');
select pg_temp.check_that((select count(*)=1 from public.collection_actions where case_id=:'case_id' and note='Original collector note must survive.'),'original notes retained');
select pg_temp.check_that((select count(*)=1 from public.collection_actions where case_id=:'case_id' and details->>'event'='verified_clearance'),'clearance audited once');
select pg_temp.expect_error(format('select public.gp_collections_clear_verified(%L,%L)',:'case_id','Try twice'),'already archived');
-- Quote importer accepts new quotes from the same customer, skips old numbers atomically.
select pg_temp.expect_error($q$select public.gp_import_quote_callbacks('[{"quote_number":101,"customer_name":"Example","parts":[]}]','fixture.csv')$q$,'administrators');
reset role;
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',false);
insert into public.outstanding_quotes(quote_number,customer_name,status,call_data,admin_coaching_note) values(101,'Example Customer','won','{"notes":"Keep this receipt"}','Keep coaching');
set role authenticated;
select pg_temp.check_that((public.gp_import_quote_callbacks('[{"quote_number":101,"customer_name":"Example Customer","parts":[]},{"quote_number":102,"customer_name":"Example Customer","parts":[]}]','Quotes.csv')->>'added')::integer=1,'new quote for same customer accepted');
reset role;
select pg_temp.check_that((select status='won' and call_data->>'notes'='Keep this receipt' and admin_coaching_note='Keep coaching' from public.outstanding_quotes where quote_number=101),'existing callback and notes untouched');
select pg_temp.check_that((select count(*)=2 from public.outstanding_quotes),'two distinct quotes for same customer');
select 'PASS: collections permissions, ordering, one-time baseline, audited links/clearance, notes retention and quote import';
