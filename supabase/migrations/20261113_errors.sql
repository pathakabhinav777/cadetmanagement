-- 2026-11-13: problems pages ran into, for the administrator's System check (cadetflow-api reportError, health,
-- errorsClear). Additive. Only the server (service role) uses it, so it is granted to service_role explicitly.
create table if not exists public.cadetflow_errors (
  id text primary key,                 -- hash of the message and where it happened: the same problem is counted
  message text not null,
  place text not null default '',
  agent text not null default '',
  page text not null default '',
  name text not null default '',       -- who saw it last
  count integer not null default 1,
  first_at timestamptz not null default now(),
  last_at timestamptz not null default now()
);
alter table public.cadetflow_errors enable row level security;
revoke all on public.cadetflow_errors from anon, authenticated;
grant select, insert, update, delete on public.cadetflow_errors to service_role;
