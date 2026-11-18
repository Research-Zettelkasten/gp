-- GLASSPRO 2026.11.18.2: run this complete SQL file in the EXISTING project.
-- Includes four additive, rerunnable migrations in dependency order.
-- No customer contact records are included.

-- 2026-11-18-collections-intelligence.sql
-- Requires the existing GLASSPRO Collections tables. Apply in Supabase SQL Editor.
begin;
alter table public.collection_imports add column if not exists report_kind text not null default 'legacy';
alter table public.collection_imports add column if not exists report_scope text not null default 'unknown';
alter table public.collection_imports add column if not exists file_sha256 text;
alter table public.collection_imports add column if not exists expected_rows integer;
alter table public.collection_cases add column if not exists glassquest_import_id uuid references public.collection_imports(id);
alter table public.collection_cases add column if not exists glassquest_balance numeric(14,2);
alter table public.collection_cases add column if not exists glassquest_case_key text;
alter table public.collection_cases add column if not exists legacy_unmatched boolean not null default false;
alter table public.collection_cases add column if not exists legacy_linked_to uuid references public.collection_cases(id);
alter table public.collection_cases add column if not exists cleared_at timestamptz;
alter table public.collection_cases add column if not exists cleared_report_as_of date;
alter table public.collection_cases add column if not exists cleared_import_id uuid references public.collection_imports(id);

do $$declare r record;begin
 for r in select conrelid::regclass as tbl,conname from pg_constraint where conrelid in ('public.collection_imports'::regclass,'public.collection_source_rows'::regclass) and contype='c' and pg_get_constraintdef(oid) ~ '\msource\M'
 loop execute format('alter table %s drop constraint %I',r.tbl,r.conname);end loop;
end$$;
alter table public.collection_imports add constraint gp_collection_import_source_check check(source in ('mainstreet','qbo','glassquest'));
alter table public.collection_source_rows add constraint gp_collection_row_source_check check(source in ('mainstreet','qbo','glassquest'));
create unique index if not exists gp_collection_one_quest_baseline on public.collection_imports(source) where source='glassquest' and status='complete';
create unique index if not exists gp_collection_snapshot_hash on public.collection_imports(source,file_sha256) where file_sha256 is not null and status='complete';
create index if not exists gp_collection_snapshot_date on public.collection_imports(source,report_kind,report_as_of desc,completed_at desc) where status='complete';

-- Tie every staged row to the exact source and owner of its unsealed batch.
drop policy if exists gp_collection_rows_insert on public.collection_source_rows;
create policy gp_collection_rows_insert on public.collection_source_rows for insert to authenticated with check(
 (select private.gp_is_admin()) and exists(select 1 from public.collection_imports i
 where i.id=collection_source_rows.import_id and i.imported_by=(select auth.uid()) and i.status='staging' and i.source=collection_source_rows.source));

-- Serialize a row insert with finalization, including inserts racing the final batch.
create or replace function private.gp_collection_lock_staging()
returns trigger language plpgsql security definer set search_path='' as $$
declare i public.collection_imports%rowtype;begin
 select * into i from public.collection_imports where id=new.import_id for update;
 if not found or i.status<>'staging' or i.source<>new.source then raise exception 'Rows may only be added to an unsealed batch of the same source';end if;
 return new;
end$$;
revoke all on function private.gp_collection_lock_staging() from public,anon,authenticated;
drop trigger if exists gp_collection_staging_lock on public.collection_source_rows;
create trigger gp_collection_staging_lock before insert on public.collection_source_rows for each row execute function private.gp_collection_lock_staging();

create or replace function public.gp_collections_begin_snapshot(p_source text,p_file_name text,p_report_as_of date,p_report_kind text,p_report_scope text,p_sha256 text,p_expected_rows integer)
returns uuid language plpgsql security definer set search_path='' as $$
declare v_id uuid;begin
 if not private.gp_is_admin() then raise exception 'Administrator permission required';end if;
 if p_source is null or p_source not in ('mainstreet','qbo','glassquest') then raise exception 'Invalid source';end if;
 if p_report_as_of is null or p_report_as_of>(now() at time zone 'America/New_York')::date then raise exception 'Supply the actual report date, no later than today';end if;
 if p_report_kind is null or not ((p_source='mainstreet' and p_report_kind='open_invoices') or (p_source='qbo' and p_report_kind in ('open_invoices','invoice_verification','account_summary')) or (p_source='glassquest' and p_report_kind='legacy_baseline')) then raise exception 'Invalid source/report combination';end if;
 if p_report_scope is null or p_report_scope not in ('full','partial','unknown') then raise exception 'Invalid report scope';end if;
 if p_sha256 is null or p_sha256!~'^[a-f0-9]{64}$' or p_expected_rows is null or p_expected_rows not between 1 and 20000 or length(btrim(coalesce(p_file_name,''))) not between 1 and 200 then raise exception 'Invalid file metadata';end if;
 perform pg_advisory_xact_lock(hashtextextended('gp-collections-import',0));
 if exists(select 1 from public.collection_imports where source=p_source and file_sha256=p_sha256 and status='complete') then raise exception 'This exact file has already been imported';end if;
 if p_source='glassquest' and exists(select 1 from public.collection_imports where source='glassquest' and status='complete') then raise exception 'The one-time GlassQuest baseline is already loaded';end if;
 insert into public.collection_imports(source,file_name,report_as_of,imported_by,report_kind,report_scope,file_sha256,expected_rows)
 values(p_source,btrim(p_file_name),p_report_as_of,auth.uid(),p_report_kind,p_report_scope,p_sha256,p_expected_rows) returning id into v_id;
 return v_id;
end$$;

