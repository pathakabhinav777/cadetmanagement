# CadetFlow

NCC cadet management website for Jessami, Kohima and Naushera companies. Everything lives in one file, `index.html`, served from GitHub. Data, sign-in and files are in Supabase. Everyone signs in to see anything.

## How the site is built
- Single `index.html`: Tailwind (play CDN, palettes remapped in `tailwind.config`), Instrument Sans, plain JS. No build step.
- Main class `CadetTrackerApp`; the instance is a top-level `let app` (not `window.app`).
- Pages: Home, Task Master (`#rosterPage`), Parades (`#paradePage`), Cadet Availability, Uniform, Cadet Roster (directory; the administrator edits it), Accounts (`#accountsPage`, administrator only). Phone uses a bottom tab bar (`#phoneNav`) at ≤640px.
- Cadet profiles open in `#profileModal` (`openCadetProfile(id)`): rank title and regimental number, attendance %, calendar, call-outs.
- Server actions go through `api(action, body)` to the Edge Function `cadetflow-api`.

## Sign-in and accounts
- Until an approved account signs in, `body.locked` hides the site and shows the gate (`#gate`, `renderGate()`): sign in, register, forgot password, waiting for approval.
- Register: pick your name from the roster (the `roster` action works without sign-in), then email, regimental number and password. When the roster already has that cadet's regimental number, the one typed must match. New accounts are `pending` viewers until the administrator approves them.
- Accounts page (`renderAccountsPage()`, `loadAccounts()`): approve or reject, change role, link an account to its cadet, send or copy a password reset link, set a password, remove. Invite one cadet, or "Import list" (Excel/CSV with name, email, regimental number) to invite many: each gets a link to set a password.
- An invite links an email's existing account only if it is already approved. It never approves a `pending` or `rejected` account (whoever registered it chose its password): the administrator approves or removes that one. A sign-in account with no CadetFlow profile was made outside the site, so the invite deletes it and starts again.
- "Forgot password" only tells the administrator (`reset_requested_at`); the administrator sends the link from the Accounts page. Invite and reset links open the site with `#access_token=…&type=invite|recovery`, and the site asks for a new password.
- Emails are sent by Supabase Auth. They need a custom SMTP sender and the site in Auth > URL Configuration > Redirect URLs. Without those, copy each link from the Accounts page and send it on WhatsApp.
- The repo is public: never commit the cadets' list of emails and regimental numbers. Use Import list on the Accounts page.

## Who can do what
- Powers come from the rank of the cadet the account is linked to (`profile.cadet_id`). The `admin` role can do everything. The same table is in `index.html` (`RANK_POWERS`, `canDo`) and `supabase/functions/cadetflow-api/rules.mjs` (`PERMISSIONS`, `can`): change both together.
  - `write`, `task`, `callout`: LCPL and above (tasks, special events, updates, +1 call-outs)
  - `parade`: JUO, SUO (create and edit parades, send parade notifications)
  - `requests`: SGT and above (see and decide late/absence requests, add reports, mark attendance)
  - `uniform`: CQMS (place orders, mark arrived, approve payments, prices, payment details)
  - Administrator only: roster (including regimental numbers), timetables, accounts, deleting tasks and parades, restoring data
- Every approved cadet, whatever their rank: their own uniform requests, payment screenshots and "received", and their own late/absence requests.
- Checks: `app.can(perm)`, `app.canEdit()` (= `write`), `app.isAdmin()`, `app.myCadet()`. Body classes `can-edit`, `can-parade`, `can-requests`, `can-uniform`, `is-admin`, `has-cadet`, `signed-in` hide buttons through CSS.
- The old `editor`/`senior` role gives nothing now: link those accounts to their cadets.
- The database enforces the important part as well (trigger `cadetflow_state_guard`, in the launch SQL): only the administrator can change `cadets` or remove tasks, only the CQMS and the administrator can change `uniform` and `uniformPrices`, and nobody can move the row. The site sends those parts back exactly as it read them for everyone else (`lockedKeys()`, `savePayload()`). Change the trigger, `lockedKeys()` and `guardRefuses` in `tests/fake-supabase.cjs` together. `cadetflow-api` (service role) is not checked. A writer can still change parades, history and call-outs by hand.

