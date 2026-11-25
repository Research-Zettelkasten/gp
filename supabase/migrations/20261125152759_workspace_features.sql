begin;

create table private.gp_workspace_release (
  feature text primary key,
  mode text not null default 'off' check (mode in ('off','admins','pilot','workspace'))
);
insert into private.gp_workspace_release(feature) values
 ('photo_intake'), ('quote_links'), ('dispatch'), ('job_search');

create table private.gp_workspace_exception (
  feature text references private.gp_workspace_release on delete cascade,
  employee_id bigint references public.app_users(id) on delete cascade,
  allowed boolean not null,
  primary key (feature, employee_id)
);
revoke all on private.gp_workspace_release, private.gp_workspace_exception from public, anon, authenticated;

create function private.gp_workspace_access(p_feature text)
returns boolean language sql stable security definer set search_path='' as $$
 select coalesce((
  select case
    when r.mode='off' or e.allowed=false then false
    when r.mode='admins' then u.perm_admin
    when r.mode='pilot' then u.perm_admin or e.allowed=true
    else true
  end
  from private.gp_workspace_release r
  join public.app_users u on u.auth_user_id=auth.uid() and u.active is true
  left join private.gp_workspace_exception e on e.feature=r.feature and e.employee_id=u.id
  where r.feature=p_feature and (
    u.perm_admin is true or
    case p_feature
      when 'dispatch' then u.perm_commission
      when 'job_search' then u.perm_commission or u.perm_quotes
      else u.perm_quotes
    end
  )
 ),false)
$$;

create function private.gp_workspace_audit(p_type text,p_details text)
returns void language sql security definer set search_path='' as $$
 insert into public.audit_logs(supervisor_name,action_type,details)
 select employee_name,p_type,p_details from public.app_users
 where auth_user_id=auth.uid() and active is true
$$;

create function public.gp_workspace_features()
returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_object_agg(feature,private.gp_workspace_access(feature))
 from private.gp_workspace_release where auth.uid() is not null
$$;

create function public.gp_workspace_permissions()
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  if not private.gp_is_admin() then raise insufficient_privilege; end if;
  return jsonb_build_object(
    'features',(select jsonb_object_agg(feature,mode) from private.gp_workspace_release),
    'exceptions',(select coalesce(jsonb_agg(e),'[]') from private.gp_workspace_exception e),
    'staff',(select coalesce(jsonb_agg(jsonb_build_object('id',id,'name',employee_name,'department',department,
      'admin',perm_admin,'commission',perm_commission,'quotes',perm_quotes) order by employee_name,id),'[]')
      from public.app_users where active is true)
  );
end
$$;

create function public.gp_set_workspace_permission(p_feature text,p_value text,p_employee_id bigint default null)
returns void language plpgsql security definer set search_path='' as $$
begin
  if not private.gp_is_admin() then raise insufficient_privilege; end if;
  if not exists (select 1 from private.gp_workspace_release where feature=p_feature) then
    raise exception 'Unknown workspace feature';
  end if;
  if p_employee_id is null then
    update private.gp_workspace_release set mode=p_value where feature=p_feature and mode is distinct from p_value;
  elsif p_value='inherit' then
    delete from private.gp_workspace_exception where feature=p_feature and employee_id=p_employee_id;
  elsif p_value in ('allow','deny') then
    if not exists(select 1 from public.app_users where id=p_employee_id and active is true) then
      raise exception 'Choose an active employee';
    end if;
    insert into private.gp_workspace_exception as e values(p_feature,p_employee_id,p_value='allow')
    on conflict(feature,employee_id) do update set allowed=excluded.allowed where e.allowed is distinct from excluded.allowed;
  else
    raise exception 'Choose inherit, allow or deny';
  end if;
  if found then
    perform private.gp_workspace_audit('WORKSPACE_PERMISSION',
      format('%s: %s (%s)',p_feature,p_value,coalesce('employee '||p_employee_id,'release mode')));
  end if;
end
$$;

