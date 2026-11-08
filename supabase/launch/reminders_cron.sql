-- Parade reminders (2 hours before) and mess duty reminders (the evening before) are sent by the
-- cadetflow-api action "remind". This job calls it every 10 minutes. Each reminder goes out once
-- (recorded in cadetflow_push_sent as remind:<parade id> / mess:<day id>), so extra calls do nothing.
-- Opening the site also calls it, at most every 10 minutes per device.
create extension if not exists pg_cron;
create extension if not exists pg_net;
select cron.unschedule(jobid) from cron.job where jobname = 'cadetflow-reminders';
select cron.schedule('cadetflow-reminders', '*/10 * * * *', $$
  select net.http_post(
    url := 'https://fyezdsvrlbbqrepbxcuj.supabase.co/functions/v1/cadetflow-api',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{"action": "remind"}'::jsonb
  );
$$);