## App (install + notifications)
- Live at https://pathakabhinav777.github.io/cadetmanagement/ (GitHub Pages from `main`).
- Installable web app: `manifest.webmanifest`, `sw.js` (network-first for the page, cache for CDN libs, never caches Supabase), `icons/`. The service worker only registers over https/localhost, not in tests (`file://`). Bump `VERSION` in `sw.js` if you change what it precaches. Page requests use `cache: 'no-cache'` so a new push shows on the next open (GitHub Pages says max-age=600). `checkForNewVersion()` shows `#updateBanner` when the app returns to the screen and index.html changed.
- Home page "Get the app" block (`#getApp`, `updateGetApp()`): install instructions, hidden when running installed. There is no Android APK; Android users install from Chrome.
- Notifications (web push) go to people, not devices: boxes with `data-notify` on Home and Parades (`renderNotifyBoxes()`) save the device for the signed-in account.
  - A parade notifies only the accounts whose cadet is expected at it: company, years or picked cadets (`paradeRecipients` in rules.mjs). Accounts not linked to a cadet get every parade.
  - `saveParade()` calls `announceNewParade(id)` for new upcoming parades. Upcoming parades also have "Send notification" (`sendParadeNotification`). Each parade is announced once; administrators can re-send (`again: true`).
  - Uniform requests and payments notify the CQMS. Decisions notify the cadet.
  - `sw.js` shows the push and opens `?parade=<id>` or `?page=<page>`. iPhone needs Add to Home Screen first (iOS 16.4+).

## Server: Edge Function `cadetflow-api`
- Source in `supabase/functions/cadetflow-api/index.ts` plus `rules.mjs` (plain rules shared with the tests). The list of actions is at the top of `index.ts`.
- Deployed with verify_jwt off: every action checks who is calling itself.
- It works as the service role: VAPID keys and push devices, accounts (Supabase Auth admin), requests, settings, files, and changes to the shared JSON (`changeState`, the same optimistic check as the site).
- It replaces `cadetflow-push`. On launch day that function is redeployed as the stub in `supabase/launch/cadetflow-push-retired.ts`.

## Data (Supabase)
- Table `cadetflow_state`, single row `id = 1`, column `state` (JSON): `{ cadets, events, history, duties, uniform, uniformPrices, parades, activeEventId }`. After launch only approved accounts can read it, and only the administrator and LCPL and above can save it (`cadetflow_my_access()`).
- Saves use optimistic concurrency on `updated_at` plus a three-way merge (`mergeSharedState`, `mergeListById`, `mergePlainList`). Lists of objects must have an `id` so merges work. New top-level keys must be added to: initial state, local load, `applyState`, backup restore, `serializableState`, export, and the `pick` in `mergeSharedState` and `stateEqual`.
- Table `cadetflow_profiles`:
  - Columns: `user_id, display_name, role, status, cadet_id, regimental_no, email, requested_at, decided_at, decided_by, invited_at, reset_requested_at`.
  - `role` is `admin` or anything else (viewer).
  - `status` is `pending`, `approved` or `rejected`.
  - One live account per cadet.
  - Users can read only their own row; every change goes through `cadetflow-api`.
- Table `cadetflow_requests`: cadets' late/absence requests. Only the server uses it.
- Table `cadetflow_settings`: `payment` = `{ upi, payee, note, qr }`.
- Private bucket `cadetflow-report-files`: request screenshots under `<parade id>/`, payment screenshots under `pay/`, the payment QR under `settings/`. Shown through signed links only.
- Push tables `cadetflow_push_subscriptions` (with `user_id`), `cadetflow_push_keys`, `cadetflow_push_sent` are service-role only.
- Schema: `supabase/migrations/20261107_cadet_accounts.sql` (additive). The read lock-down is `supabase/launch/cadet_accounts_launch.sql`.
- This Supabase project does not grant table access to `service_role` automatically. Any table an Edge Function reads or writes needs an explicit `grant ... to service_role`; a missing grant shows up as "permission denied for table". Current grants: SELECT and UPDATE on `cadetflow_state`, full access on `cadetflow_profiles`, `cadetflow_requests`, `cadetflow_settings` and the `cadetflow_push_*` tables.