create or replace function public.gp_collections_commit_snapshot(p_import_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v public.collection_imports%rowtype;n integer;newer boolean;r record;key text;begin
 if not private.gp_is_admin() then raise exception 'Administrator permission required';end if;
 perform pg_advisory_xact_lock(hashtextextended('gp-collections-import',0));
 select * into v from public.collection_imports where id=p_import_id for update;
 if not found or v.status<>'staging' or v.imported_by<>auth.uid() or v.expected_rows is null then raise exception 'Snapshot is missing, sealed, or belongs to another administrator';end if;
 select count(*) into n from public.collection_source_rows where import_id=v.id;
 if n<>v.expected_rows or n not between 1 and 20000 then raise exception 'Snapshot is incomplete; no cases were changed';end if;
 if exists(select 1 from public.collection_source_rows where import_id=v.id and (source<>v.source or nullif(btrim(customer_name),'') is null or nullif(btrim(normalized_customer),'') is null or (transaction_type='invoice' and (nullif(btrim(invoice_number),'') is null or transaction_date is null or case_key is null or raw->>'balance_present' is distinct from 'true')))) then raise exception 'Invalid source, invoice identity, date, or explicit balance';end if;
 if exists(select case_key from public.collection_source_rows where import_id=v.id and transaction_type='invoice' group by case_key having count(*)>1) then raise exception 'Duplicate invoices must be resolved before importing';end if;
 if v.report_kind='account_summary' and exists(select 1 from public.collection_source_rows where import_id=v.id and transaction_type<>'account_summary') then raise exception 'Account summaries cannot contain invoice evidence';end if;
 if v.source='glassquest' and exists(select 1 from public.collection_imports where source='glassquest' and status='complete') then raise exception 'The one-time GlassQuest baseline is already loaded';end if;
 if exists(select 1 from public.collection_imports where source=v.source and file_sha256=v.file_sha256 and status='complete') then raise exception 'This exact file has already been imported';end if;
 select exists(select 1 from public.collection_imports i where i.status='complete' and i.source=v.source and i.report_kind=v.report_kind and i.report_as_of>v.report_as_of) into newer;
 -- Older files are retained as evidence, but cannot replace newer values or create stale work.
 if not newer and v.report_kind<>'account_summary' then
  for r in select * from public.collection_source_rows where import_id=v.id and transaction_type='invoice' loop
   key:=r.case_key;
   if v.source='glassquest' and coalesce((r.raw->>'customer_missing')::boolean,false) then
    if key<>'GQ|'||upper(regexp_replace(btrim(r.invoice_number),'\s+','','g')) then raise exception 'Invalid unmatched GlassQuest identity';end if;
   elsif key<>'INV|'||r.normalized_customer||'|'||upper(regexp_replace(btrim(r.invoice_number),'\s+','','g')) then raise exception 'Invalid invoice identity';end if;
   insert into public.collection_cases(case_key,customer_name,normalized_customer,invoice_number,invoice_date,due_date)
   values(key,r.customer_name,r.normalized_customer,r.invoice_number,r.transaction_date,r.due_date) on conflict(case_key) do nothing;
   if v.source='glassquest' then
    update public.collection_cases set glassquest_import_id=v.id,glassquest_balance=r.open_balance,glassquest_case_key=key,legacy_unmatched=coalesce((r.raw->>'customer_missing')::boolean,false),updated_at=now() where case_key=key;
   elsif v.source='mainstreet' then
    update public.collection_cases c set mainstreet_import_id=v.id,mainstreet_balance=r.open_balance,mainstreet_aging=r.aging_bucket,mainstreet_seen_at=now(),phone=coalesce(r.phone,c.phone),contact=coalesce(r.contact,c.contact),street_address=coalesce(r.raw->>'address',c.street_address),city=coalesce(r.raw->>'city',c.city),state_code=coalesce(r.raw->>'state',c.state_code),zip_code=coalesce(r.raw->>'zip_code',c.zip_code),last_purchase_text=coalesce(r.raw->>'last_purchase',c.last_purchase_text),last_payment_text=coalesce(r.raw->>'last_payment',c.last_payment_text),source_collection_notes=coalesce(r.raw->>'collection_notes',c.source_collection_notes),edi_status=coalesce(r.raw->>'edi_status',c.edi_status),edi_activity=coalesce(r.raw->>'edi_activity',c.edi_activity),updated_at=now()
    where c.case_key=key and not exists(select 1 from public.collection_imports old where old.id=c.mainstreet_import_id and old.report_as_of>v.report_as_of);
   else
    update public.collection_cases c set qbo_import_id=v.id,qbo_balance=r.open_balance,qbo_days_past_due=coalesce(r.days_past_due,0),qbo_store_name=coalesce(r.raw->>'store_full_name',c.qbo_store_name),qbo_seen_at=now(),due_date=coalesce(r.due_date,c.due_date),updated_at=now()
    where c.case_key=key and not exists(select 1 from public.collection_imports old where old.id=c.qbo_import_id and old.report_as_of>v.report_as_of);
   end if;
  end loop;
 end if;
 update public.collection_imports set status='complete',completed_at=now(),row_count=n where id=v.id;
 return jsonb_build_object('rows',n,'historical_only',newer);
end$$;

-- A settlement is proved by a dated invoice row with explicit zero balance, never absence.
create or replace function public.gp_collections_clear_verified(p_case_id uuid,p_note text)
returns void language plpgsql security definer set search_path='' as $$
declare c public.collection_cases%rowtype;r record;begin
 if not private.gp_has_permission('collections') then raise exception 'Collections permission required';end if;
 if length(btrim(coalesce(p_note,''))) not between 4 and 8000 then raise exception 'Explain the verified clearance';end if;
 perform pg_advisory_xact_lock(hashtextextended('gp-collections-import',0));
 select * into c from public.collection_cases where id=p_case_id for update;
 if not found or c.legacy_unmatched or c.legacy_linked_to is not null then raise exception 'Match the customer before clearing this case';end if;
 if c.status='reconciled' then raise exception 'This case is already archived';end if;
 if (c.needs_mainstreet_update and c.mainstreet_confirmed_at is null) or (c.needs_qbo_update and c.qbo_confirmed_at is null) then raise exception 'Confirm pending accounting corrections before archiving';end if;
 select s.*,i.report_as_of,i.completed_at,i.report_kind into r from public.collection_source_rows s join public.collection_imports i on i.id=s.import_id
 where s.case_key=c.case_key and s.source='qbo' and s.transaction_type='invoice' and i.status='complete'
 order by coalesce(i.report_as_of,i.completed_at::date) desc,i.completed_at desc,i.id desc limit 1;
 if not found or r.report_kind<>'invoice_verification' or r.open_balance<>0 or r.raw->>'balance_present' is distinct from 'true' or r.report_as_of is null or r.report_as_of<coalesce(c.invoice_date,r.report_as_of) then raise exception 'Newest invoice evidence does not verify a zero QBO balance';end if;
 if exists(select 1 from public.collection_imports i where i.id=c.glassquest_import_id and i.report_as_of>r.report_as_of) then raise exception 'Verification predates the GlassQuest baseline';end if;
 if exists(select 1 from public.collection_source_rows s join public.collection_imports i on i.id=s.import_id where s.case_key=c.case_key and s.transaction_type='invoice' and s.source='mainstreet' and s.open_balance>0 and i.status='complete' and (coalesce(i.report_as_of,i.completed_at::date),i.completed_at,i.id)>(r.report_as_of,r.completed_at,r.import_id)) then raise exception 'Newer Mainstreet evidence still shows a balance; investigate first';end if;
 insert into public.collection_actions(case_id,action_type,note,details,recorded_by) values(c.id,'research',btrim(p_note),jsonb_build_object('event','verified_clearance','evidence_import_id',r.import_id,'evidence_row_id',r.id,'report_as_of',r.report_as_of,'previous_status',c.status,'meaning','Zero remaining balance; may include payment, credit, or write-off'),auth.uid());
 update public.collection_cases set status='reconciled',resolved_at=now(),cleared_at=now(),cleared_report_as_of=r.report_as_of,cleared_import_id=r.import_id,next_follow_up=null,last_activity_at=now(),updated_at=now() where id=c.id;
end$$;

-- GlassQuest exports without names stay separate until an administrator verifies identity.
create or replace function public.gp_collections_link_quest(p_legacy_id uuid,p_target_id uuid,p_customer text,p_note text)
returns uuid language plpgsql security definer set search_path='' as $$
declare c public.collection_cases%rowtype;t public.collection_cases%rowtype;norm text;k text;begin
 if not private.gp_is_admin() then raise exception 'Administrator permission required';end if;
 if length(btrim(coalesce(p_note,''))) not between 4 and 8000 then raise exception 'Document how you verified the invoice and customer';end if;
 perform pg_advisory_xact_lock(hashtextextended('gp-collections-import',0));
 select * into c from public.collection_cases where id=p_legacy_id for update;
 if not found or not c.legacy_unmatched or c.legacy_linked_to is not null then raise exception 'This is not an unmatched GlassQuest item';end if;
 if p_target_id is null then
  if length(btrim(coalesce(p_customer,''))) not between 2 and 250 then raise exception 'Enter the verified customer name';end if;
  -- Same normalization as the browser for supported customer names; non-ASCII names can link to an existing case.
  norm:=upper(btrim(regexp_replace(regexp_replace(regexp_replace(replace(btrim(p_customer),'&',' AND '),'[^a-zA-Z0-9]+',' ','g'),'\m(LLC|INC|CORP|CO|LTD)\M','','g'),'\s+',' ','g')));
  if length(norm)<2 then raise exception 'Customer name is not usable';end if;
  k:='INV|'||norm||'|'||upper(regexp_replace(btrim(c.invoice_number),'\s+','','g'));
  insert into public.collection_cases(case_key,customer_name,normalized_customer,invoice_number,invoice_date) values(k,btrim(p_customer),norm,c.invoice_number,c.invoice_date) on conflict(case_key) do nothing;
  select * into t from public.collection_cases where case_key=k for update;
 else select * into t from public.collection_cases where id=p_target_id for update;
 end if;
 if t.id is null or t.id=c.id or t.legacy_unmatched or t.legacy_linked_to is not null or t.glassquest_import_id is not null then raise exception 'Choose a customer invoice without an existing GlassQuest link';end if;
 update public.collection_cases set glassquest_import_id=c.glassquest_import_id,glassquest_balance=c.glassquest_balance,glassquest_case_key=c.case_key,updated_at=now() where id=t.id;
 update public.collection_cases set legacy_linked_to=t.id,updated_at=now() where id=c.id;
 insert into public.collection_actions(case_id,action_type,note,details,recorded_by) values(t.id,'research',btrim(p_note),jsonb_build_object('event','glassquest_customer_link','legacy_case_id',c.id,'legacy_invoice',c.invoice_number,'target_invoice',t.invoice_number),auth.uid());
 insert into public.collection_actions(case_id,action_type,note,details,recorded_by) values(c.id,'research',btrim(p_note),jsonb_build_object('event','glassquest_customer_link','target_case_id',t.id),auth.uid());
 return t.id;
end$$;

revoke all on function public.gp_collections_begin_snapshot(text,text,date,text,text,text,integer),public.gp_collections_commit_snapshot(uuid),public.gp_collections_clear_verified(uuid,text),public.gp_collections_link_quest(uuid,uuid,text,text) from public,anon;
grant execute on function public.gp_collections_begin_snapshot(text,text,date,text,text,text,integer),public.gp_collections_commit_snapshot(uuid),public.gp_collections_clear_verified(uuid,text),public.gp_collections_link_quest(uuid,uuid,text,text) to authenticated;
notify pgrst,'reload schema';
commit;

-- 2026-11-18-quote-callback-import.sql
-- Atomic insert-only quote import. Existing callbacks, receipts and notes are retained.
begin;
create or replace function public.gp_import_quote_callbacks(p_rows jsonb,p_source text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare accepted jsonb; n integer;begin
 if not private.gp_is_admin() then raise exception 'Only administrators can import quotes';end if;
 if p_rows is null or jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows) not between 1 and 5000 or octet_length(p_rows::text)>10000000 then raise exception 'Supply between 1 and 5,000 quotes';end if;
 if exists(select 1 from jsonb_array_elements(p_rows) r where coalesce(r->>'quote_number','')!~'^[0-9]+$' or length(btrim(coalesce(r->>'customer_name',''))) not between 1 and 250 or jsonb_typeof(r->'parts') is distinct from 'array') then raise exception 'Invalid quote identity or parts';end if;
 if exists(select 1 from jsonb_array_elements(p_rows) r where (r->>'quote_number')::numeric not between 1 and 9007199254740991) then raise exception 'Invalid quote number';end if;
 if exists(select r->>'quote_number' from jsonb_array_elements(p_rows) r group by r->>'quote_number' having count(*)>1) then raise exception 'Group line items by quote number first';end if;
 with inserted as(
  insert into public.outstanding_quotes(quote_number,normalized_customer_name,customer_name,quote_date,module,phone,has_cell,subtotal,tax,total,original_csr,parts,status,contact_attempts,call_data,admin_coaching_note)
  select quote_number,upper(regexp_replace(btrim(customer_name),'\s+',' ','g')),btrim(customer_name),quote_date,module,phone,coalesce(has_cell,false),coalesce(subtotal,0),coalesce(tax,0),coalesce(total,0),original_csr,parts,'open',0,'{}'::jsonb,''
  from jsonb_to_recordset(p_rows) as r(quote_number bigint,customer_name text,quote_date text,module text,phone text,has_cell boolean,subtotal numeric,tax numeric,total numeric,original_csr text,parts jsonb)
  on conflict(quote_number) do nothing returning quote_number
 )select coalesce(jsonb_agg(quote_number),'[]'::jsonb),count(*) into accepted,n from inserted;
 insert into public.audit_logs(supervisor_name,action_type,details)
 select employee_name,'CSV_UPLOAD',format('Quote Call-Backs: %s new quotes; %s duplicate numbers skipped; source %s',n,jsonb_array_length(p_rows)-n,left(coalesce(p_source,'Quotes.csv'),200)) from public.app_users where auth_user_id=auth.uid() and active limit 1;
 return jsonb_build_object('accepted',accepted,'added',n,'duplicates',jsonb_array_length(p_rows)-n);
end$$;
revoke all on function public.gp_import_quote_callbacks(jsonb,text) from public,anon;
grant execute on function public.gp_import_quote_callbacks(jsonb,text) to authenticated;
notify pgrst,'reload schema';
commit;

-- 2026-11-18-customer-registry.sql
-- Additive customer registry. Apply after both earlier 2026-11-18 migrations.
-- Directory data is imported privately through Customers, never bundled in the site.
begin;
create or replace function private.gp_customer_access()
returns boolean language sql stable security definer set search_path='' as $$
 select private.gp_is_admin() or private.gp_has_permission('collections') or private.gp_has_permission('quotes');
$$;
create or replace function private.gp_customer_norm(p_name text)
returns text language sql immutable set search_path='' as $$
 select btrim(regexp_replace(upper(normalize(coalesce(p_name,''),NFKC)),'[^[:alnum:]]+',' ','g'));
$$;
revoke all on function private.gp_customer_access(),private.gp_customer_norm(text) from public,anon;
grant execute on function private.gp_customer_access(),private.gp_customer_norm(text) to authenticated;

create table if not exists public.gp_customer_imports(
 id uuid primary key default gen_random_uuid(),file_name text not null,file_sha256 text not null unique,
 row_count integer not null,created_count integer not null default 0,updated_count integer not null default 0,
 review_count integer not null default 0,imported_by uuid references auth.users(id),created_at timestamptz not null default now()
);
create table if not exists public.gp_customers(
 id uuid primary key default gen_random_uuid(),directory_key text unique,
 customer_number text,display_name text not null,normalized_name text generated always as(private.gp_customer_norm(display_name)) stored,
 category text not null default '',address text not null default '',city text not null default '',state_code text not null default '',postal_code text not null default '',
 phone text not null default '',home_phone text not null default '',work_phone text not null default '',cell text not null default '',fax text not null default '',email text not null default '',
 billing_code text not null default '',sales_person text not null default '',
 source_type text not null default 'manual' check(source_type in ('manual','directory','report')),
 identity_status text not null default 'imported' check(identity_status in ('imported','review','verified')),
 review_required boolean not null default false,review_reason text not null default '',
 source_document text,source_page integer,report_page integer,report_as_of date,ocr_confidence numeric(6,2),source_excerpt text,
 import_id uuid references public.gp_customer_imports(id),archived boolean not null default false,
 created_by uuid references auth.users(id),created_at timestamptz not null default now(),updated_at timestamptz not null default now()
);
create index if not exists gp_customers_name on public.gp_customers(normalized_name);
create index if not exists gp_customers_number on public.gp_customers(customer_number);
create table if not exists public.gp_customer_aliases(
 id uuid primary key default gen_random_uuid(),customer_id uuid not null references public.gp_customers(id),
 alias_name text not null,normalized_alias text generated always as(private.gp_customer_norm(alias_name)) stored unique,
 reason text not null,recorded_by uuid references auth.users(id),created_at timestamptz not null default now()
);
create table if not exists public.gp_customer_notes(
 id bigint generated by default as identity primary key,customer_id uuid not null references public.gp_customers(id),
 scope text not null default 'shared' check(scope in ('shared','collections','quotes','admin')),
 category text not null default 'general' check(category in ('general','contact','payment','dispute','instructions','followup')),
 subject text not null default '',note text not null check(length(btrim(note)) between 1 and 8000),
 highlighted boolean not null default false,recorded_by uuid not null references auth.users(id),created_at timestamptz not null default now()
);
create index if not exists gp_customer_notes_customer_date on public.gp_customer_notes(customer_id,created_at desc);
create table if not exists public.gp_customer_events(
 id bigint generated by default as identity primary key,customer_id uuid not null references public.gp_customers(id),
 scope text not null default 'admin',event_type text not null,note text not null,details jsonb not null default '{}'::jsonb,
 recorded_by uuid references auth.users(id),created_at timestamptz not null default now()
);
create table if not exists public.gp_customer_quote_history(
 id bigint generated by default as identity primary key,customer_id uuid references public.gp_customers(id),quote_number bigint not null,
 status text,note text,details jsonb not null,recorded_by uuid references auth.users(id),actor_name text,
 created_at timestamptz not null default now(),origin text not null default 'change'
);
create index if not exists gp_customer_quote_history_customer on public.gp_customer_quote_history(customer_id,created_at desc);
create table if not exists public.gp_customer_work_history(
 id bigint generated by default as identity primary key,customer_id uuid references public.gp_customers(id),work_order_id text not null,work_order_number text,
 source_auth_user_id uuid,source_employee_name text,note text,details jsonb not null default '{}'::jsonb,recorded_by uuid references auth.users(id),created_at timestamptz not null default now(),origin text not null default 'change'
);
create index if not exists gp_customer_work_history_customer on public.gp_customer_work_history(customer_id,created_at desc);

alter table public.collection_cases add column if not exists customer_id uuid references public.gp_customers(id);
alter table public.collection_cases add column if not exists customer_link_method text not null default 'unmatched';
alter table public.collection_source_rows add column if not exists customer_id uuid references public.gp_customers(id);
alter table public.collection_source_rows add column if not exists customer_identity_verified boolean not null default false;
alter table public.collection_account_notes add column if not exists customer_id uuid references public.gp_customers(id);
alter table public.collection_account_notes add column if not exists customer_link_method text not null default 'unmatched';
alter table public.outstanding_quotes add column if not exists customer_id uuid references public.gp_customers(id);
alter table public.outstanding_quotes add column if not exists customer_link_method text not null default 'unmatched';
create index if not exists gp_collection_cases_customer on public.collection_cases(customer_id);
create index if not exists gp_collection_rows_customer on public.collection_source_rows(customer_id);
create index if not exists gp_collection_account_notes_customer_id on public.collection_account_notes(customer_id);
create index if not exists gp_quotes_customer on public.outstanding_quotes(customer_id);

-- Only unique exact names or explicit administrator aliases link accounts.
-- Legal suffixes are retained: similar names never merge automatically.
create or replace function private.gp_customer_resolve(p_name text)
returns uuid language plpgsql stable security definer set search_path='' as $$
declare n text:=private.gp_customer_norm(p_name);v uuid;cnt integer;begin
 if length(n)<2 then return null;end if;
 select a.customer_id into v from public.gp_customer_aliases a join public.gp_customers c on c.id=a.customer_id where a.normalized_alias=n and not c.archived;
 if found then return v;end if;
 select count(*),min(id::text)::uuid into cnt,v from public.gp_customers where normalized_name=n and not archived;
 if cnt=1 and exists(select 1 from public.gp_customers where id=v and identity_status<>'review') then return v;end if;
 return null;
end$$;
create or replace function private.gp_customer_for_report(p_name text)
returns uuid language plpgsql security definer set search_path='' as $$
declare v uuid;n text:=private.gp_customer_norm(p_name);begin
 if length(n)<2 or n like 'GLASSQUEST CUSTOMER NOT PROVIDED%' then return null;end if;
 v:=private.gp_customer_resolve(p_name);if v is not null then return v;end if;
 if exists(select 1 from public.gp_customers where normalized_name=n and not archived) then return null;end if;
 insert into public.gp_customers(directory_key,display_name,source_type,created_by)
 values('report:'||n,btrim(p_name),'report',auth.uid()) on conflict(directory_key) do nothing returning id into v;
 return coalesce(v,private.gp_customer_resolve(p_name));
end$$;
create or replace function private.gp_customer_attach_record()
returns trigger language plpgsql security definer set search_path='' as $$
declare obj jsonb:=to_jsonb(new);v uuid;begin
 if tg_op='UPDATE' and obj->>'customer_id' is distinct from to_jsonb(old)->>'customer_id' and current_setting('gp.customer_manual_link',true)='yes' then return new;end if;
 if tg_table_name='collection_cases' and (coalesce((obj->>'legacy_unmatched')::boolean,false) or obj->>'legacy_linked_to' is not null) then new.customer_id:=null;new.customer_link_method:='unmatched';return new;end if;
 if tg_table_name in ('collection_cases','outstanding_quotes') and tg_op='UPDATE' and new.customer_id is not null and obj->>'customer_name'=to_jsonb(old)->>'customer_name' then return new;end if;
 v:=case when tg_table_name='collection_source_rows' then private.gp_customer_resolve(obj->>'customer_name') else private.gp_customer_for_report(obj->>'customer_name') end;new.customer_id:=v;
 if tg_table_name='collection_source_rows' then new.customer_identity_verified:=exists(select 1 from public.gp_customer_aliases where customer_id=v and normalized_alias=private.gp_customer_norm(obj->>'customer_name'));end if;
 if tg_table_name in ('collection_cases','outstanding_quotes') then
  new.customer_link_method:=case when v is null then 'unmatched' when exists(select 1 from public.gp_customer_aliases where normalized_alias=private.gp_customer_norm(obj->>'customer_name')) then 'verified_alias' else 'exact_name' end;
 end if;
 return new;
end$$;
drop trigger if exists gp_customer_attach on public.collection_cases;
create trigger gp_customer_attach before insert or update of customer_name,customer_id,legacy_unmatched,legacy_linked_to on public.collection_cases for each row execute function private.gp_customer_attach_record();
drop trigger if exists gp_customer_attach on public.collection_source_rows;
create trigger gp_customer_attach before insert or update of customer_name on public.collection_source_rows for each row execute function private.gp_customer_attach_record();
drop trigger if exists gp_customer_attach on public.collection_account_notes;
create trigger gp_customer_attach before insert or update of customer_name on public.collection_account_notes for each row execute function private.gp_customer_attach_record();
drop trigger if exists gp_customer_attach on public.outstanding_quotes;
create trigger gp_customer_attach before insert or update of customer_name,customer_id on public.outstanding_quotes for each row execute function private.gp_customer_attach_record();

create or replace function private.gp_customer_attach_snapshot()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.status='complete' and old.status is distinct from new.status then
  update public.collection_source_rows s set customer_id=private.gp_customer_for_report(s.customer_name),customer_identity_verified=exists(select 1 from public.gp_customer_aliases a where a.normalized_alias=private.gp_customer_norm(s.customer_name)) where s.import_id=new.id and coalesce(s.raw->>'customer_missing','false')<>'true';
 end if;return new;
end$$;
drop trigger if exists gp_customer_snapshot on public.collection_imports;
create trigger gp_customer_snapshot after update of status on public.collection_imports for each row execute function private.gp_customer_attach_snapshot();
create or replace function private.gp_customer_attach_case_evidence()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.customer_id is not null and new.legacy_linked_to is null then
  update public.collection_source_rows set customer_id=new.customer_id,customer_identity_verified=new.customer_link_method in ('manual','verified_alias') where case_key=new.case_key or (source='glassquest' and case_key=new.glassquest_case_key);
 end if;return new;
end$$;
drop trigger if exists gp_customer_case_evidence on public.collection_cases;
create trigger gp_customer_case_evidence after update of customer_id,glassquest_case_key on public.collection_cases for each row execute function private.gp_customer_attach_case_evidence();

create or replace function private.gp_customer_capture_quote()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 if tg_op='UPDATE' and (new.status,new.call_data,new.admin_coaching_note) is not distinct from (old.status,old.call_data,old.admin_coaching_note) then return new;end if;
 insert into public.gp_customer_quote_history(customer_id,quote_number,status,note,details,recorded_by,actor_name)
 values(new.customer_id,new.quote_number,new.status,concat_ws(E'\n',nullif(new.call_data->>'notes',''),case when nullif(new.admin_coaching_note,'') is not null then 'Manager note: '||new.admin_coaching_note end),
 jsonb_build_object('call_data',new.call_data,'admin_coaching_note',new.admin_coaching_note,'total',new.total,'module',new.module,'previous_status',case when tg_op='UPDATE' then old.status else null end),auth.uid(),coalesce((select u.employee_name from public.app_users u where u.auth_user_id=auth.uid()),new.call_data->>'csr_stamp'));
 return new;
end$$;
drop trigger if exists gp_customer_quote_history on public.outstanding_quotes;
create trigger gp_customer_quote_history after insert or update on public.outstanding_quotes for each row execute function private.gp_customer_capture_quote();

create or replace function private.gp_customer_attach_work_order()
returns trigger language plpgsql security definer set search_path='' as $$
declare obj jsonb:=to_jsonb(new);v uuid;begin
 if current_setting('gp.customer_manual_link',true)='yes' and tg_op='UPDATE' and obj->>'customer_id' is distinct from to_jsonb(old)->>'customer_id' then return new;end if;
 if tg_op='UPDATE' and obj->>'customer_link_method'='manual' and obj->>'wo_number'=to_jsonb(old)->>'wo_number' then return new;end if;
 if coalesce(obj->>'wo_number','')~'^Q-[0-9]{1,16}$' then select customer_id into v from public.outstanding_quotes where quote_number=substring(obj->>'wo_number' from 3)::bigint;new.customer_id:=v;end if;
 return new;
end$$;
create or replace function private.gp_customer_capture_work_order()
returns trigger language plpgsql security definer set search_path='' as $$
declare obj jsonb:=to_jsonb(new);oldobj jsonb;begin
 if tg_op='UPDATE' then oldobj:=to_jsonb(old);if (obj->>'spec_notes',obj->>'materials_used',obj->>'glass_spec',obj->>'status') is not distinct from (oldobj->>'spec_notes',oldobj->>'materials_used',oldobj->>'glass_spec',oldobj->>'status') then return new;end if;end if;
 insert into public.gp_customer_work_history(customer_id,work_order_id,work_order_number,source_auth_user_id,source_employee_name,note,details,recorded_by)
 values(new.customer_id,obj->>'id',obj->>'wo_number',nullif(obj->>'auth_user_id','')::uuid,obj->>'employee_name',obj->>'spec_notes',jsonb_build_object('materials_used',obj->>'materials_used','glass_spec',obj->>'glass_spec','status',obj->>'status','work_date',obj->>'work_date','job_type',obj->>'job_type','job_amount',obj->>'job_amount'),auth.uid());
 return new;
end$$;
do $$begin if to_regclass('public.commission_logs') is not null then
 alter table public.commission_logs add column if not exists customer_id uuid references public.gp_customers(id);
 alter table public.commission_logs add column if not exists customer_link_method text not null default 'unmatched';
 create index if not exists gp_commission_customer on public.commission_logs(customer_id);
 drop trigger if exists gp_customer_work_attach on public.commission_logs;
 create trigger gp_customer_work_attach before insert or update of wo_number,customer_id on public.commission_logs for each row execute function private.gp_customer_attach_work_order();
 drop trigger if exists gp_customer_work_history on public.commission_logs;
 create trigger gp_customer_work_history after insert or update on public.commission_logs for each row execute function private.gp_customer_capture_work_order();
 update public.commission_logs w set customer_id=q.customer_id from public.outstanding_quotes q where w.wo_number='Q-'||q.quote_number and w.customer_link_method<>'manual';
 insert into public.gp_customer_work_history(customer_id,work_order_id,work_order_number,source_auth_user_id,source_employee_name,note,details,origin)
 select w.customer_id,to_jsonb(w)->>'id',to_jsonb(w)->>'wo_number',nullif(to_jsonb(w)->>'auth_user_id','')::uuid,to_jsonb(w)->>'employee_name',to_jsonb(w)->>'spec_notes',jsonb_build_object('materials_used',to_jsonb(w)->>'materials_used','glass_spec',to_jsonb(w)->>'glass_spec','status',to_jsonb(w)->>'status','work_date',to_jsonb(w)->>'work_date','job_amount',to_jsonb(w)->>'job_amount'),'existing_snapshot'
 from public.commission_logs w where not exists(select 1 from public.gp_customer_work_history h where h.work_order_id=to_jsonb(w)->>'id');
end if;end$$;

-- Resolve existing records, while retaining their original notes and source keys.
update public.collection_cases set customer_id=private.gp_customer_for_report(customer_name),customer_link_method='exact_name' where customer_id is null and not legacy_unmatched and legacy_linked_to is null;
update public.outstanding_quotes set customer_id=private.gp_customer_for_report(customer_name),customer_link_method='exact_name' where customer_id is null;
update public.collection_source_rows set customer_id=private.gp_customer_resolve(customer_name) where customer_id is null and coalesce(raw->>'customer_missing','false')<>'true';
update public.collection_account_notes set customer_id=private.gp_customer_resolve(customer_name) where customer_id is null;
insert into public.gp_customer_quote_history(customer_id,quote_number,status,note,details,actor_name,origin)
select q.customer_id,q.quote_number,q.status,concat_ws(E'\n',nullif(q.call_data->>'notes',''),nullif(q.admin_coaching_note,'')),jsonb_build_object('call_data',q.call_data,'admin_coaching_note',q.admin_coaching_note,'total',q.total,'module',q.module),q.call_data->>'csr_stamp','existing_snapshot'
from public.outstanding_quotes q where not exists(select 1 from public.gp_customer_quote_history h where h.quote_number=q.quote_number);

create or replace function public.gp_customer_relink_reports()
returns jsonb language plpgsql security definer set search_path='' as $$
declare n integer;m integer;begin
 if not private.gp_is_admin() then raise exception 'Administrator permission required';end if;
 perform pg_advisory_xact_lock(hashtextextended('gp-customer-registry',0));
 perform set_config('gp.customer_manual_link','yes',true);
 update public.collection_cases set customer_id=private.gp_customer_resolve(customer_name),customer_link_method=case when private.gp_customer_resolve(customer_name) is null then 'unmatched' when exists(select 1 from public.gp_customer_aliases a where a.normalized_alias=private.gp_customer_norm(customer_name)) then 'verified_alias' else 'exact_name' end where customer_link_method<>'manual' and not legacy_unmatched and legacy_linked_to is null;
 get diagnostics n=row_count;
 update public.outstanding_quotes set customer_id=private.gp_customer_resolve(customer_name),customer_link_method=case when private.gp_customer_resolve(customer_name) is null then 'unmatched' when exists(select 1 from public.gp_customer_aliases a where a.normalized_alias=private.gp_customer_norm(customer_name)) then 'verified_alias' else 'exact_name' end where customer_link_method<>'manual';
 get diagnostics m=row_count;
 update public.collection_source_rows s set customer_id=coalesce((select c.customer_id from public.collection_cases c where c.case_key=s.case_key and c.customer_link_method='manual' and c.legacy_linked_to is null limit 1),private.gp_customer_resolve(s.customer_name)),customer_identity_verified=exists(select 1 from public.gp_customer_aliases a where a.normalized_alias=private.gp_customer_norm(s.customer_name)) or exists(select 1 from public.collection_cases c where c.case_key=s.case_key and c.customer_link_method='manual' and c.legacy_linked_to is null) where coalesce(s.raw->>'customer_missing','false')<>'true';
 update public.collection_account_notes set customer_id=private.gp_customer_resolve(customer_name),customer_link_method='exact_name' where customer_link_method<>'manual';
 update public.gp_customer_quote_history h set customer_id=q.customer_id from public.outstanding_quotes q where h.quote_number=q.quote_number;
 if to_regclass('public.commission_logs') is not null then
  execute 'update public.commission_logs w set customer_id=q.customer_id from public.outstanding_quotes q where w.wo_number=''Q-''||q.quote_number and w.customer_link_method<>''manual''';
  execute 'update public.gp_customer_work_history h set customer_id=w.customer_id from public.commission_logs w where h.work_order_id=w.id::text';
 end if;
 return jsonb_build_object('collection_records',n,'quotes',m);
end$$;

create or replace function public.gp_import_customer_directory(p_rows jsonb,p_file_name text,p_sha256 text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare batch uuid;r jsonb;cid uuid;existing public.gp_customers%rowtype;made integer:=0;refreshed integer:=0;reviews integer:=0;is_review boolean;key text;begin
 if not private.gp_is_admin() then raise exception 'Administrator permission required';end if;
 if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) not between 1 and 5000 or octet_length(p_rows::text)>10000000 or p_sha256 is null or p_sha256!~'^[a-f0-9]{64}$' then raise exception 'Invalid directory import';end if;
 perform pg_advisory_xact_lock(hashtextextended('gp-customer-registry',0));
 if exists(select 1 from public.gp_customer_imports where file_sha256=p_sha256) then raise exception 'This exact customer file is already imported';end if;
 if exists(select j.value->>'import_key' from jsonb_array_elements(p_rows) as j(value) group by j.value->>'import_key' having count(*)>1) then raise exception 'Directory import keys must be unique';end if;
 insert into public.gp_customer_imports(file_name,file_sha256,row_count,imported_by) values(left(coalesce(p_file_name,'Customer directory.csv'),200),p_sha256,jsonb_array_length(p_rows),auth.uid()) returning id into batch;
 for r in select value from jsonb_array_elements(p_rows) loop
  if length(btrim(coalesce(r->>'customer_name',''))) not between 2 and 250 or length(coalesce(r->>'import_key','')) not between 2 and 250 then raise exception 'Customer name or stable import key is missing';end if;
  key:=r->>'import_key';is_review:=coalesce((r->>'identity_review_required')::boolean,false);
  select * into existing from public.gp_customers where directory_key=key for update;cid:=existing.id;
  if cid is null and not is_review then
   cid:=private.gp_customer_resolve(r->>'customer_name');
   if cid is not null and exists(select 1 from public.gp_customers where id=cid and source_type<>'report') then cid:=null;end if;
  end if;
  if existing.id is not null and existing.normalized_name<>private.gp_customer_norm(r->>'customer_name') then
   key:=left(key,160)||':review:'||left(p_sha256,16);cid:=null;is_review:=true;
   r:=r||jsonb_build_object('review_required',true,'review_reason','Customer number/name conflicts with an existing directory record. Verify identity.');
  end if;
  if cid is null then
   insert into public.gp_customers(directory_key,display_name,source_type,created_by) values(key,btrim(r->>'customer_name'),'directory',auth.uid()) returning id into cid;made:=made+1;
  else refreshed:=refreshed+1;end if;
  if coalesce((r->>'review_required')::boolean,false) or is_review then reviews:=reviews+1;end if;
  -- Human-verified edits remain authoritative on later directory reimports.
  update public.gp_customers c set directory_key=key,customer_number=case when c.identity_status='verified' then c.customer_number else left(coalesce(r->>'customer_number',''),100) end,
   display_name=case when c.identity_status='verified' then c.display_name else btrim(r->>'customer_name') end,
   category=case when c.identity_status='verified' then c.category else left(coalesce(r->>'category',''),40) end,address=case when c.identity_status='verified' then c.address else left(coalesce(r->>'address',''),1000) end,
   city=case when c.identity_status='verified' then c.city else left(coalesce(r->>'city',''),200) end,state_code=case when c.identity_status='verified' then c.state_code else left(coalesce(r->>'state',''),30) end,postal_code=case when c.identity_status='verified' then c.postal_code else left(coalesce(r->>'postal_code',''),30) end,
   phone=case when c.identity_status='verified' then c.phone else left(coalesce(r->>'phone',''),100) end,home_phone=case when c.identity_status='verified' then c.home_phone else left(coalesce(r->>'home_phone',''),100) end,work_phone=case when c.identity_status='verified' then c.work_phone else left(coalesce(r->>'work_phone',''),100) end,cell=case when c.identity_status='verified' then c.cell else left(coalesce(r->>'cell',''),100) end,fax=case when c.identity_status='verified' then c.fax else left(coalesce(r->>'fax',''),100) end,email=case when c.identity_status='verified' then c.email else left(coalesce(r->>'email',''),300) end,
   billing_code=case when c.identity_status='verified' then c.billing_code else left(coalesce(r->>'billing_code',''),100) end,sales_person=case when c.identity_status='verified' then c.sales_person else left(coalesce(r->>'sales_person',''),250) end,source_type='directory',
   identity_status=case when c.identity_status='verified' then 'verified' when is_review then 'review' else 'imported' end,
   review_required=case when c.identity_status='verified' then false else coalesce((r->>'review_required')::boolean,false) or is_review end,review_reason=left(coalesce(r->>'review_reason',''),2000),
   source_document=left(coalesce(r->>'source_document',''),200),source_page=nullif(r->>'source_page','')::integer,report_page=nullif(r->>'report_page','')::integer,report_as_of=nullif(r->>'report_as_of','')::date,ocr_confidence=nullif(r->>'ocr_confidence','')::numeric,source_excerpt=left(coalesce(r->>'source_excerpt',''),8000),import_id=batch,updated_at=now() where c.id=cid;
 end loop;
 perform public.gp_customer_relink_reports();
 update public.gp_customer_imports set created_count=made,updated_count=refreshed,review_count=reviews where id=batch;
 return jsonb_build_object('created',made,'updated',refreshed,'review',reviews,'import_id',batch);
end$$;

create or replace function public.gp_customer_save(p_customer_id uuid,p_fields jsonb,p_reason text)
returns uuid language plpgsql security definer set search_path='' as $$
declare v_id uuid:=p_customer_id;oldrow jsonb;begin
 if not private.gp_is_admin() then raise exception 'Administrator permission required';end if;
 if length(btrim(coalesce(p_fields->>'display_name',''))) not between 2 and 250 or length(btrim(coalesce(p_reason,''))) not between 4 and 8000 then raise exception 'Customer name and audit reason are required';end if;
 perform pg_advisory_xact_lock(hashtextextended('gp-customer-registry',0));
 if v_id is null then insert into public.gp_customers(display_name,source_type,identity_status,created_by) values(btrim(p_fields->>'display_name'),'manual','verified',auth.uid()) returning gp_customers.id into v_id;
 else select to_jsonb(c) into oldrow from public.gp_customers c where c.id=v_id for update;if not found then raise exception 'Customer not found';end if;end if;
 update public.gp_customers c set display_name=btrim(p_fields->>'display_name'),customer_number=left(coalesce(p_fields->>'customer_number',c.customer_number),100),category=left(coalesce(p_fields->>'category',c.category),40),address=left(coalesce(p_fields->>'address',c.address),1000),city=left(coalesce(p_fields->>'city',c.city),200),state_code=left(coalesce(p_fields->>'state_code',c.state_code),30),postal_code=left(coalesce(p_fields->>'postal_code',c.postal_code),30),phone=left(coalesce(p_fields->>'phone',c.phone),100),home_phone=left(coalesce(p_fields->>'home_phone',c.home_phone),100),work_phone=left(coalesce(p_fields->>'work_phone',c.work_phone),100),fax=left(coalesce(p_fields->>'fax',c.fax),100),billing_code=left(coalesce(p_fields->>'billing_code',c.billing_code),100),sales_person=left(coalesce(p_fields->>'sales_person',c.sales_person),250),cell=left(coalesce(p_fields->>'cell',c.cell),100),email=left(coalesce(p_fields->>'email',c.email),300),identity_status='verified',review_required=false,updated_at=now() where c.id=v_id;
 insert into public.gp_customer_events(customer_id,event_type,note,details,recorded_by) values(v_id,'profile_update',btrim(p_reason),jsonb_build_object('previous',oldrow,'changes',p_fields),auth.uid());
 perform public.gp_customer_relink_reports();return v_id;
end$$;

create or replace function public.gp_customer_add_alias(p_customer_id uuid,p_alias text,p_reason text)
returns void language plpgsql security definer set search_path='' as $$
begin
 if not private.gp_is_admin() then raise exception 'Administrator permission required';end if;
 if length(btrim(coalesce(p_alias,''))) not between 2 and 250 or length(btrim(coalesce(p_reason,''))) not between 4 and 8000 then raise exception 'Alias and verification reason required';end if;
 perform pg_advisory_xact_lock(hashtextextended('gp-customer-registry',0));
 if exists(select 1 from public.gp_customer_aliases where normalized_alias=private.gp_customer_norm(p_alias) and customer_id<>p_customer_id) then raise exception 'This alias belongs to another customer; resolve the conflict first';end if;
 insert into public.gp_customer_aliases(customer_id,alias_name,reason,recorded_by) values(p_customer_id,btrim(p_alias),btrim(p_reason),auth.uid()) on conflict(normalized_alias) do nothing;
 insert into public.gp_customer_events(customer_id,event_type,note,details,recorded_by) values(p_customer_id,'verified_alias',btrim(p_reason),jsonb_build_object('alias',p_alias),auth.uid());
 perform public.gp_customer_relink_reports();
end$$;
create or replace function public.gp_customer_link_record(p_customer_id uuid,p_source text,p_record_id text,p_reason text)
returns void language plpgsql security definer set search_path='' as $$
declare changed integer;begin
 if not private.gp_is_admin() then raise exception 'Administrator permission required';end if;
 if length(btrim(coalesce(p_reason,''))) not between 4 and 8000 or not exists(select 1 from public.gp_customers where id=p_customer_id and not archived) then raise exception 'A customer and verification reason are required';end if;
 perform pg_advisory_xact_lock(hashtextextended('gp-customer-registry',0));perform set_config('gp.customer_manual_link','yes',true);
 if p_source='collections' then update public.collection_cases set customer_id=p_customer_id,customer_link_method='manual' where id=p_record_id::uuid and not legacy_unmatched and legacy_linked_to is null;
 elsif p_source='quotes' then update public.outstanding_quotes set customer_id=p_customer_id,customer_link_method='manual' where quote_number=p_record_id::bigint;
 elsif p_source='account_note' then update public.collection_account_notes set customer_id=p_customer_id,customer_link_method='manual' where id=p_record_id::bigint;
 elsif p_source='work_order' and to_regclass('public.commission_logs') is not null then execute 'update public.commission_logs set customer_id=$1,customer_link_method=''manual'' where id::text=$2' using p_customer_id,p_record_id;
 else raise exception 'Unsupported record type';end if;
 get diagnostics changed=row_count;if changed<>1 then raise exception 'Record not found or requires GlassQuest identity matching first';end if;
 if p_source='quotes' then update public.gp_customer_quote_history set customer_id=p_customer_id where quote_number=p_record_id::bigint;end if;
 if p_source='work_order' then update public.gp_customer_work_history set customer_id=p_customer_id where work_order_id=p_record_id;end if;
 insert into public.gp_customer_events(customer_id,event_type,note,details,recorded_by) values(p_customer_id,'record_link',btrim(p_reason),jsonb_build_object('source',p_source,'record_id',p_record_id),auth.uid());
end$$;

create or replace function public.gp_customer_add_note(p_customer_id uuid,p_scope text,p_category text,p_subject text,p_note text,p_highlighted boolean default false)
returns bigint language plpgsql security definer set search_path='' as $$
declare id bigint;begin
 if not private.gp_customer_access() then raise exception 'Customer access required';end if;
 if p_scope is null or p_scope not in ('shared','collections','quotes','admin') or (p_scope='collections' and not private.gp_has_permission('collections')) or (p_scope='quotes' and not private.gp_has_permission('quotes')) or (p_scope='admin' and not private.gp_is_admin()) then raise exception 'Note scope is not permitted';end if;
 if p_category is null or p_category not in ('general','contact','payment','dispute','instructions','followup') or length(btrim(coalesce(p_note,''))) not between 1 and 8000 or length(coalesce(p_subject,''))>150 then raise exception 'Invalid note';end if;
 insert into public.gp_customer_notes(customer_id,scope,category,subject,note,highlighted,recorded_by) values(p_customer_id,p_scope,p_category,coalesce(p_subject,''),btrim(p_note),coalesce(p_highlighted,false),auth.uid()) returning gp_customer_notes.id into id;return id;
end$$;

-- Invoker views preserve the existing RLS boundaries for every source module.
create or replace view public.gp_customer_timeline with(security_invoker=true) as
 select 'customer-note:'||n.id as event_id,n.customer_id,'customer'::text as source,'note'::text as kind,n.subject as title,n.note as body,jsonb_build_object('category',n.category,'scope',n.scope,'highlighted',n.highlighted) as details,n.recorded_by,null::text as actor_name,n.created_at as occurred_at,null::text as related_record,null::text as source_url from public.gp_customer_notes n
 union all select 'collection-action:'||a.id,c.customer_id,'collections','action',a.action_type,a.note,a.details,a.recorded_by,null,a.created_at,c.invoice_number,'collections.html?case='||c.id from public.collection_actions a join public.collection_cases c on c.id=a.case_id
 union all select 'account-note:'||n.id,n.customer_id,'collections','account_note',n.subject,n.note,jsonb_build_object('category',n.category,'highlighted',n.highlighted),n.recorded_by,null,n.created_at,null,'collections.html#notes' from public.collection_account_notes n
 union all select 'quote-history:'||h.id,h.customer_id,'quotes','quote_update','Quote #'||h.quote_number||' · '||coalesce(h.status,''),h.note,h.details,h.recorded_by,h.actor_name,h.created_at,h.quote_number::text,'quotes.html?quote='||h.quote_number from public.gp_customer_quote_history h
 union all select 'work-history:'||h.id,h.customer_id,'work_orders','work_order_update','Work order '||coalesce(h.work_order_number,h.work_order_id),h.note,h.details,h.recorded_by,h.source_employee_name,h.created_at,h.work_order_number,'commissions.html' from public.gp_customer_work_history h
 union all select 'customer-event:'||e.id,e.customer_id,'registry','audit',e.event_type,e.note,e.details,e.recorded_by,null,e.created_at,null,null from public.gp_customer_events e
 union all select 'report-row:'||s.id,s.customer_id,s.source,'report',s.transaction_type||' · '||coalesce(s.invoice_number,''),'Imported snapshot: '||i.file_name,jsonb_build_object('invoice',s.invoice_number,'date',s.transaction_date,'open_balance',s.open_balance,'original_amount',s.original_amount,'report_as_of',i.report_as_of,'report_kind',i.report_kind,'import_id',i.id),i.imported_by,null,coalesce(i.completed_at,i.created_at),s.invoice_number,'collections.html#reconcile' from public.collection_source_rows s join public.collection_imports i on i.id=s.import_id where i.status='complete';

create or replace view public.gp_customer_directory with(security_invoker=true) as
 select c.*,
 (select count(*) from public.collection_cases x where x.customer_id=c.id and x.legacy_linked_to is null and x.status in ('open','contacted','promise','disputed') and greatest(coalesce(x.mainstreet_balance,0),coalesce(x.qbo_balance,0),coalesce(x.glassquest_balance,0))>0) as active_invoice_count,
 (select count(*) from public.outstanding_quotes q where q.customer_id=c.id and q.status in ('open','follow_up')) as open_quote_count,
 (select count(*) from public.gp_customer_notes n where n.customer_id=c.id) as shared_note_count
 from public.gp_customers c;

-- Access to the directory does not grant access to another module's private notes.
do $$declare tbl text;begin
 foreach tbl in array array['gp_customers','gp_customer_aliases','gp_customer_notes','gp_customer_events','gp_customer_imports','gp_customer_quote_history','gp_customer_work_history'] loop
  execute format('alter table public.%I enable row level security',tbl);
  execute format('revoke all on public.%I from public,anon,authenticated',tbl);
  execute format('grant select on public.%I to authenticated',tbl);
 end loop;
end$$;
drop policy if exists gp_customer_read on public.gp_customers;
create policy gp_customer_read on public.gp_customers for select to authenticated using((select private.gp_customer_access()));
drop policy if exists gp_customer_alias_read on public.gp_customer_aliases;
create policy gp_customer_alias_read on public.gp_customer_aliases for select to authenticated using((select private.gp_customer_access()));
drop policy if exists gp_customer_import_read on public.gp_customer_imports;
create policy gp_customer_import_read on public.gp_customer_imports for select to authenticated using((select private.gp_is_admin()));
drop policy if exists gp_customer_note_read on public.gp_customer_notes;
create policy gp_customer_note_read on public.gp_customer_notes for select to authenticated using((select private.gp_customer_access()) and (scope='shared' or (scope='collections' and (select private.gp_has_permission('collections'))) or (scope='quotes' and (select private.gp_has_permission('quotes'))) or (scope='admin' and (select private.gp_is_admin()))));
drop policy if exists gp_customer_event_read on public.gp_customer_events;
create policy gp_customer_event_read on public.gp_customer_events for select to authenticated using((select private.gp_is_admin()));
drop policy if exists gp_customer_quote_history_read on public.gp_customer_quote_history;
create policy gp_customer_quote_history_read on public.gp_customer_quote_history for select to authenticated using((select private.gp_has_permission('quotes')));
drop policy if exists gp_customer_work_history_read on public.gp_customer_work_history;
create policy gp_customer_work_history_read on public.gp_customer_work_history for select to authenticated using((select private.gp_is_admin()) or ((select private.gp_has_permission('commission')) and source_auth_user_id=(select auth.uid())));
revoke all on public.gp_customer_timeline,public.gp_customer_directory from public,anon;
grant select on public.gp_customer_timeline,public.gp_customer_directory to authenticated;
revoke all on function private.gp_customer_resolve(text),private.gp_customer_for_report(text),private.gp_customer_attach_record(),private.gp_customer_capture_quote(),private.gp_customer_attach_snapshot(),private.gp_customer_attach_case_evidence(),private.gp_customer_attach_work_order(),private.gp_customer_capture_work_order() from public,anon,authenticated;
revoke all on function public.gp_customer_relink_reports(),public.gp_import_customer_directory(jsonb,text,text),public.gp_customer_save(uuid,jsonb,text),public.gp_customer_add_alias(uuid,text,text),public.gp_customer_link_record(uuid,text,text,text),public.gp_customer_add_note(uuid,text,text,text,text,boolean) from public,anon;
grant execute on function public.gp_customer_relink_reports(),public.gp_import_customer_directory(jsonb,text,text),public.gp_customer_save(uuid,jsonb,text),public.gp_customer_add_alias(uuid,text,text),public.gp_customer_link_record(uuid,text,text,text),public.gp_customer_add_note(uuid,text,text,text,text,boolean) to authenticated;
notify pgrst,'reload schema';
commit;

-- 2026-11-18-automatic-collections.sql
-- Verified-zero archival, audited decisions, and reopening on newer balances.
-- Requires the customer-registry and earlier Collections intelligence migrations.
begin;
alter table public.collection_imports add column if not exists auto_archived_count integer not null default 0;
alter table public.collection_imports add column if not exists auto_reopened_count integer not null default 0;
alter table public.collection_imports add column if not exists auto_review_count integer not null default 0;
create table if not exists public.gp_collection_reconciliation_runs(
 id bigint generated by default as identity primary key,import_id uuid references public.collection_imports(id),
 archived_count integer not null,reopened_count integer not null,review_count integer not null,
 review_details jsonb not null default '[]'::jsonb,recorded_by uuid references auth.users(id),created_at timestamptz not null default now()
);
create index if not exists gp_reconciliation_runs_import on public.gp_collection_reconciliation_runs(import_id,created_at desc);
create index if not exists gp_collection_rows_customer_invoice on public.collection_source_rows(customer_id,invoice_number,transaction_date) where transaction_type='invoice';
alter table public.gp_collection_reconciliation_runs enable row level security;
revoke all on public.gp_collection_reconciliation_runs from public,anon,authenticated;
grant select on public.gp_collection_reconciliation_runs to authenticated;
drop policy if exists gp_collection_reconciliation_read on public.gp_collection_reconciliation_runs;
create policy gp_collection_reconciliation_read on public.gp_collection_reconciliation_runs for select to authenticated using((select private.gp_has_permission('collections')));

create or replace function private.gp_same_customer_invoice(s public.collection_source_rows,c public.collection_cases)
returns boolean language sql stable security definer set search_path='' as $$
 select s.case_key=c.case_key or (
  c.customer_id is not null and s.customer_id=c.customer_id
  and (s.customer_identity_verified or c.customer_link_method in ('manual','verified_alias'))
  and upper(regexp_replace(btrim(s.invoice_number),'\s+','','g'))=upper(regexp_replace(btrim(c.invoice_number),'\s+','','g'))
  and s.transaction_date=c.invoice_date
 );
$$;
revoke all on function private.gp_same_customer_invoice(public.collection_source_rows,public.collection_cases) from public,anon,authenticated;

create or replace function public.gp_collections_clear_verified(p_case_id uuid,p_note text)
returns void language plpgsql security definer set search_path='' as $$
declare c public.collection_cases%rowtype;r record;begin
 if not private.gp_has_permission('collections') then raise exception 'Collections permission required';end if;
 if length(btrim(coalesce(p_note,''))) not between 4 and 8000 then raise exception 'Explain the verified clearance';end if;
 perform pg_advisory_xact_lock(hashtextextended('gp-collections-import',0));
 select * into c from public.collection_cases where id=p_case_id for update;
 if not found or c.legacy_unmatched or c.legacy_linked_to is not null then raise exception 'Match the customer before clearing this case';end if;
 if c.status='reconciled' then raise exception 'This case is already archived';end if;
 if (c.needs_mainstreet_update and c.mainstreet_confirmed_at is null) or (c.needs_qbo_update and c.qbo_confirmed_at is null) then raise exception 'Confirm pending accounting corrections before archiving';end if;
 select s.*,i.report_as_of,i.completed_at,i.report_kind into r from public.collection_source_rows s join public.collection_imports i on i.id=s.import_id
 where private.gp_same_customer_invoice(s,c) and s.source='qbo' and s.transaction_type='invoice' and i.status='complete'
 order by coalesce(i.report_as_of,i.completed_at::date) desc,i.completed_at desc,i.id desc limit 1;
 if not found or r.report_kind<>'invoice_verification' or r.open_balance<>0 or r.raw->>'balance_present' is distinct from 'true' or r.report_as_of is null or r.report_as_of<coalesce(c.invoice_date,r.report_as_of) then raise exception 'Newest invoice evidence does not verify a zero QBO balance';end if;
 if exists(select 1 from public.collection_imports i where i.id=c.glassquest_import_id and i.report_as_of>r.report_as_of) then raise exception 'Verification predates the GlassQuest baseline';end if;
 if exists(select 1 from public.collection_source_rows s join public.collection_imports i on i.id=s.import_id where private.gp_same_customer_invoice(s,c) and s.transaction_type='invoice' and s.source='mainstreet' and s.open_balance>0 and i.status='complete' and (coalesce(i.report_as_of,i.completed_at::date),i.completed_at,i.id)>(r.report_as_of,r.completed_at,r.import_id)) then raise exception 'Newer Mainstreet evidence still shows a balance; investigate first';end if;
 insert into public.collection_actions(case_id,action_type,note,details,recorded_by) values(c.id,'research',btrim(p_note),jsonb_build_object('event','verified_clearance','evidence_import_id',r.import_id,'evidence_row_id',r.id,'report_as_of',r.report_as_of,'previous_status',c.status,'meaning','Zero remaining balance; may include payment, credit, or write-off'),auth.uid());
 update public.collection_cases set status='reconciled',resolved_at=now(),cleared_at=now(),cleared_report_as_of=r.report_as_of,cleared_import_id=r.import_id,next_follow_up=null,last_activity_at=now(),updated_at=now() where id=c.id;
end$$;



create or replace function private.gp_reconcile_collection_import(p_import_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare i public.collection_imports%rowtype;c public.collection_cases%rowtype;r record;reason text;
 archived integer:=0;reopened integer:=0;reviewed integer:=0;issues jsonb:='[]'::jsonb;actor uuid;
begin
 select * into i from public.collection_imports where id=p_import_id;
 if not found or i.status<>'complete' or i.source<>'qbo' then return jsonb_build_object('archived',0,'reopened',0,'review',0);end if;
 actor:=coalesce(auth.uid(),i.imported_by);
 perform pg_advisory_xact_lock(hashtextextended('gp-collections-import',0));
 -- Newer positive evidence restores the case without discarding its prior clearance.
 for c in select x.* from public.collection_cases x where x.status='reconciled' and x.cleared_import_id is not null and x.legacy_linked_to is null
  and exists(select 1 from public.collection_source_rows s join public.collection_imports old on old.id=x.cleared_import_id where s.import_id=i.id and s.transaction_type='invoice' and s.open_balance>0 and private.gp_same_customer_invoice(s,x) and (i.report_as_of,i.completed_at,i.id)>(old.report_as_of,old.completed_at,old.id))
 loop
  update public.collection_cases set status='open',resolved_at=null,last_activity_at=now(),updated_at=now() where id=c.id;
  insert into public.collection_actions(case_id,action_type,note,details,recorded_by) values(c.id,'research','Automatically reopened: a newer QBO invoice report shows a positive remaining balance.',jsonb_build_object('event','automatic_reopen','evidence_import_id',i.id,'previous_clearance_import_id',c.cleared_import_id),actor);
  reopened:=reopened+1;
 end loop;
 if i.report_kind='invoice_verification' and private.gp_is_admin() then
  for c in select x.* from public.collection_cases x where x.status<>'reconciled' and x.legacy_linked_to is null and not x.legacy_unmatched
    and exists(select 1 from public.collection_source_rows s where s.import_id=i.id and s.transaction_type='invoice' and s.open_balance=0 and s.raw->>'balance_present'='true' and private.gp_same_customer_invoice(s,x))
  loop
   reason:=null;
   if c.status='disputed' then reason:='Disputed invoice needs collector review';
   elsif c.customer_id is null and exists(select 1 from public.gp_customers x where x.normalized_name=private.gp_customer_norm(c.customer_name) and not x.archived) then reason:='Customer identity needs review';
   elsif exists(select 1 from public.collection_actions a where a.case_id=c.id and a.action_type='reopen' and a.created_at>i.completed_at) then reason:='Case was manually reopened after this report; upload newer evidence';
   elsif not exists(select 1 from public.collection_source_rows s where s.import_id=i.id and s.transaction_type='invoice' and private.gp_same_customer_invoice(s,c) and s.transaction_date=c.invoice_date) then reason:='Invoice date differs; verify invoice identity';
   elsif exists(
    select 1 from public.collection_source_rows historical
    where historical.transaction_type='invoice' and historical.source in ('mainstreet','glassquest') and historical.original_amount>0
     and (historical.case_key=c.case_key or historical.case_key=c.glassquest_case_key)
     and historical.import_id in (c.mainstreet_import_id,c.glassquest_import_id)
     and not exists(select 1 from public.collection_source_rows s where s.import_id=i.id and s.transaction_type='invoice' and private.gp_same_customer_invoice(s,c) and abs(s.original_amount-historical.original_amount)<0.01)
   ) then reason:='Original invoice amounts differ between sources; verify identity';end if;
   if reason is null then
    begin
     perform public.gp_collections_clear_verified(c.id,'Automatically archived after the newest matched QBO invoice verification report confirmed zero remaining balance. See imported evidence for payment, credit or write-off details.');
     update public.collection_actions set details=details||jsonb_build_object('mode','automatic') where id=(select max(a.id) from public.collection_actions a where a.case_id=c.id and a.details->>'event'='verified_clearance');
     archived:=archived+1;
    exception when others then reason:=sqlerrm;
    end;
   end if;
   if reason is not null then reviewed:=reviewed+1;if jsonb_array_length(issues)<200 then issues:=issues||jsonb_build_array(jsonb_build_object('case_id',c.id,'invoice',c.invoice_number,'reason',reason));end if;end if;
  end loop;
 end if;
 insert into public.gp_collection_reconciliation_runs(import_id,archived_count,reopened_count,review_count,review_details,recorded_by) values(i.id,archived,reopened,reviewed,issues,actor);
 update public.collection_imports set auto_archived_count=(select count(*) from public.collection_actions a where a.details->>'event'='verified_clearance' and a.details->>'mode'='automatic' and a.details->>'evidence_import_id'=i.id::text),auto_reopened_count=(select count(*) from public.collection_actions a where a.details->>'event'='automatic_reopen' and a.details->>'evidence_import_id'=i.id::text),auto_review_count=reviewed where id=i.id;
 return jsonb_build_object('archived',archived,'reopened',reopened,'review',reviewed,'details',issues);
end$$;
revoke all on function private.gp_reconcile_collection_import(uuid) from public,anon,authenticated;
create or replace function private.gp_reconcile_completed_import()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.status='complete' and old.status is distinct from new.status and new.source='qbo' and (private.gp_is_admin() or auth.role()='service_role') then perform private.gp_reconcile_collection_import(new.id);end if;
 return new;
end$$;
revoke all on function private.gp_reconcile_completed_import() from public,anon,authenticated;
drop trigger if exists gp_verified_balance_reconcile on public.collection_imports;
create trigger gp_verified_balance_reconcile after update of status on public.collection_imports for each row execute function private.gp_reconcile_completed_import();
create or replace function public.gp_collections_reconcile_now()
returns jsonb language plpgsql security definer set search_path='' as $$
declare i record;r jsonb;archived integer:=0;reopened integer:=0;reviewed integer:=0;begin
 if not private.gp_is_admin() then raise exception 'Administrator permission required';end if;
 for i in select distinct on(report_kind) id,report_kind,report_as_of,completed_at from public.collection_imports where source='qbo' and status='complete' and report_kind<>'account_summary' order by report_kind,report_as_of desc,completed_at desc,id desc loop
  r:=private.gp_reconcile_collection_import(i.id);archived:=archived+(r->>'archived')::integer;reopened:=reopened+(r->>'reopened')::integer;reviewed:=reviewed+(r->>'review')::integer;
 end loop;
 return jsonb_build_object('archived',archived,'reopened',reopened,'review',reviewed);
end$$;
revoke all on function public.gp_collections_reconcile_now() from public,anon;
grant execute on function public.gp_collections_reconcile_now() to authenticated;
notify pgrst,'reload schema';
commit;