create table public.gp_photo_intakes (
  id uuid primary key default gen_random_uuid(),
  title text not null check (length(btrim(title)) between 1 and 160),
  customer text not null check (length(btrim(customer)) between 1 and 180),
  site text not null default '' check (length(site)<=300),
  observations text not null default '' check (length(observations)<=4000),
  next_step text not null default 'review' check (next_step in ('review','site_visit','quote_ready')),
  quote_number bigint,
  work_order text check (length(work_order)<=80),
  photo_path text not null unique,
  markup jsonb not null default '[]',
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.gp_photo_intakes enable row level security;
revoke all on public.gp_photo_intakes from public, anon, authenticated;
grant select on public.gp_photo_intakes to authenticated;
create policy gp_photo_intake_read on public.gp_photo_intakes for select to authenticated
using ((select private.gp_workspace_access('photo_intake')));
create index gp_photo_intakes_recent on public.gp_photo_intakes(updated_at desc);
create index gp_photo_intakes_quote on public.gp_photo_intakes(quote_number) where quote_number is not null;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('gp-quote-intake','gp-quote-intake',false,5242880,array['image/jpeg']),
 ('gp-quote-customer','gp-quote-customer',false,5242880,array['image/jpeg']);

create policy gp_intake_object_upload on storage.objects for insert to authenticated
with check (bucket_id='gp-quote-intake' and (select private.gp_workspace_access('photo_intake'))
 and name ~ ('^'||(select auth.uid())::text||'/[0-9a-f-]{36}\.jpg$'));
create policy gp_intake_object_read on storage.objects for select to authenticated
using (bucket_id='gp-quote-intake' and (select private.gp_workspace_access('photo_intake')));
create policy gp_intake_object_cleanup on storage.objects for delete to authenticated
using (bucket_id='gp-quote-intake' and (select private.gp_workspace_access('photo_intake'))
 and split_part(name,'/',1)=(select auth.uid())::text
 and not exists (select 1 from public.gp_photo_intakes where photo_path=name));

create function public.gp_save_photo_intake(p_id uuid,p_revision timestamptz,p_fields jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_row public.gp_photo_intakes;
  v_path text:=p_fields->>'photo_path';
  v_quote bigint:=nullif(p_fields->>'quote_number','')::bigint;
  v_markup jsonb:=coalesce(p_fields->'markup','[]'::jsonb);
begin
  if not private.gp_workspace_access('photo_intake') then raise insufficient_privilege; end if;
  if jsonb_typeof(v_markup) is distinct from 'array' or jsonb_array_length(v_markup)>25 or octet_length(v_markup::text)>5000 then
    raise exception 'Use no more than 25 photo markers';
  end if;
  if exists(select 1 from jsonb_array_elements(v_markup) m
     where jsonb_typeof(m->'x') is distinct from 'number' or jsonb_typeof(m->'y') is distinct from 'number'
     or (m->>'x')::numeric not between 0 and 1 or (m->>'y')::numeric not between 0 and 1
     or length(btrim(coalesce(m->>'label',''))) not between 1 and 100) then raise exception 'Invalid photo marker'; end if;
  if v_quote is not null and not exists (select 1 from public.outstanding_quotes where quote_number=v_quote) then
    raise exception 'That quote number does not exist';
  end if;
  if p_id is null then
    if split_part(v_path,'/',1) is distinct from auth.uid()::text or not exists(
      select 1 from storage.objects where bucket_id='gp-quote-intake' and name=v_path
    ) then raise exception 'Upload the intake photo first'; end if;
    insert into public.gp_photo_intakes(title,customer,site,observations,next_step,quote_number,work_order,photo_path,markup)
    values(btrim(p_fields->>'title'),btrim(p_fields->>'customer'),p_fields->>'site',p_fields->>'observations',
     p_fields->>'next_step',v_quote,nullif(btrim(p_fields->>'work_order'),''),v_path,v_markup)
    returning * into v_row;
  else
    update public.gp_photo_intakes
    set title=btrim(p_fields->>'title'),customer=btrim(p_fields->>'customer'),site=p_fields->>'site',
        observations=p_fields->>'observations',next_step=p_fields->>'next_step',quote_number=v_quote,
        work_order=nullif(btrim(p_fields->>'work_order'),''),markup=v_markup,updated_at=clock_timestamp()
    where id=p_id and updated_at=p_revision returning * into v_row;
    if not found then raise exception 'This intake changed. Reopen it before saving'; end if;
  end if;
  perform private.gp_workspace_audit('PHOTO_INTAKE',format('Saved intake %s (%s)',v_row.id,v_row.next_step));
  return to_jsonb(v_row);
end
$$;

create table private.gp_customer_quote_link (
  id uuid primary key default gen_random_uuid(),
  quote_number bigint not null references public.outstanding_quotes(quote_number) on delete cascade,
  token_hash bytea not null unique,
  customer text not null,
  options jsonb not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index gp_quote_share_reference on private.gp_customer_quote_link(quote_number,created_at desc);
create table private.gp_customer_quote_reply (
  id bigint generated always as identity primary key,
  link_id uuid not null references private.gp_customer_quote_link on delete cascade,
  kind text not null check(kind in ('question','answer','approval')),
  body text not null,
  approved_option integer,
  created_at timestamptz not null default now()
);
create index gp_quote_reply_link on private.gp_customer_quote_reply(link_id,id);
create unique index gp_quote_approval_once on private.gp_customer_quote_reply(link_id) where kind='approval';

create table private.gp_customer_quote_upload (
  id uuid primary key default gen_random_uuid(),
  link_id uuid not null references private.gp_customer_quote_link on delete cascade,
  created_at timestamptz not null default now()
);
create index gp_quote_upload_link on private.gp_customer_quote_upload(link_id);
revoke all on private.gp_customer_quote_link,private.gp_customer_quote_reply,private.gp_customer_quote_upload from public,anon,authenticated;

create function private.gp_quote_token_hash(p_token text)
returns bytea language sql immutable set search_path='' as $$
 select sha256(convert_to(p_token,'UTF8'))
$$;

create function private.gp_quote_link_open(p_link private.gp_customer_quote_link)
returns boolean language sql stable security definer set search_path='' as $$
 select p_link.revoked_at is null and p_link.expires_at>now() and exists (
  select 1 from private.gp_workspace_release r
  join public.app_users u on u.auth_user_id=p_link.created_by and u.active is true
  left join private.gp_workspace_exception e on e.feature=r.feature and e.employee_id=u.id
  where r.feature='quote_links' and r.mode<>'off' and e.allowed is distinct from false
  and (u.perm_admin is true or (u.perm_quotes is true and (r.mode='workspace' or (r.mode='pilot' and e.allowed is true))))
 )
$$;

create function public.gp_publish_quote_link(p_quote bigint,p_options jsonb,p_days integer)
returns text language plpgsql security definer set search_path='' as $$
declare
  v_token text:=replace(gen_random_uuid()::text||gen_random_uuid()::text,'-','');
  v_customer text;
begin
  if not private.gp_workspace_access('quote_links') then raise insufficient_privilege; end if;
  if jsonb_typeof(p_options) is distinct from 'array' or jsonb_array_length(p_options) not between 1 and 3
      or octet_length(p_options::text)>8000 or p_days is null or p_days not between 1 and 30 then
    raise exception 'Provide one to three options and an expiration between 1 and 30 days';
  end if;
  if exists (select 1 from jsonb_array_elements(p_options) o
    where jsonb_typeof(o) is distinct from 'object'
    or o-array['label','amount','description']<>'{}'::jsonb
    or length(btrim(coalesce(o->>'label',''))) not between 1 and 80
    or length(btrim(coalesce(o->>'description',''))) not between 1 and 1500
    or coalesce(o->>'amount','') !~ '^[0-9]{1,8}(\.[0-9]{1,2})?$'
  ) then raise exception 'Each option needs a label, a total in dollars, and a customer-facing description'; end if;

  select customer_name into v_customer from public.outstanding_quotes where quote_number=p_quote for update;
  if not found then raise exception 'Quote not found'; end if;
  update private.gp_customer_quote_link set revoked_at=now()
  where quote_number=p_quote and revoked_at is null and expires_at>now();
  insert into private.gp_customer_quote_link(quote_number,token_hash,customer,options,expires_at,created_by)
  values(p_quote,private.gp_quote_token_hash(v_token),v_customer,p_options,now()+make_interval(days=>p_days),auth.uid());
  perform private.gp_workspace_audit('CUSTOMER_QUOTE_LINK',format('Published customer link for quote %s',p_quote));
  return v_token;
end
$$;

create function public.gp_quote_link_staff(p_quote bigint)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  if not private.gp_workspace_access('quote_links') then raise insufficient_privilege; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('id',l.id,'expires_at',l.expires_at,'active',private.gp_quote_link_open(l),
      'options',l.options,'replies',(select coalesce(jsonb_agg(jsonb_build_object('kind',r.kind,'body',r.body,
        'approved_option',r.approved_option,'created_at',r.created_at) order by r.id),'[]')
        from private.gp_customer_quote_reply r where r.link_id=l.id),
      'photos',(select coalesce(jsonb_agg(o.name order by u.created_at),'[]') from private.gp_customer_quote_upload u
        join storage.objects o on o.bucket_id='gp-quote-customer' and o.name=u.id::text||'.jpg' where u.link_id=l.id)
      ) order by l.created_at desc)
    from (select * from private.gp_customer_quote_link where quote_number=p_quote order by created_at desc limit 20) l
  ),'[]'::jsonb);
