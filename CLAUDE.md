# CadetFlow

NCC cadet management website for Jessami, Kohima and Naushera companies. Everything lives in one file, `index.html`, served from GitHub. Data and sign-in are in Supabase.

## How the site is built
- Single `index.html`: Tailwind (play CDN, palettes remapped in `tailwind.config`), Instrument Sans, plain JS. No build step.
- Main class `CadetTrackerApp`; the instance is a top-level `let app` (not `window.app`).
- Pages: Home, Task Master (`#rosterPage`), Parades (`#paradePage`), Cadet Availability, Uniform (CQMS), Cadet Roster (public directory). Phone uses a bottom tab bar (`#phoneNav`) at ≤640px.
- Cadet profiles open in `#profileModal` (`openCadetProfile(id)`): attendance %, calendar, call-outs.

## App (install + Android)
- Live at https://pathakabhinav777.github.io/cadetmanagement/ (GitHub Pages from `main`).
- Installable web app: `manifest.webmanifest`, `sw.js` (network-first for the page, cache for CDN libs, never caches Supabase), `icons/`. The service worker only registers over https/localhost, not in tests (`file://`). Bump `VERSION` in `sw.js` if you change what it precaches.
- Home page "Get the app" block (`#getApp`, `updateGetApp()`): hidden when running installed or inside the Android app (user agent contains `CadetFlowApp`).
- Android: `android-app/` is a Capacitor shell that opens the live site, so website changes need no new APK. `.github/workflows/android-app.yml` builds it on changes to `android-app/` (or by hand) and publishes `CadetFlow.apk` on the `android-app` release. Signed with repo secrets `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` when set (key kept outside the repo).

## Data (Supabase)
- Table `cadetflow_state`, single row `id = 1`, column `state` (JSON): `{ cadets, events, history, duties, uniform, parades, activeEventId }`.
- Saves use optimistic concurrency on `updated_at` plus a three-way merge (`mergeSharedState`, `mergeListById`, `mergePlainList`). Lists of objects must have an `id` so merges work. New top-level keys must be added to: initial state, local load, `applyState`, backup restore, `serializableState`, export, and the `pick` in `mergeSharedState` and `stateEqual`.
- Table `cadetflow_profiles (user_id, display_name, role)`:
  - `admin` = administrator (everything: roster, timetables, data restore, deleting tasks/parades)
  - `editor` (or `senior`) = senior (tasks, marks, call-outs, uniform requests, parades/attendance)
  - anyone else / signed out = viewer. The whole site is readable without signing in.
- Permission checks: `app.canEdit()` (senior or admin) and `app.isAdmin()`. Body classes `can-edit` / `is-admin` hide buttons via CSS selectors on `onclick`.

## Conventions
- Cadet fields: `id, name, rank, wing, company, year ('1st'|'2nd'|'3rd'|''), cycle, free?` (timetable halves like `MON1`). Ranks: CDT, LCPL, CPL, SGT, CQMS, CSM, JUO, SUO. Companies: Jessami, Kohima, Naushera, or `No company` (CSM/CQMS).
- 3rd years are left out of Availability.
- Uniform: `state.uniform` is one request per cadet per item. Requests with status `requested` form the "next order"; placing it stamps one `orderId` on them (orders are derived from `orderId`, no separate list). Berets carry a per-cadet `size`; other items are one size. Older ordered requests without `orderId` get `order-<orderedAt>` in `normalizeUniform`.
- Late/absence reports for a parade close 15 minutes before reporting time (admins can still add). "Informed to" must be SGT and above.
- Keep text plain and minimal: no emojis in the UI, escape all user text with `escapeHtml`/`this.escape` before putting it in HTML.
- Must work on phone and laptop; check both.

## Tests
- `npm install` once, then `npm test` (Playwright, `tests/cadetflow.test.cjs`, fake Supabase in `tests/supabase-stub.js`).
- Run the tests before every commit; add a test for each new feature or bug fix.
- Commit with a clear message and push to `main` only after tests pass.
