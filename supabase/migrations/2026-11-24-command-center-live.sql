-- Time logs already use the Realtime publication. Include the other Command Center sources.
begin;
do $$
declare source_table text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then return; end if;
  foreach source_table in array array['commission_logs','fleet_vehicles'] loop
    if not exists (select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = source_table) then
      execute format('alter publication supabase_realtime add table public.%I', source_table);
    end if;
  end loop;
end $$;
commit;