end
$$;

create function public.gp_manage_quote_link(p_link uuid,p_action text,p_body text default '')
returns void language plpgsql security definer set search_path='' as $$
declare v_link private.gp_customer_quote_link;
begin
  if not private.gp_workspace_access('quote_links') then raise insufficient_privilege; end if;
  select * into v_link from private.gp_customer_quote_link where id=p_link for update;
  if not found then raise exception 'Link not found'; end if;
  if p_action='revoke' then
    update private.gp_customer_quote_link set revoked_at=now() where id=p_link and revoked_at is null;
  elsif p_action='answer' and private.gp_quote_link_open(v_link) and length(btrim(p_body)) between 1 and 1600 then
    insert into private.gp_customer_quote_reply(link_id,kind,body) values(p_link,'answer',btrim(p_body));
  else
    raise exception 'Choose an active link and enter an answer';
  end if;
  perform private.gp_workspace_audit('CUSTOMER_QUOTE_LINK',format('%s on quote %s',p_action,v_link.quote_number));
end
$$;

create function public.gp_customer_quote(p_token text,p_action text default 'view',p_body text default '',p_option integer default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_link private.gp_customer_quote_link;
  v_upload uuid;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then return null; end if;
  if p_action='view' then
    select * into v_link from private.gp_customer_quote_link where token_hash=private.gp_quote_token_hash(p_token);
  else
    select * into v_link from private.gp_customer_quote_link where token_hash=private.gp_quote_token_hash(p_token) for update;
  end if;
  if not found or not private.gp_quote_link_open(v_link) then return null; end if;
  case p_action
    when 'view' then null;
    when 'question' then
      if length(btrim(coalesce(p_body,''))) not between 1 and 1600 then raise exception 'Enter a question of up to 1,600 characters'; end if;
      if (select count(*) from private.gp_customer_quote_reply where link_id=v_link.id and kind='question')>=12 then
        raise exception 'Question limit reached. Please contact GLASSPRO directly';
      end if;
      insert into private.gp_customer_quote_reply(link_id,kind,body) values(v_link.id,'question',btrim(p_body));
    when 'approve' then
      if p_option is null or p_option not between 0 and jsonb_array_length(v_link.options)-1
         or length(btrim(coalesce(p_body,''))) not between 2 and 120 then raise exception 'Select an option and enter your name'; end if;
      insert into private.gp_customer_quote_reply(link_id,kind,body,approved_option)
      values(v_link.id,'approval',btrim(p_body),p_option) on conflict do nothing;
    when 'photo' then
      if (select count(*) from private.gp_customer_quote_upload where link_id=v_link.id)>=3 then
        raise exception 'Photo limit reached. Please contact GLASSPRO directly';
      end if;
      insert into private.gp_customer_quote_upload(link_id) values(v_link.id) returning id into v_upload;
      return jsonb_build_object('photo_path',v_upload::text||'.jpg');
    else raise exception 'Unknown customer quote action';
  end case;
  return jsonb_build_object('quote_number',v_link.quote_number,'customer',v_link.customer,
    'options',v_link.options,'expires_at',v_link.expires_at,'replies',(
     select coalesce(jsonb_agg(jsonb_build_object('kind',kind,'body',body,'approved_option',approved_option,'created_at',created_at) order by id),'[]')
     from private.gp_customer_quote_reply where link_id=v_link.id));
end
$$;

create function private.gp_quote_upload_allowed(p_path text)
returns boolean language sql stable security definer set search_path='' as $$
 select case when p_path ~ '^[0-9a-f-]{36}\.jpg$' then exists(
  select 1 from private.gp_customer_quote_upload u join private.gp_customer_quote_link l on l.id=u.link_id
  where u.id::text=split_part(p_path,'.',1) and u.created_at>now()-interval '15 minutes' and private.gp_quote_link_open(l)
 ) else false end
$$;
create policy gp_customer_quote_photo_upload on storage.objects for insert to anon,authenticated
with check (bucket_id='gp-quote-customer' and private.gp_quote_upload_allowed(name));
create policy gp_customer_quote_photo_read on storage.objects for select to authenticated
using (bucket_id='gp-quote-customer' and (select private.gp_workspace_access('quote_links')));

create table public.gp_dispatch_stops (
  id uuid primary key default gen_random_uuid(),
  title text not null check (length(btrim(title)) between 1 and 160),
  site text not null check (length(btrim(site)) between 1 and 300),
  crew text not null default '' check (length(crew)<=100),
  kind text not null check (kind in ('install','service','pickup','emergency')),
  status text not null check (status in ('scheduled','in_progress','done','cancelled')),
  starts_at timestamptz not null,
  ends_at timestamptz not null check (ends_at>starts_at and ends_at<=starts_at+interval '24 hours'),
  latitude double precision not null check (latitude between -85 and 85),
  longitude double precision not null check (longitude between -180 and 180),
  work_order text check (length(work_order)<=80),
  notes text not null default '' check (length(notes)<=4000),
  updated_at timestamptz not null default now()
);
create index gp_dispatch_starts on public.gp_dispatch_stops(starts_at);
create index gp_dispatch_crew_starts on public.gp_dispatch_stops(lower(crew),starts_at)
where status in ('scheduled','in_progress');
alter table public.gp_dispatch_stops enable row level security;
revoke all on public.gp_dispatch_stops from public,anon,authenticated;
grant select on public.gp_dispatch_stops to authenticated;
create policy gp_dispatch_read on public.gp_dispatch_stops for select to authenticated
using ((select private.gp_workspace_access('dispatch')));

create function public.gp_save_dispatch_stop(p_id uuid,p_revision timestamptz,p_fields jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_row public.gp_dispatch_stops;
  v_input public.gp_dispatch_stops:=jsonb_populate_record(null::public.gp_dispatch_stops,p_fields);
begin
  if not private.gp_workspace_access('dispatch') then raise insufficient_privilege; end if;
  v_input.crew:=btrim(coalesce(v_input.crew,''));
  if v_input.crew<>'' and v_input.status in ('scheduled','in_progress') then
    perform pg_advisory_xact_lock(hashtext('gp_dispatch_crew'),hashtext(lower(v_input.crew)));
    if exists (select 1 from public.gp_dispatch_stops
      where lower(crew)=lower(v_input.crew) and id is distinct from p_id and status in ('scheduled','in_progress')
      and starts_at<v_input.ends_at and ends_at>v_input.starts_at) then
      raise exception 'This crew already has a stop during that time';
    end if;
  end if;
  if p_id is null then
    insert into public.gp_dispatch_stops(title,site,crew,kind,status,starts_at,ends_at,latitude,longitude,work_order,notes)
    values(v_input.title,v_input.site,v_input.crew,v_input.kind,v_input.status,v_input.starts_at,v_input.ends_at,v_input.latitude,
     v_input.longitude,v_input.work_order,v_input.notes) returning * into v_row;
  else
    update public.gp_dispatch_stops set title=v_input.title,site=v_input.site,crew=v_input.crew,kind=v_input.kind,
     status=v_input.status,starts_at=v_input.starts_at,ends_at=v_input.ends_at,latitude=v_input.latitude,longitude=v_input.longitude,
     work_order=v_input.work_order,notes=v_input.notes,updated_at=clock_timestamp()
    where id=p_id and updated_at=p_revision returning * into v_row;
    if not found then raise exception 'This dispatch stop changed. Refresh and reopen it'; end if;
  end if;
  perform private.gp_workspace_audit('DISPATCH_STOP',format('Saved stop %s (%s)',v_row.id,v_row.status));
  return to_jsonb(v_row);
end
$$;

-- INVOKER keeps the original per-employee Work Orders policy and quote/customer policies in effect.
create function public.gp_search_past_jobs(p_query text,p_customer uuid default null)
returns table(source text,reference text,title text,summary text,customer_name text,occurred_on date)
language plpgsql stable security invoker set search_path='' as $$
declare v_query tsquery;
begin
  if not private.gp_workspace_access('job_search') then raise insufficient_privilege; end if;
  if length(btrim(coalesce(p_query,''))) not between 2 and 280 then raise exception 'Enter a search of 2–280 characters'; end if;
  v_query:=websearch_to_tsquery('english',p_query);
  return query
   with results as (
    select 'work_order'::text as kind, w.wo_number as ref, w.job_type as label,
      concat_ws(' · ',nullif(w.glass_spec,'N/A'),nullif(w.materials_used,''),nullif(w.spec_notes,'')) as description,
      c.display_name as customer,w.work_date as work_day,
      to_tsvector('english',concat_ws(' ',w.wo_number,w.job_type,w.glass_spec,w.materials_used,w.spec_notes,c.display_name)) as document
    from public.commission_logs w left join public.gp_customers c on c.id=w.customer_id
    where (p_customer is null or (w.customer_id=p_customer and c.id is not null))
    union all
    select 'quote',q.quote_number::text,coalesce(nullif(q.module,''),'Quote'),
      left(coalesce((select string_agg(item->>'desc',' · ') from jsonb_array_elements(
        case when jsonb_typeof(q.parts)='array' then q.parts else '[]'::jsonb end) item),''),900),
      q.customer_name,q.created_at::date,
      to_tsvector('english',concat_ws(' ',q.quote_number,q.customer_name,q.module,q.parts::text))
    from public.outstanding_quotes q where p_customer is null or q.customer_id=p_customer
    union all
    select 'intake',i.id::text,i.title,left(i.observations,900),i.customer,i.created_at::date,
      to_tsvector('english',concat_ws(' ',i.title,i.customer,i.site,i.observations,i.work_order))
    from public.gp_photo_intakes i
    where p_customer is null or exists(
      select 1 from public.outstanding_quotes q where q.quote_number=i.quote_number and q.customer_id=p_customer)
   )
   select kind,ref,label,left(description,900),customer,work_day from results
   where document@@v_query or lower(ref)=lower(btrim(p_query))
   order by (lower(ref)=lower(btrim(p_query))) desc,ts_rank(document,v_query) desc,work_day desc nulls last,ref
   limit 50;
end
$$;

create table private.gp_photo_draft_quota (
  auth_user_id uuid not null references auth.users(id) on delete cascade,
  day date not null,
  requests integer not null,
  primary key (auth_user_id, day)
);
revoke all on private.gp_photo_draft_quota from public,anon,authenticated;

create function public.gp_reserve_photo_draft()
returns boolean language plpgsql security definer set search_path='' as $$
begin
  if not private.gp_workspace_access('photo_intake') then raise insufficient_privilege; end if;
  insert into private.gp_photo_draft_quota as q values(auth.uid(),(now() at time zone 'America/New_York')::date,1)
  on conflict(auth_user_id,day) do update set requests=q.requests+1 where q.requests<10;
  return found;
end
$$;
revoke all on function public.gp_reserve_photo_draft() from public,anon,authenticated;
grant execute on function public.gp_reserve_photo_draft() to authenticated;

revoke all on function private.gp_workspace_access(text),private.gp_workspace_audit(text,text),
 private.gp_quote_token_hash(text),private.gp_quote_link_open(private.gp_customer_quote_link),
 private.gp_quote_upload_allowed(text) from public,anon,authenticated;
grant usage on schema private to authenticated;
grant execute on function private.gp_workspace_access(text) to authenticated;
grant execute on function private.gp_quote_upload_allowed(text) to anon,authenticated;
revoke all on function public.gp_workspace_features(),public.gp_workspace_permissions(),
 public.gp_set_workspace_permission(text,text,bigint),public.gp_save_photo_intake(uuid,timestamptz,jsonb),
 public.gp_publish_quote_link(bigint,jsonb,integer),public.gp_quote_link_staff(bigint),
 public.gp_manage_quote_link(uuid,text,text),public.gp_customer_quote(text,text,text,integer),
 public.gp_save_dispatch_stop(uuid,timestamptz,jsonb),public.gp_search_past_jobs(text,uuid)
 from public,anon,authenticated;
grant execute on function public.gp_workspace_features(),public.gp_workspace_permissions(),
 public.gp_set_workspace_permission(text,text,bigint),public.gp_save_photo_intake(uuid,timestamptz,jsonb),
 public.gp_publish_quote_link(bigint,jsonb,integer),public.gp_quote_link_staff(bigint),
 public.gp_manage_quote_link(uuid,text,text),public.gp_save_dispatch_stop(uuid,timestamptz,jsonb),
 public.gp_search_past_jobs(text,uuid) to authenticated;
grant execute on function public.gp_customer_quote(text,text,text,integer) to anon,authenticated;

notify pgrst,'reload schema';
commit;
