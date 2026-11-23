-- Separate scheduler setup. First enable Cron under Supabase Dashboard > Integrations.
-- Run as the SQL Editor postgres role after installing the feature SQL.
-- Does not create/drop extensions or grant/revoke managed Cron permissions.
begin;
do $$begin
 if not exists(select 1 from pg_extension where extname='pg_cron') or to_regclass('cron.job') is null then
  raise exception 'Enable Cron in Supabase Dashboard > Integrations > Cron, then rerun this scheduler file. The feature installer can be run independently.';
 end if;
 if to_regprocedure('public.gp_auto_clock_out_due()') is null then
  raise exception 'Install the GLASSPRO timekeeping SQL before scheduling automatic clock-out.';
 end if;
end$$;
select cron.schedule('glasspro-missed-clock-out','* * * * *','select public.gp_auto_clock_out_due();');
-- Catch up sessions already overdue when this update is installed.
select public.gp_auto_clock_out_due();
-- Confirm one active job. All date/time decisions inside the worker use Eastern time.
select jobid,jobname,schedule,active from cron.job where jobname='glasspro-missed-clock-out';
commit;
