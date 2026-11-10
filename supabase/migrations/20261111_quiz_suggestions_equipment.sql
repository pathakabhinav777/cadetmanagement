-- 2026-11-11: practice questions, quiz scores, suggestion box, and the equipment register lock.
-- Additive: safe to run on the live project before the site that uses it is pushed. Only
-- cadetflow-api (service role) reads and writes these tables, so each is granted to service_role
-- explicitly (this project does not do that by itself).

-- ---- Practice questions for the B and C certificates (SGT and above add them on the Learn page).
create table if not exists public.cadetflow_quiz (
  id uuid primary key default gen_random_uuid(),
  cert text not null check (cert in ('B', 'C', 'both')),
  subject text not null check (length(subject) between 1 and 60),
  question text not null check (length(question) between 1 and 600),
  options jsonb not null check (jsonb_typeof(options) = 'array' and jsonb_array_length(options) between 2 and 6),
  answer smallint not null check (answer between 0 and 5),
  explain text not null default '',
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now()
);
alter table public.cadetflow_quiz enable row level security;
revoke all on public.cadetflow_quiz from anon, authenticated;
grant select, insert, update, delete on public.cadetflow_quiz to service_role;

-- ---- One row per practice round a cadet finishes.
create table if not exists public.cadetflow_quiz_scores (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  cadet_id text,
  cert text not null check (cert in ('B', 'C')),
  subject text not null default '',
  score smallint not null check (score >= 0),
  total smallint not null check (total between 1 and 100 and score <= total),
  taken_at timestamptz not null default now()
);
create index if not exists cadetflow_quiz_scores_user on public.cadetflow_quiz_scores (user_id, taken_at desc);
create index if not exists cadetflow_quiz_scores_taken on public.cadetflow_quiz_scores (taken_at desc);
alter table public.cadetflow_quiz_scores enable row level security;
revoke all on public.cadetflow_quiz_scores from anon, authenticated;
grant select, insert, update, delete on public.cadetflow_quiz_scores to service_role;

-- ---- Suggestion box. An anonymous suggestion keeps no account, name or cadet: user_id is null.
create table if not exists public.cadetflow_suggestions (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  user_id uuid references auth.users (id) on delete set null,
  name text,
  cadet_id text,
  text text not null check (length(text) between 1 and 1500),
  status text not null default 'new' check (status in ('new', 'seen', 'done')),
  reply text,
  replied_at timestamptz,
  replied_by_name text
);
create index if not exists cadetflow_suggestions_created on public.cadetflow_suggestions (created_at desc);
alter table public.cadetflow_suggestions enable row level security;
revoke all on public.cadetflow_suggestions from anon, authenticated;
grant select, insert, update, delete on public.cadetflow_suggestions to service_role;

-- ---- The equipment register (state.equipment) is kept by the CQMS, like uniform: only the CQMS
-- and the administrator may change it. Same function as in 20261108_seen_and_alumni.sql plus
-- 'equipment' in the uniform check.
create or replace function public.cadetflow_state_guard()
returns trigger language plpgsql set search_path = public as $$
declare
  my_rank text;
begin
  if current_user not in ('authenticated', 'anon') then return new; end if;
  if new.id is distinct from old.id then
    raise exception 'The shared data cannot be moved.' using errcode = '42501';
  end if;
  if public.cadetflow_my_access() = 'admin' then return new; end if;
  if (new.state -> 'cadets') is distinct from (old.state -> 'cadets')
     or (new.state -> 'alumni') is distinct from (old.state -> 'alumni') then
    raise exception 'Only the administrator can change the roster.' using errcode = '42501';
  end if;
  if exists (
    select 1 from jsonb_array_elements(case when jsonb_typeof(old.state -> 'events') = 'array' then old.state -> 'events' else '[]'::jsonb end) o
    where jsonb_typeof(o -> 'id') = 'string' and (o ->> 'id') ~ '^[A-Za-z0-9_.:-]{1,128}$'
      and not exists (
        select 1 from jsonb_array_elements(case when jsonb_typeof(new.state -> 'events') = 'array' then new.state -> 'events' else '[]'::jsonb end) n
        where n ->> 'id' = o ->> 'id')
  ) then
    raise exception 'Only the administrator can remove tasks.' using errcode = '42501';
  end if;
  if (new.state -> 'uniform') is distinct from (old.state -> 'uniform')
     or (new.state -> 'uniformPrices') is distinct from (old.state -> 'uniformPrices')
     or (new.state -> 'equipment') is distinct from (old.state -> 'equipment') then
    select upper(c ->> 'rank') into my_rank
      from public.cadetflow_profiles p,
        jsonb_array_elements(case when jsonb_typeof(old.state -> 'cadets') = 'array' then old.state -> 'cadets' else '[]'::jsonb end) c
      where p.user_id = auth.uid() and p.status = 'approved' and c ->> 'id' = p.cadet_id
      limit 1;
    if my_rank is distinct from 'CQMS' then
      raise exception 'Only the CQMS and the administrator can change uniform orders, payments, prices and equipment.' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
revoke all on function public.cadetflow_state_guard() from public, anon, authenticated;
