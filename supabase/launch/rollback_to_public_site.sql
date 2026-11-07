-- RESTORE POINT: go back to the old public site (before the sign-in version), if launch goes wrong.
-- Taken 2026-11-07, before launch. Pieces of the restore point:
--   * git tag restore-before-signin (commit c74f579): the old index.html, sw.js and cadetflow-push
--   * table public.cadetflow_restore_point, row id 1: the shared data, the 7 accounts and the 3 access
--     rules exactly as they were (only the server and the dashboard can read it)
--   * a local copy of the shared data in ~/Documents/NCC/cadetflow-restore-point/ (never committed)
--
-- To go back:
--   1. Site: on main, undo the launch commits without rewriting history, and push:
--        git revert --no-edit restore-before-signin..HEAD   (or: git revert --no-commit restore-before-signin..HEAD && git commit)
--      or, to be quick: git checkout restore-before-signin -- index.html sw.js manifest.webmanifest && commit && push
--   2. Run this file on the live project (fyezdsvrlbbqrepbxcuj).
--   3. Redeploy cadetflow-push from supabase/functions/cadetflow-push/index.ts at the tag (verify_jwt off).
-- Accounts made after launch stay; the old site ignores them unless their role is admin or editor.

-- Anyone can read the shared data again; administrators and editors can save it.
drop policy if exists "Approved members can view CadetFlow state" on public.cadetflow_state;
drop policy if exists "Anyone can view CadetFlow state" on public.cadetflow_state;
create policy "Anyone can view CadetFlow state" on public.cadetflow_state
  for select to anon, authenticated using (true);
drop policy if exists "Approved editors can update CadetFlow state" on public.cadetflow_state;
create policy "Approved editors can update CadetFlow state" on public.cadetflow_state
  for update to authenticated
  using (exists (select 1 from public.cadetflow_profiles p where p.user_id = (select auth.uid()) and p.role = any (array['admin', 'editor'])))
  with check (exists (select 1 from public.cadetflow_profiles p where p.user_id = (select auth.uid()) and p.role = any (array['admin', 'editor'])));
grant select on public.cadetflow_state to anon;

-- The new rules on saves go.
drop trigger if exists cadetflow_state_guard on public.cadetflow_state;

-- Old accounts get back the roles they had (the Accounts page may have changed them).
update public.cadetflow_profiles p set role = old.r ->> 'role'
  from (select jsonb_array_elements(profiles) r from public.cadetflow_restore_point where id = 1) old
  where p.user_id = (old.r ->> 'user_id')::uuid;

-- ONLY if the shared data itself was damaged (this loses every change made since the restore point):
-- update public.cadetflow_state set state = (select state from public.cadetflow_restore_point where id = 1),
--   updated_at = now() where id = 1;
