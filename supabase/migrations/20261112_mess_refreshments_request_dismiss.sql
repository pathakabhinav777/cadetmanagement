-- 2026-11-12: a cadet can clear a declined request from their own view (the record stays for the
-- sergeants and above). Additive: safe to run before the site and server that use it.
alter table public.cadetflow_requests add column if not exists dismissed_at timestamptz;
