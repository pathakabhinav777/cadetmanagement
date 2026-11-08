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
- Register: pick your name from the roster (the `roster` action works without sign-in), then email, regimental number (optional) and password. A cadet with no number on the roster adds their own later from their profile ("Add mine", action `myRegNo`, once); changing it is for the administrator. The regimental number is not checked at registration (a "does not match" answer would let anyone guess numbers); the waiting list shows the administrator whether it matches the roster. New accounts are `pending` viewers until the administrator approves them.
- Accounts page (`renderAccountsPage()`, `loadAccounts()`): approve or reject, change role, link an account to its cadet, send or copy a password reset link, set a password, remove. Invite one cadet, or "Import list" (Excel/CSV with name, email, regimental number) to invite many: each gets a link to set a password.
- An invite links an email's existing account only if it is already approved and not linked to another cadet. A `pending`, `rejected` or profile-less account with that email was made by whoever registered it, with their own password, so the invite removes it and sends a fresh invite that only the email's owner receives. A cadet with a registration waiting from another email is refused until the administrator decides it. The same email twice in one list is done once. The invite-preview notes on the Accounts page follow the same rules.
- "Forgot password" only tells the administrator (`reset_requested_at`); the administrator sends the link from the Accounts page. Invite and reset links open the site with `#access_token=…&type=invite|recovery`, and the site asks for a new password.
- Emails are sent by Supabase Auth. They need a custom SMTP sender and the site in Auth > URL Configuration > Redirect URLs. Without those, copy each link from the Accounts page and send it on WhatsApp.
- The repo is public: never commit the cadets' list of emails and regimental numbers. Use Import list on the Accounts page.

## Who can do what
- Powers come from the rank of the cadet the account is linked to (`profile.cadet_id`). The `admin` role can do everything. The same table is in `index.html` (`RANK_POWERS`, `canDo`) and `supabase/functions/cadetflow-api/rules.mjs` (`PERMISSIONS`, `can`): change both together.
  - `write`, `task`, `callout`: LCPL and above (tasks, special events, updates, +1 call-outs)
  - `parade`: JUO, SUO (create and edit parades, send parade notifications)
  - `requests`: SGT and above (see and decide late/absence requests, add reports)
  - `attendance`: SGT and above, and POCs (mark parade attendance)
  - POC (point of contact): a tick next to the rank in the roster editor (`cadet.poc === true`). A POC also gets `write`, `task` and `attendance` whatever their rank (`POC_POWERS` in both files; `cadetflow_my_access()` counts them as writers).
  - `uniform`: CQMS (place orders, mark arrived, approve payments, prices, payment details)
  - Administrator only: roster (including regimental numbers), timetables, accounts, deleting tasks and parades, restoring data
- Every approved cadet, whatever their rank: their own uniform requests, payment screenshots and "received", and their own late/absence requests.
- Powers always follow the current roster: a rank or POC change reaches every open page with the next sync (`rerenderAfterRemote` re-applies `applyAccessUI`), and the server and database read the roster on every request. Setting a second CQMS warns that the old one keeps uniform powers until their rank changes.
- Checks: `app.can(perm)`, `app.canEdit()` (= `write`), `app.isAdmin()`, `app.myCadet()`. Body classes `can-edit`, `can-parade`, `can-requests`, `can-attendance`, `can-uniform`, `is-admin`, `has-cadet`, `signed-in` hide buttons through CSS.
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

