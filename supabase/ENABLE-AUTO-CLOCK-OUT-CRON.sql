-- Run AFTER 2026-11-23-weekly-time-and-auto-clock-out.sql in the existing project.
-- This is a Supabase database job: it runs while all browsers are closed.
create extension if not exists pg_cron with schema pg_catalog;
select cron.schedule('glasspro-missed-clock-out','* * * * *','select public.gp_auto_clock_out_due();');
-- Catch up sessions already overdue when this update is installed.
select public.gp_auto_clock_out_due();
-- Confirm one active job. All date/time decisions inside the worker use Eastern time.
select jobid,jobname,schedule,active from cron.job where jobname='glasspro-missed-clock-out';
