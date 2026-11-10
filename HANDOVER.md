# CadetFlow handover guide

For whoever looks after CadetFlow next: the administrator who runs it day to day, and anyone who changes the code. No passwords or keys are written here. Ask the outgoing administrator for them in person.

## What it is

- **The site:** https://pathakabhinav777.github.io/cadetmanagement/ is the cadet management site for Jessami, Kohima and Naushera companies. It covers parades, attendance, leave, mess duty, tasks, uniform, notices, the rolling trophy and practice questions.
- **The page:** a single web page (`index.html` with its stylesheet `cadetflow.css`), served free by GitHub Pages from the `main` branch of the GitHub repository `pathakabhinav777/cadetmanagement`.
- **Data, sign-in, files and notifications:** these live in Supabase, on the free plan. The project is "CadetFlow" (`fyezdsvrlbbqrepbxcuj`). A separate test project, "CadetFlow Test" (`pgkwlxothkmlwoyibqof`), is for trying changes first.
- **The server:** one Supabase Edge Function, `cadetflow-api`. Its code is in `supabase/functions/cadetflow-api/`.
- **Phones:** cadets install the site as an app from Chrome (Android) or Safari, Add to Home Screen (iPhone).

## Accounts you need

These are what a new person in charge needs. Hand them over in person, never in the repository.

1. **GitHub:** access to the repository, to change the site. Add the new person as a collaborator, or transfer the repository.
2. **Supabase:** a member of the organisation that owns both projects, to see the data, run SQL and deploy the server.
3. **CadetFlow administrator:** an account on the site with the role `admin`. Before you leave:
   - Make the next person administrator on the Accounts page (change role).
   - Check they can sign in.
   - Then remove or downgrade your own account.

## The administrator's routine

- **Accounts page:**
  - Approve new registrations. Check that the regimental number matches the roster.
  - Link each account to its cadet. Powers come from that cadet's rank.
  - Send password links when someone forgets their password.
- **Cadet Roster:** keep ranks, companies, POC ticks and regimental numbers right. A rank change gives or takes away powers at once.
- **Backups:** make one before any big change (Data menu, Backups, Make a backup now). They are kept 30 days. There is no automatic backup.
- **System check:** look at it now and then (Data menu, System check). It shows:
  - whether reminders are running
  - how big the data is
  - accounts waiting
  - the last backup
  - errors that cadets' pages ran into
- **Each new academic year:**
  1. Cadet Roster page, New academic year. This moves 1st years to 2nd, 2nd to 3rd, and 3rd years to Past cadets.
  2. Add the new 1st years and invite them (Accounts, Import list).
  3. Once a year, archive old records (Data menu, Backups, Archive old records). This keeps the site quick. A full copy is kept as an Archive backup.
- **Year-end:**
  - Data menu, Unit report: print it or save it as a PDF.
  - Data menu, Download everything (Excel): keep it with the unit's records.

## Who can do what

The rank of the cadet an account is linked to decides its powers.

| Who | Powers |
|-----|--------|
| Lance corporal and above | Tasks, notices, call-outs |
| Sergeant and above | Late/absence requests, leave, mess duty let-offs, attendance, the register, the rolling trophy and awards |
| JUO and SUO | Create and change parades, record camps |
| CQMS | Uniform orders, payments, equipment |
| POC (tick on the roster) | Tasks, notices, call-outs and attendance, whatever their rank, plus filling in anyone's timetable |
| Administrator | Everything, plus the roster, accounts, deleting tasks and parades, and backups |

Sergeants see and decide only the requests of cadets in their own company. The CSM, CQMS, JUOs, SUOs and the administrator see all of them.

The Help page on the site (account menu, Help) explains every part in plain words for cadets and seniors.

## When something goes wrong

- **The site will not load or nobody can sign in:**
  - Supabase pauses a free project after 7 days with no use. Open the Supabase dashboard and restore the project.
  - Then check System check. If Reminders says "Never ran" or shows a long time ago, schedule them again: run `supabase/launch/reminders_cron.sql` in the SQL editor.
- **No notifications:**
  - The person has to turn them on again on that device.
  - On iPhone, the site must be opened from the Home Screen icon.
  - The person may have switched a kind off (account menu, Notification choices).
- **Emails do not arrive (invites, password links):** Supabase's own email sender is very limited. Copy the link from the Accounts page and send it on WhatsApp.
- **Wrong data after a mistake:** Data menu, Backups, Restore. A copy of the data as it was before the restore is made first.
- **Going back to the old public site (before sign-in):** follow `supabase/launch/rollback_to_public_site.sql`. The git tag is `restore-before-signin`.

## Limits of the free plan

- **Supabase:** 500 MB database, 5 GB transfer a month, 500,000 server calls a month, and a pause after 7 days with no use.
- **Shared data size:** today it is about 100 KB, which is fine. Archive old years when System check says it is getting large.
- **GitHub Pages:** free for a public repository.

## Changing the code

- `CLAUDE.md` is the detailed technical description: how the page, server, database, permissions, tests and deploys fit together. Read it first.
- **Tools:** Node 22.6 or newer. Run `npm install` once.
  - `npm run build:css` after changing styles in `index.html`.
  - `npm test` before every commit. The tests run the real server code against an in-memory copy of Supabase.
- **Order for a change:**
  1. Test project: apply new SQL migrations (`supabase/migrations/`) and deploy `cadetflow-api`.
  2. Live project: the same.
  3. Push to `main`. GitHub Pages updates in about a minute, and phones show an Update banner.
- **Permissions:** the same table is in two places. Change both together:
  - the site: `RANK_POWERS` in `index.html`
  - the server: `PERMISSIONS` in `supabase/functions/cadetflow-api/rules.mjs`
- **New database tables** need `grant ... to service_role`, or the server gets "permission denied".

## Never put in the repository

The repository is public.

- The cadets' emails or regimental numbers. Use Import list on the Accounts page instead.
- Passwords, Supabase keys, the service role key or VAPID keys.
- The local restore copy in `~/Documents/NCC/cadetflow-restore-point/`.
