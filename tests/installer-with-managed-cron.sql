\set ON_ERROR_STOP on
do $$begin if current_database()<>'gp_clock_test' then raise exception 'Use disposable gp_clock_test';end if;end$$;
select set_config('request.jwt.claim.sub','',false);
delete from public.active_time_sessions;
select public.test_clock_at('2026-09-14 08:00-04') as installer_active_start \gset

-- Reproduce a platform that refuses CREATE EXTENSION because of dependent Cron grants.
-- The feature installer must not reach that setup path, even when the extension is absent.
create function public.test_managed_cron_dependency() returns event_trigger language plpgsql as $$begin
 raise exception using errcode='2BP01',message='simulated managed Cron dependent privileges exist';
end$$;
create event trigger test_managed_cron_dependency on ddl_command_start when tag in ('CREATE EXTENSION') execute function public.test_managed_cron_dependency();
select public.test_expect_error('create extension if not exists plpgsql','simulated managed Cron dependent privileges exist');
select public.test_assert(not exists(select 1 from pg_extension where extname='pg_cron'),'fixture has no Cron extension');
\ir ../supabase/GLASSPRO-NAVIGATION-AND-LIVE-CORRECTIONS-INSTALL.sql
select public.test_assert(to_regprocedure('public.gp_admin_correct_live_clock_in(uuid,bigint,timestamptz,text)') is not null,'live correction installs without Cron');
select public.test_assert(to_regprocedure('public.gp_review_clock_in_change(bigint,boolean,text)') is not null,'approval prerequisites install without Cron');
select public.test_assert((select count(*)=1 from public.active_time_sessions where started_at_ms=:installer_active_start),'feature installation does not auto-close overdue sessions');

-- A project with existing managed jobs must retain its job data and ACLs.
create schema cron;
create table cron.job(jobid bigint primary key,jobname text,schedule text,active boolean);
insert into cron.job values(700,'existing-managed-job','* * * * *',true);
grant usage on schema cron to authenticated;
grant select on cron.job to authenticated with grant option;
set role authenticated;
grant select on cron.job to anon;
reset role;
create temporary table test_cron_before as select relacl::text as acl from pg_class where oid='cron.job'::regclass;
\ir ../supabase/GLASSPRO-NAVIGATION-AND-LIVE-CORRECTIONS-INSTALL.sql
select public.test_assert((select count(*)=1 and bool_and(jobid=700 and jobname='existing-managed-job' and schedule='* * * * *' and active) from cron.job),'existing managed jobs remain unchanged');
select public.test_assert((select relacl::text from pg_class where oid='cron.job'::regclass)=(select acl from test_cron_before),'existing dependent Cron grants remain unchanged');
select public.test_assert((select count(*)=1 from public.active_time_sessions where started_at_ms=:installer_active_start),'rerun keeps overdue live punches available for correction');
drop event trigger test_managed_cron_dependency;
drop function public.test_managed_cron_dependency();
drop table cron.job;
drop schema cron;
delete from public.active_time_sessions where started_at_ms=:installer_active_start;
\echo 'PASS: complete feature installer bypasses managed Cron dependency failure, reruns safely and retains existing jobs, grants and live punches.'
