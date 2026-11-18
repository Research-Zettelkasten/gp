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
