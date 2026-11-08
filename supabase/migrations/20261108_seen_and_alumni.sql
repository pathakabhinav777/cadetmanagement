-- Who has seen a notice or a parade ("Seen by 30 of 45"). Only cadetflow-api reads and writes it.
create table if not exists public.cadetflow_seen (
  item text not null check (item ~ '^(notice|parade):[A-Za-z0-9_.:-]{1,128}$'),
  user_id uuid not null references auth.users (id) on delete cascade,
  seen_at timestamptz not null default now(),
  primary key (item, user_id)
);
alter table public.cadetflow_seen enable row level security;
revoke all on public.cadetflow_seen from anon, authenticated;
grant select, insert, update, delete on public.cadetflow_seen to service_role;

-- Past cadets (state.alumni) are part of the roster: only the administrator may change them,
-- like state.cadets. Same function as in supabase/launch/cadet_accounts_launch.sql plus that one line.
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
     or (new.state -> 'uniformPrices') is distinct from (old.state -> 'uniformPrices') then
    select upper(c ->> 'rank') into my_rank
      from public.cadetflow_profiles p,
        jsonb_array_elements(case when jsonb_typeof(old.state -> 'cadets') = 'array' then old.state -> 'cadets' else '[]'::jsonb end) c
      where p.user_id = auth.uid() and p.status = 'approved' and c ->> 'id' = p.cadet_id
      limit 1;
    if my_rank is distinct from 'CQMS' then
      raise exception 'Only the CQMS and the administrator can change uniform orders, payments and prices.' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
revoke all on function public.cadetflow_state_guard() from public, anon, authenticated;