## Conventions
- Cadet fields: `id, name, rank, wing, company, year ('1st'|'2nd'|'3rd'|''), cycle, regNo?, free?` (timetable halves like `MON1`). Ranks: CDT, LCPL, CPL, SGT, CQMS, CSM, JUO, SUO. Companies: Jessami, Kohima, Naushera, or `No company` (CSM/CQMS).
- `regNo` (regimental number) is upper case with no spaces and unique. The administrator edits it on the Cadet Roster.
- 3rd years are left out of Availability.
- Uniform: `state.uniform` holds one request per cadet per item.
  - Status: `requested` (in the next order), then `ordered` (the CQMS placed the order, which stamps one `orderId` on its requests; orders are derived from `orderId`, there is no separate list), then `arrived` (the CQMS has the items), then `received` (collected).
  - Cadets add their own requests (`self: true`) through `cadetflow-api`.
  - Berets carry a per-cadet `size`; other items are one size. Older ordered requests without `orderId` get `order-<orderedAt>` in `normalizeUniform`.
- Uniform payment: `pay = { status: 'submitted'|'approved'|'rejected', proofId, file, at, decidedAt, … }`.
  - The cadet pays with the QR or UPI ID on the page and uploads a screenshot. The CQMS approves or turns it down.
  - A cadet can mark an item received only once it has arrived and is paid and approved, or costs nothing. The reason it is blocked comes from `uniformReceiveBlock`, which gives the same text on the site and the server.
- Uniform prices: `state.uniformPrices` = `[{ id: item key ('beret', 'custom:<name lowercased>'), price, label? }]`, edited on the Uniform page by the CQMS. The next order uses current prices. Placing an order copies each price onto its requests as `unitPrice` ("Use current prices" re-prices a placed order). Bill = `uniformBill(requests)`.
- Parades have a `kind`: shooting, drill, classroom (title = that name) or custom (own title). Older parades count as custom.
- Late/absence:
  - Cadets send their own request, with an optional screenshot, until 30 minutes before reporting time (`PARADE_CUTOFF_MIN` in the site, `CUTOFF_MIN` in rules.mjs).
  - SGT and above decide requests. An approved request becomes a report on the parade.
  - Seniors' reports close at the same time; the administrator can still add them. "Informed to" must be SGT and above.
  - Screenshots are deleted automatically. A request screenshot goes once the request is decided and the parade is past (3 hours after reporting). A payment screenshot goes once every item it paid for is approved and collected.
- After updating a cadet found with a search box (Task Master, parade attendance, cadet pickers), call `clearSearchForNext(inputId, redraw)`: it empties the box and puts the cursor back, only if something was typed.
- Keep text plain and minimal: no emojis in the UI, escape all user text with `escapeHtml`/`this.escape` before putting it in HTML.
- Must work on phone and laptop; check both.

## Tests
- Needs Node 22.6 or newer, because the tests run the real `cadetflow-api` code with `--experimental-strip-types`. Run `npm install` once, then `npm test` (Playwright, `tests/cadetflow.test.cjs`).
- `tests/fake-supabase.cjs` is an in-memory Supabase (tables with the row rules and the `cadetflow_state_guard` trigger, auth, storage, push) that runs the real `index.ts`.
- `tests/supabase-stub.js` replaces supabase-js in the page and forwards to it through `window.__db`, `__auth` and `__fn`.
- `makeDb()` and `openAs(browser, db, userId)` open the site as a given account. Push is faked with `FAKE_PUSH`.
- Run the tests before every commit; add a test for each new feature or bug fix.
- Commit with a clear message and push to `main` only after tests pass.

## Test copy (before launch)
- https://pathakabhinav777.github.io/cadetflow-test/ (repo `pathakabhinav777/cadetflow-test`, GitHub Pages), on its own Supabase project "CadetFlow Test" (`pgkwlxothkmlwoyibqof`, free plan). The real site and data are not touched by anything done there.
- That project has the base tables, the migration, the launch lock-down, `cadetflow-api`, and a one-time copy of the live data (2026-11-07).
- Test-only trigger `cadetflow_test_owner_admin`: the owner's email becomes administrator on registering, only while there is no administrator.
- Rebuild after changes: `python3 tools/build_test_copy.py <folder>`, then push that folder to the `cadetflow-test` repo. Redeploy `cadetflow-api` to the test project when the server changed.
- Invite/reset links there need the test project's Site URL set in Supabase; "Set password" on the Accounts page works without it.

## Launching the sign-in version (once)
In this order, also listed in `supabase/launch/cadet_accounts_launch.sql`:
1. Apply the migration.
2. Deploy `cadetflow-api` with `rules.mjs`, verify_jwt off.
3. Merge `cadet-accounts` into `main` and push.
4. Apply the launch SQL.
5. Replace `cadetflow-push` with the retired stub.
6. Link existing accounts to their cadets.

For emails, set up the custom SMTP sender and the Redirect URL.
