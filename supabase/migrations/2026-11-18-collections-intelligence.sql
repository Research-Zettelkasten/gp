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
