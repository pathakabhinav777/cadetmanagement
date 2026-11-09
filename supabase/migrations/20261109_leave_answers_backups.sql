-- 2026-11-09: leave for several days, questions on notices, daily backups. Additive: safe to run
-- on the live project before the site that uses it is pushed. Only cadetflow-api (service role)
-- reads and writes these tables, so each one is granted to service_role explicitly (this project
-- does not do that by itself).

-- ---- Leave for several days: a request row with kind 'leave', the first and last day, and
-- parade_id 'leave:<first day>' (it is not about one parade; the unique "one pending request per
-- parade" index then means one pending leave per first day).
alter table public.cadetflow_requests add column if not exists from_date date;
alter table public.cadetflow_requests add column if not exists to_date date;
alter table public.cadetflow_requests drop constraint if exists cadetflow_requests_kind_check;
alter table public.cadetflow_requests add constraint cadetflow_requests_kind_check check (kind in ('late', 'absent', 'leave'));
alter table public.cadetflow_requests drop constraint if exists cadetflow_requests_leave_dates;
alter table public.cadetflow_requests add constraint cadetflow_requests_leave_dates
  check (kind <> 'leave' or (from_date is not null and to_date is not null and to_date >= from_date));

-- ---- Answers to a notice's question (notice.options in the shared data). One answer per person.
create table if not exists public.cadetflow_answers (
  notice_id text not null check (notice_id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  user_id uuid not null references auth.users (id) on delete cascade,
  choice smallint not null check (choice between 0 and 9),
  answered_at timestamptz not null default now(),
  primary key (notice_id, user_id)
);
alter table public.cadetflow_answers enable row level security;
revoke all on public.cadetflow_answers from anon, authenticated;
grant select, insert, update, delete on public.cadetflow_answers to service_role;

-- ---- Backups of the shared data: one a night (supabase/launch/daily_backup_cron.sql), plus ones
-- the administrator makes, and one made just before each restore. Kept 30 days.
create table if not exists public.cadetflow_backups (
  id uuid primary key default gen_random_uuid(),
  taken_at timestamptz not null default now(),
  kind text not null default 'daily' check (kind in ('daily', 'manual', 'before-restore')),
  state jsonb not null,
  size integer,
  cadets integer,
  parades integer,
  tasks integer,
  taken_by uuid references auth.users (id) on delete set null
);
create index if not exists cadetflow_backups_taken_at on public.cadetflow_backups (taken_at desc);
alter table public.cadetflow_backups enable row level security;
revoke all on public.cadetflow_backups from anon, authenticated;
grant select, insert, delete on public.cadetflow_backups to service_role;

-- The nightly copy, called by pg_cron. Runs as its owner, so cron needs no other rights.
create or replace function public.cadetflow_daily_backup()
returns void language sql security definer set search_path = public as $$
  insert into public.cadetflow_backups (kind, state, size, cadets, parades, tasks)
  select 'daily', s.state, octet_length(s.state::text),
    case when jsonb_typeof(s.state -> 'cadets') = 'array' then jsonb_array_length(s.state -> 'cadets') else 0 end,
    case when jsonb_typeof(s.state -> 'parades') = 'array' then jsonb_array_length(s.state -> 'parades') else 0 end,
    case when jsonb_typeof(s.state -> 'events') = 'array' then jsonb_array_length(s.state -> 'events') else 0 end
  from public.cadetflow_state s
  where s.id = 1 and s.state is not null;
  delete from public.cadetflow_backups where taken_at < now() - interval '30 days';
$$;
revoke all on function public.cadetflow_daily_backup() from public, anon, authenticated;
