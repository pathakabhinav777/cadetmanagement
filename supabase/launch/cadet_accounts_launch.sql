-- LAUNCH STEP for the sign-in version of CadetFlow. Apply only when the new site goes live.
-- Before this, cadetflow_state is readable by anyone (the current public site needs that).
-- After this, only approved accounts can read it, and only the administrator and cadets ranked
-- LCPL and above can save it directly.
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
      select 1 from public.cadetflow_state s, jsonb_array_elements(coalesce(s.state->'cadets', '[]'::jsonb)) c
      where s.id = 1 and c->>'id' = p.cadet_id and upper(coalesce(nullif(c->>'rank', ''), 'CDT')) <> 'CDT'
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

-- Devices registered on the old public site belong to nobody; the app links a device to its
-- person again when they sign in and notifications are on.
delete from public.cadetflow_push_subscriptions where user_id is null;
