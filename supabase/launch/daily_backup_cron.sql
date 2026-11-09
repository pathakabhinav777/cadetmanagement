-- A copy of the shared data every night at 02:00 India time (20:30 UTC), kept 30 days, in the
-- table cadetflow_backups (supabase/migrations/20261109_leave_answers_backups.sql). The administrator
-- restores one from the site: Data menu > Daily backups.
create extension if not exists pg_cron;
select cron.unschedule(jobid) from cron.job where jobname = 'cadetflow-daily-backup';
select cron.schedule('cadetflow-daily-backup', '30 20 * * *', $$ select public.cadetflow_daily_backup(); $$);
-- First copy straight away:
select public.cadetflow_daily_backup();
