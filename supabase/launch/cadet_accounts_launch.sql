-- LAUNCH STEP for the sign-in version of CadetFlow. Apply only when the new site goes live.
-- Before this, cadetflow_state is readable by anyone (the current public site needs that).
-- After this, only approved accounts can read it, and only the administrator and cadets ranked
-- LCPL and above can save it directly. Even then, only the administrator can change the roster or
-- delete tasks, and only the CQMS and the administrator can change uniform orders and prices.
--
-- Order on launch day:
--   1. supabase/migrations/20261107_cadet_accounts.sql is applied (additive; can be done earlier)
--   2. the cadetflow-api function is deployed (verify_jwt off)
--   3. the cadet-accounts branch is merged into main and pushed (GitHub Pages)
--   4. this file is applied
--   5. cadetflow-push is replaced by the stub in supabase/launch/cadetflow-push-retired.ts
--   6. every existing account is linked to its cadet (Accounts page, or the list import) so ranks apply
-- Email: invites and reset links are sent by Supabase Auth. Its built-in mailer only delivers to the
-- project's team and a few per hour, so a custom SMTP sender must be set once (Auth > Emails > SMTP),
-- and the site address must be in Auth > URL Configuration > Redirect URLs. Until then the Accounts
-- page can copy each link for sending on WhatsApp.

-- What the caller may do with the shared data, decided by their account and their rank on the
-- roster: 'admin', 'writer' (LCPL and above), 'member' (CDT, or not linked to a cadet), or null
-- (not signed in / not approved). The site applies the finer rank rules (parades JUO/SUO,
-- requests SGT+, uniform orders CQMS); cadets' own actions go through the cadetflow-api function.
create or replace function public.cadetflow_my_access()
returns text language sql stable security definer set search_path = public as $$
  select case
    when p.status <> 'approved' then null
    when p.role = 'admin' then 'admin'
    when exists (
      select 1 from public.cadetflow_state s,
        jsonb_array_elements(case when jsonb_typeof(s.state->'cadets') = 'array' then s.state->'cadets' else '[]'::jsonb end) c
      where s.id = 1 and c->>'id' = p.cadet_id
        and (upper(c->>'rank') in ('LCPL', 'CPL', 'SGT', 'CQMS', 'CSM', 'JUO', 'SUO') or c->'poc' = 'true'::jsonb)
    ) then 'writer'
    else 'member'
  end
  from public.cadetflow_profiles p where p.user_id = auth.uid()
$$;
revoke all on function public.cadetflow_my_access() from public, anon;
grant execute on function public.cadetflow_my_access() to authenticated;

drop policy if exists "Anyone can view CadetFlow state" on public.cadetflow_state;
drop policy if exists "Approved members can view CadetFlow state" on public.cadetflow_state;
create policy "Approved members can view CadetFlow state" on public.cadetflow_state
  for select to authenticated using (public.cadetflow_my_access() is not null);

drop policy if exists "Approved editors can update CadetFlow state" on public.cadetflow_state;
create policy "Approved editors can update CadetFlow state" on public.cadetflow_state
  for update to authenticated
  using (public.cadetflow_my_access() in ('admin', 'writer'))
  with check (public.cadetflow_my_access() in ('admin', 'writer'));

revoke select on public.cadetflow_state from anon;
-- Whatever older setups granted: the site only reads and updates the shared row, reads its own profile,
-- and every change to accounts goes through cadetflow-api.
revoke insert, update, delete, truncate on public.cadetflow_profiles from anon, authenticated;
revoke insert, delete, truncate on public.cadetflow_state from anon, authenticated;
revoke update on public.cadetflow_state from anon;

-- Ranks decide everyone's powers (here and in cadetflow-api), so only the administrator may change the
-- roster; uniform orders, payments and prices belong to the CQMS and the administrator, and only the
-- administrator deletes tasks. The site sends the roster and uniform parts back exactly as it read them
-- for everyone else (savePayload in index.html), so this only stops a hand-made request. Tasks count by
-- their id; the site only keeps plain ids (safeId in index.html), so a task with any other id can go.
-- cadetflow-api works as the service role and is not checked here.
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
     or (new.state -> 'alumni') is distinct from (old.state -> 'alumni') then  -- past cadets too (2026-11-08)
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
create or replace trigger cadetflow_state_guard before update on public.cadetflow_state
  for each row execute function public.cadetflow_state_guard();

-- Devices registered on the old public site belong to nobody; the app links a device to its
-- person again when they sign in and notifications are on.
delete from public.cadetflow_push_subscriptions where user_id is null;
