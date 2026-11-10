-- 2026-11-10: no nightly backups. The administrator makes backups by hand (Data menu > Backups);
-- the table cadetflow_backups stays for those and for the copy kept before each restore.
-- Removes the pg_cron job from supabase/launch/daily_backup_cron.sql (deleted), its function, and the
-- nightly copies already taken.
select cron.unschedule(jobid) from cron.job where jobname = 'cadetflow-daily-backup';
drop function if exists public.cadetflow_daily_backup();
delete from public.cadetflow_backups where kind = 'daily';
