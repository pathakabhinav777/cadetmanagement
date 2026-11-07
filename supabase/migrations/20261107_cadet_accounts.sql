-- CadetFlow cadet accounts, self-reports for parades and per-person notifications.
-- Additive only: the current live site keeps working unchanged (it reads profiles.role only and
-- ignores everything new). The read lock-down is a separate step: supabase/launch/cadet_accounts_launch.sql

-- ---- Accounts ------------------------------------------------------------------------------
-- status: 'pending' (registered, waiting for the administrator), 'approved', 'rejected'.
-- Accounts that already exist are approved; new rows default to pending.
alter table public.cadetflow_profiles
  add column if not exists status text not null default 'approved',
  add column if not exists cadet_id text,
  add column if not exists regimental_no text,
  add column if not exists requested_at timestamptz,
  add column if not exists decided_at timestamptz,
  add column if not exists decided_by uuid references auth.users(id) on delete set null,
  add column if not exists email text,
  add column if not exists invited_at timestamptz,
  add column if not exists reset_requested_at timestamptz;  -- "Forgot password": waits for the administrator
alter table public.cadetflow_profiles alter column status set default 'pending';
do $$ begin
  alter table public.cadetflow_profiles add constraint cadetflow_profiles_status_check check (status in ('pending', 'approved', 'rejected'));
exception when duplicate_object then null; end $$;
-- One live account per cadet on the roster (a rejected registration does not block a new one).
create unique index if not exists cadetflow_profiles_one_account_per_cadet
  on public.cadetflow_profiles (cadet_id) where cadet_id is not null and status <> 'rejected';

-- Removing an account must not be blocked by "last saved the shared data".
alter table public.cadetflow_state drop constraint if exists cadetflow_state_updated_by_fkey;
alter table public.cadetflow_state add constraint cadetflow_state_updated_by_fkey
  foreign key (updated_by) references auth.users(id) on delete set null;

-- ---- Notifications belong to a person ------------------------------------------------------
alter table public.cadetflow_push_subscriptions
  add column if not exists user_id uuid references auth.users(id) on delete cascade;
create index if not exists cadetflow_push_subscriptions_user on public.cadetflow_push_subscriptions (user_id);

-- ---- Late / absence requests sent by cadets themselves --------------------------------------
-- Seniors and administrators approve them; an approved request becomes a report on the parade.
-- image_path points into the private storage bucket below and is cleared when the file is deleted.
create table if not exists public.cadetflow_requests (
  id uuid primary key default gen_random_uuid(),
  parade_id text not null,
  cadet_id text not null,
  user_id uuid references auth.users(id) on delete set null,
  kind text not null check (kind in ('late', 'absent')),
  reason text not null,
  image_path text,
  had_image boolean not null default false,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by uuid references auth.users(id) on delete set null,
  decided_by_name text
);
create unique index if not exists cadetflow_requests_one_pending
  on public.cadetflow_requests (parade_id, cadet_id) where status = 'pending';
create index if not exists cadetflow_requests_parade on public.cadetflow_requests (parade_id);
alter table public.cadetflow_requests enable row level security; -- no policies: only the server function uses it

-- Small settings edited on the site: 'payment' = { upi, payee, note, qr (file in the bucket) }.
create table if not exists public.cadetflow_settings (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);
alter table public.cadetflow_settings enable row level security;

-- Private bucket for files: request screenshots (tickets, medical papers) under <parade>/,
-- payment screenshots under pay/, the payment QR under settings/. Never public.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('cadetflow-report-files', 'cadetflow-report-files', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

-- ---- Grants (this project does not grant service_role anything by default) --------------------
revoke all on public.cadetflow_requests from anon, authenticated;
revoke all on public.cadetflow_settings from anon, authenticated;
grant select, insert, update, delete on public.cadetflow_settings to service_role;
grant select, insert, update, delete on public.cadetflow_requests to service_role;
grant select, insert, update, delete on public.cadetflow_profiles to service_role;
grant select, update on public.cadetflow_state to service_role;