## Notices, parade calendar, camps, mess duty, new year, payments, activity (2026-11-08)
- Shared data keys `notices`, `camps`, `alumni`, `messDuty` (lists with safe ids) and `messConfig` (object) go through `EXTRA_LISTS`/`extraLists()` in every load, save, merge, backup and restore path. Add a new key there.
- Notice board on Home (`renderNotices`): `write` power posts (`postNotice`), with an optional notification (server `announce`, once per notice). The poster or the administrator removes it.
- "Seen by": `markSeen()` sends `seen` for notices shown on Home and for upcoming parades on the Parades page the cadet is expected at; `write` power opens the list (`seenBy`). Stored in table `cadetflow_seen` (migration `20261108_seen_and_alumni.sql`).
- Parades: List/Calendar toggle (`PAR.view`, remembered per device), repeating parades (Repeat + How many in the parade dialog; separate parades sharing a `seriesId`; only the first is announced; deleting offers to remove the later ones of the series).
- Reminders: server action `remind` (no sign-in, idempotent; rules `paradesToRemind`, `messToRemind` in rules.mjs) sends parade reminders 2 hours before and mess duty reminders from 6 pm the evening before, each once (`cadetflow_push_sent` keys `remind:<id>`, `mess:<id>`). Scheduled by `supabase/launch/reminders_cron.sql` (pg_cron every 10 min); the site also nudges it on open.
- Camps (Cadet Roster page, `renderCamps`, `#campModal`): `parade` power (JUO, SUO, administrator) records them; shown on profiles.
- New academic year (administrator, Cadet Roster page): 1st → 2nd, 2nd → 3rd, 3rd years move to `alumni` ("Past cadets", with Bring back). `alumni` is locked like `cadets` (`lockedKeys`, the guard trigger, `guardRefuses`).
- Mess duty (Availability page, `renderMessCard`): `write` power plans the next 7 days (fewest duties first, then longest since the last), swaps a cadet, sets cadets a day, days, years and excused cadets.
- Uniform payment summary for the CQMS (`renderUniPaySummary`): billed, collected, to check, not paid, per order, who still owes.
- Activity log page (`#activityPage`, from the account menu or Data menu): the history with search, kinds and dates. History entries now carry `by`.

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
- Ids go into inline `onclick` handlers, so lists keep only items whose `id` matches `SAFE_ID` (`safeId()`, letters, digits and `_.:-`); cadets with another id get a new `cadet-fix-…` id. New id generators must stay within that. The database guard protects only tasks with such ids.
- A `SIGNED_IN` for the person already signed in (supabase-js sends one when a tab regains focus) merges with `refreshFromRemote()` instead of reloading, so a save on its way is kept.
- After updating a cadet found with a search box (Task Master, parade attendance, cadet pickers), call `clearSearchForNext(inputId, redraw)`: it empties the box and puts the cursor back, only if something was typed.
- Motion and small conveniences (end of the script, `SMALL CONVENIENCES`): the header's tricolour rule shows a moving light while a save is on its way (`body.is-syncing`, set in `queueRemoteSave`, cleared after `flushRemoteSave`) and goes grey with an "Offline" label when the connection drops (`body.is-offline`); Back closes the open dialog (each dialog pushes a history entry; the sign-in gate is left out); "/" focuses the visible search box; Home numbers count up (`countTo`); the phone tab bar has a sliding indicator; a marked attendance button gets `fx-stamp` and a short vibration; toasts stay longer for longer text. Everything respects prefers-reduced-motion.
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

## Launched (2026-11-07) and the restore point
The sign-in version is live on `main`. On live the lock-down was applied with `alter policy` (same rules as `supabase/launch/cadet_accounts_launch.sql`); unowned old push devices were left in place (they get no notifications).
To go back to the old public site, follow `supabase/launch/rollback_to_public_site.sql`: git tag `restore-before-signin` (c74f579, the old site and old `cadetflow-push`), table `cadetflow_restore_point` row 1 on live (data, accounts and access rules as they were), and a local copy of the data in `~/Documents/NCC/cadetflow-restore-point/` (never commit it).

## Liveliness (2026-11-08)
- Home: `#homeHello` greeting (`renderHello`), "online now" count from Realtime presence on channel `cadetflow-online` (`startPresence`, `LIVE`; each device sends only a random id kept in localStorage `cf-device`, never names), and a countdown that shows seconds in the last hour (`[data-until]`, `untilShort`). A 1-second ticker updates `[data-until]` and, every 30 s, `[data-ago]` times. `renderHomeNow` rewrites only when its HTML changed.
- `revealBelow` (IntersectionObserver, classes `.rv`/`.rv-in`) reveals cards below the first screen as they scroll in; `foldAway(el, then)` animates a removal; mouse-only `.cf-glow` light on `main .rounded-2xl` cards; ticked checkboxes stamp; the current phone tab icon hops.
- Phone pull-to-refresh (`#ptr`): at scrollY 0 with no dialog on screen, pull 70 px to call `app.refreshFromRemote()`. `body { overscroll-behavior-y: contain }` turns off the browser's own reload-on-pull.
