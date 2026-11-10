// CadetFlow server (Supabase Edge Function "cadetflow-api") for the sign-in version of the site.
// Deploy with verify_jwt = false (the site sends a publishable key when nobody is signed in); every
// action checks who is calling itself. Deploy rules.mjs with it.
//
// Powers come from the caller's rank on the roster (see rules.mjs); the administrator can do all.
//
// Anyone:
//   key                                    -> { publicKey }      VAPID key for notifications
//   roster                                 -> { cadets: [{ id, name, rank, company, year, taken }] }
//   register  { cadetId, email, regNo, password } -> { ok }   account that waits for approval
//   forgot    { email }                    -> { ok }             asks the administrator for a reset link
//   unsubscribe { endpoint } / test { endpoint }
//   remind                                 -> { parades, mess, calls } sends what is due (each once):
//                                             parades 2 hours before (again if the parade's time changed),
//                                             mess duty calls (advance volunteers, then every cadet who can
//                                             do it, then the LCPLs and CPLs to pick), mess duty the evening
//                                             before. Called by a
//                                             scheduled job every 10 minutes (supabase/launch/reminders_cron.sql).
// Approved accounts:
//   subscribe { subscription }             -> { ok }             this device, for this person
//   report    { paradeId, kind, reason, image?, removeImage? } -> { request }   own late/absence request
//   withdraw  { id }                       -> { ok }             own request still waiting (deleted)
//   dismiss   { id, undo? }                -> { ok }             clear own declined request from own view (seniors keep it)
//   requests                               -> { requests }       SGT and above: everyone's; others: own
//   payInfo                                -> { upi, payee, note, qrUrl }      where to pay CQMS
//   myRegNo   { regNo }                    -> { ok }             own regimental number, once, if the roster has none
//   seen      { items: ['notice:<id>' | 'parade:<id>'] } -> { ok }   this person has seen these
//   reportError { message, place, page }   -> { ok }             a problem the page ran into (System check)
//   myBirthday { md: 'MM-DD' | '' }        -> { ok }             own birthday (no year), shown on Home on the day
//   setTimetable { cadetId, free: ['MON1', ...], detail? } -> { ok }   POCs and the administrator
//   myPrefs / setPrefs { off: [kinds] }    -> { off }            notifications switched off (NOTIFY_KINDS in rules.mjs)
//   leave     { from, to, reason, image? } -> { request }        own leave for several days (SGT and above decide it)
//   answer    { noticeId, choice }         -> { mine, counts, total }   own answer to a notice's question
//   answers   { ids: [noticeId] }          -> { answers: { id: { mine, counts, total } } }
//   signup    { id, join }                 -> { ok }             apply for (or withdraw from) a sign-up
//   swapAsk   { dayId, to?, takeDayId? }   -> { ok }             put your mess duty up for anyone (no `to`), or ask one
//                                             cadet (optionally taking one of their duties in return)
//   swapTake  { id }                       -> { ok, done }       take a duty someone put up (done at once)
//   swapAnswer { id, accept } / swapWithdraw { id } -> { ok }    agreeing makes the swap at once; no senior needed
//   messOut   { dayId, reason }            -> { ok }             ask a senior to let you off your mess duty (with a reason)
//   messOutDecide { id, approve }          -> { ok }             SGT and above: let the cadet off, or keep them on it
//   messVolunteer { paradeId }             -> { ok }             volunteer for mess duty at a parade with refreshments
//   messStandby { on }                     -> { ok, on }         on the advance volunteers list (asked first)
//   suggestLink { title, url, subject, cert } -> { ok }          suggest a link for the study library
//   suggest   { text, anonymous }          -> { ok }             suggestion box (anonymous ones keep no account)
//   mySuggestions                          -> { suggestions }    own named suggestions and the replies
//   quizBank                               -> { questions }      practice questions; quizScore { cert, subject, score, total }
//   quizScores                             -> { mine, everyone? } own scores; SGT and above: everyone's summary
// Lance corporals and above (and POCs):
//   seenBy    { item }                     -> { seen: [{ name, at }], notSeen: [{ name }], total }
//   answersBy { noticeId }                 -> { options: [{ label, people: [{ name, company }] }], notAnswered: [...] }
//   announce  { id }                       -> { sent, devices, people }   notification for a new notice (once)
//   messCall  { paradeId }                 -> { calls }          make the mess duty call due now for that parade
//   signupAnnounce { id } (once), signupTell { id } (tells the selected cadets): sign-ups are opened from the notice form
//   uniformRequest  { items: [{ item, custom?, size? }], qty?, note? } -> { added, skipped }   own items
//   uniformCancel   { id }  /  uniformReceived { id }  /  uniformPay { ids, image } -> { ok }
// SGT and above:   decide { id, approve, note? }, reportImage { id }
//                  excuse { id, paradeId }   excuse a cadet from one parade on the strength of a leave request
//                  that is still waiting (the leave stays waiting)
//                  quizSave { question }, quizDelete { id }, quizImport { rows }
// JUO / SUO:       notify { paradeId, again? (administrator) }
//                  paradeChange { paradeId, was: { reportAt, venue } }  "parade changed" to its cadets (once per change)
//                  paradeCancel { paradeId }   "parade cancelled" to its cadets, sent just before the site deletes it
// CQMS:            payImage { proofId }, payDecide { proofId, ok, note? }, setPayInfo { upi, payee, note, image?, removeQr? }
// SGT: requests, decide, excuse, reportImage and messOutDecide only for cadets of their own company (rules requestsFor).
// Administrator:   health -> System check; errorsClear; archive { before: 'YYYY-MM-DD' } (copy kept as an "archive" backup)
//                  backups -> { backups: [{ id, at, kind, size, cadets, parades, tasks }] }, backupNow, restoreBackup { id }
//                  suggestions -> { suggestions }, suggestionUpdate { id, status?, reply? }
//                  accounts (with each person's number of devices for notifications),
//                  invite { people: [{ cadetId, email, regNo }], send, site },
//                  resetLink { userId, send, site }, setPassword { userId, password },
//                  approve { userId, role? }, reject, setRole { role }, remove, link { cadetId|null }
//
// Files (private bucket cadetflow-report-files): request screenshots under <parade>/, payment
// screenshots under pay/, the payment QR under settings/. Request screenshots go once the request
// is decided and the parade is over; payment screenshots once every item they paid for is approved
// and collected. Leave screenshots go once the leave is decided and over.
//
// The scheduled "remind" also sends the administrator a weekly summary on Sunday evenings (once a week),
// tells a cadet once when a parade takes them below 75% attendance, and tells a cadet once when equipment
// they were issued is past its return date.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import webpush from "npm:web-push@3.6.7";
// @ts-ignore plain JavaScript module shared with the tests
import * as rules from "./rules.mjs";

const { approvedReport, attendanceDrops, audienceText, can, cleanLink, NOTIFY_KINDS, requestsFor, SCOPE_DENIED, cleanQuestion, CUTOFF_MIN, equipmentOverdue, hasRefreshments, inParade, isLeaveRequest, istDay, istWeekday,
  excusedFrom, messCallsDue, messCanDo, messLeadRank, messPerDay, messStandbyIds, messToRemind, paradeRecipients, paradesToRemind, payProofsToDelete, REMIND_BEFORE_MS, requestCleanup, requestsOpen, SEEN_ITEM, signupOpen, uniformKeyOf,
  uniformLabelOf, uniformReceiveBlock, uniformUnitOf, UNIFORM_ITEMS, weekSummary, WEEKLY_HOUR } = rules;

const SITE = "https://pathakabhinav777.github.io/cadetmanagement/";
const BUILD = "2026-11-13"; // shown in the administrator's System check
const BUCKET = "cadetflow-report-files";
const ROLES = ["admin", "viewer"];

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
function fail(status: number, message: string): never { throw new HttpError(status, message); }

function serverKey() {
  try { const k = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}"); if (k.default) return String(k.default); } catch { /* not set */ }
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
}
const db = createClient(Deno.env.get("SUPABASE_URL")!, serverKey(), { auth: { persistSession: false, autoRefreshToken: false } });

// deno-lint-ignore no-explicit-any
type Obj = Record<string, any>;
type Profile = { user_id: string; display_name: string | null; role: string; status: string; cadet_id: string | null; regimental_no: string | null; email: string | null };
type Caller = { id: string; email: string; profile: Profile | null };
type Who = { admin: boolean; poc: boolean; rank: string | null; cadet: Obj | null };

// ---- shared data (the same JSON the site edits) -----------------------------------------------
async function readState(): Promise<{ state: Obj; updatedAt: string | null }> {
  const { data, error } = await db.from("cadetflow_state").select("state, updated_at").eq("id", 1).maybeSingle();
  if (error) throw new Error("could not read the shared data: " + error.message);
  return { state: (data?.state as Obj) || {}, updatedAt: data?.updated_at ?? null };
}
/** Change the shared data like any other editor: only if nobody saved in between, else retry. */
async function changeState(by: string | null, change: (s: Obj) => boolean): Promise<Obj> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const { state, updatedAt } = await readState();
    if (!change(state)) return state;
    let q = db.from("cadetflow_state").update({ state, updated_at: new Date().toISOString(), updated_by: by }).eq("id", 1);
    q = updatedAt ? q.eq("updated_at", updatedAt) : q.is("updated_at", null);
    const { data, error } = await q.select("id");
    if (error) throw new Error("could not save the shared data: " + error.message);
    if (data && data.length) return state;
    await new Promise((r) => setTimeout(r, 150 + Math.random() * 250));
  }
  fail(409, "Someone else is saving right now. Try again.");
}
const cadetsOf = (s: Obj): Obj[] => (Array.isArray(s.cadets) ? s.cadets : []).filter((c: Obj) => c && c.id != null);
const findCadet = (s: Obj, id: unknown) => (id == null ? null : cadetsOf(s).find((c) => String(c.id) === String(id)) || null);
const findParade = (s: Obj, id: unknown) => (Array.isArray(s.parades) ? s.parades : []).find((p: Obj) => p && p.id === id) || null;
const uniformOf = (s: Obj): Obj[] => (Array.isArray(s.uniform) ? s.uniform : []).filter((r: Obj) => r && r.id);
const rankName = (c: Obj | null) => (c ? `${c.rank || "CDT"} ${c.name}` : "");
const rid = (p: string) => `${p}-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
function addHistory(s: Obj, action: string, cadetId: string | null, details: string) {
  s.history = [{ id: rid("hist"), at: Date.now(), action, cadetId, eventId: null, details }, ...(Array.isArray(s.history) ? s.history : [])].slice(0, 3000);
}
const IST = "Asia/Kolkata"; // the units are in Nagaland
function when(ms: number) {
  const d = new Date(ms);
  const day = new Intl.DateTimeFormat("en-IN", { timeZone: IST, weekday: "short", day: "numeric", month: "short" }).format(d);
  const time = new Intl.DateTimeFormat("en-IN", { timeZone: IST, hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
  return `${day}, ${time}`;
}
const rupees = (n: number) => "Rs " + Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 });

// ---- who is calling and what they may do -------------------------------------------------------
async function caller(req: Request): Promise<Caller | null> {
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (token.split(".").length !== 3) return null; // no user token (signed out: the publishable key)
  const { data } = await db.auth.getUser(token);
  if (!data?.user) return null;
  const { data: profile, error } = await db.from("cadetflow_profiles").select("*").eq("user_id", data.user.id).maybeSingle();
  if (error) throw new Error("could not read your account: " + error.message);
  return { id: data.user.id, email: data.user.email || "", profile: profile as Profile | null };
}
const DENIED: Record<string, string> = {
  write: "Only lance corporals and above can do this.",
  task: "Only lance corporals and above can do this.",
  callout: "Only lance corporals and above can do this.",
  parade: "Only JUOs, SUOs and the administrator can do this.",
  requests: "Only sergeants and above can do this.",
  uniform: "Only the CQMS and the administrator can do this.",
  admin: "Only the administrator can do this.",
};
/** Checks the caller is approved (and allowed `perm`); returns the shared data and their powers. */
async function access(me: Caller | null, perm: string | null, known?: Obj) {
  if (!me) fail(401, "Sign in first.");
  if (!me.profile || me.profile.status !== "approved") fail(403, "Your account is waiting for the administrator's approval.");
  const state = known || (await readState()).state;
  const cadet = findCadet(state, me.profile.cadet_id);
  const who: Who = { admin: me.profile.role === "admin", poc: cadet?.poc === true, rank: cadet ? String(cadet.rank || "CDT").toUpperCase() : null, cadet };
  if (perm && !can(who, perm)) fail(403, DENIED[perm] || "Not allowed.");
  return { state, who, me: me as Caller & { profile: Profile } };
}
/** Name used in history and on decisions: "SGT Name", else the account name. */
const nameOf = (a: { who: Who; me: Caller }) => a.who.cadet ? rankName(a.who.cadet) : (a.me.profile?.display_name || a.me.email.split("@")[0]);

// ---- notifications -------------------------------------------------------------------------------
let keys: { public_key: string; private_key: string } | null = null;
async function vapidKeys() {
  if (keys) return keys;
  const read = async () => {
    const { data, error } = await db.from("cadetflow_push_keys").select("public_key, private_key").eq("id", 1).maybeSingle();
    if (error) throw new Error("read keys: " + error.message);
    return data;
  };
  let data = await read();
  if (!data) {
    const k = webpush.generateVAPIDKeys();
    const { error } = await db.from("cadetflow_push_keys").upsert({ id: 1, public_key: k.publicKey, private_key: k.privateKey }, { onConflict: "id", ignoreDuplicates: true });
    if (error) throw new Error("save keys: " + error.message);
    data = await read();
    if (!data) throw new Error("keys missing after save");
  }
  keys = data;
  webpush.setVapidDetails(SITE, keys.public_key, keys.private_key);
  return keys;
}
type Sub = { endpoint: string; p256dh: string; auth: string };
async function sendTo(subs: Sub[], payload: Obj) {
  if (!subs.length) return { sent: 0, failed: 0, removed: 0 };
  await vapidKeys();
  const body = JSON.stringify(payload);
  const results = await Promise.allSettled(subs.map((s) =>
    webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body, { TTL: 86400, urgency: "high" })
  ));
  const gone: string[] = [];
  let sent = 0, failed = 0;
  results.forEach((r, i) => {
    if (r.status === "fulfilled") { sent++; return; }
    failed++;
    const code = (r.reason as { statusCode?: number })?.statusCode;
    if (code === 404 || code === 410) gone.push(subs[i].endpoint);
    else console.error("push failed", code, String((r.reason as Error)?.message || r.reason).slice(0, 200));
  });
  if (gone.length) await db.from("cadetflow_push_subscriptions").delete().in("endpoint", gone);
  return { sent, failed, removed: gone.length };
}
/** Devices of these people. kind: a notification people can switch off (NOTIFY_KINDS); those who did are left out. */
async function devicesOf(userIds: string[], kind?: string): Promise<Sub[]> {
  if (kind && userIds.length) {
    const { data: prefs } = await db.from("cadetflow_settings").select("key, value").in("key", userIds.map((u) => "prefs:" + u));
    const off = new Set(((prefs || []) as Obj[]).filter((p) => Array.isArray(p.value?.off) && p.value.off.includes(kind)).map((p) => String(p.key).slice(6)));
    userIds = userIds.filter((u) => !off.has(u));
  }
  if (!userIds.length) return [];
  const { data, error } = await db.from("cadetflow_push_subscriptions").select("endpoint, p256dh, auth").in("user_id", userIds);
  if (error) throw new Error("could not read devices: " + error.message);
  return (data || []) as Sub[];
}
/** Record that something was sent (key in cadetflow_push_sent); false when it was already. */
async function claimOnce(key: string) {
  const { error } = await db.from("cadetflow_push_sent").insert({ parade_id: key, sent_by: null });
  if (error?.code === "23505") return false;
  if (error) throw new Error("could not record the notification: " + error.message);
  return true;
}
/**
 * Mess duty calls (rules messCallsDue): the advance volunteers first, then every cadet who can do it at that
 * parade, then the lance corporals and corporals to pick. Each call goes once per parade (cadetflow_push_sent
 * "messcall:<parade>:<stage>") and is recorded on the day as asked[stage] (+ asked[stage + "N"], how many).
 * only: one parade id (when the CQMS just turned refreshments on). Returns how many calls were made.
 */
async function runMessCalls(only: string | null) {
  const now = Date.now();
  let { state } = await readState();
  let made = 0, profiles: Obj[] | null = null;
  for (let round = 0; round < 3; round++) { // a call with nobody to ask lets the next one go at once
    const due = messCallsDue(state, now).filter((x: Obj) => !only || x.pd.id === only);
    if (!due.length) break;
    profiles = profiles || await approvedProfiles();
    for (const { pd, stage } of due as { pd: Obj; stage: string }[]) {
      const day = (Array.isArray(state.messDuty) ? state.messDuty : []).find((d: Obj) => d && d.paradeId === pd.id);
      const on = new Set((Array.isArray(day?.cadetIds) ? day.cadetIds : []).map(String));
      const date = istDay(Number(pd.reportAt)).date, left = messPerDay(state.messConfig) - on.size;
      const free = cadetsOf(state).filter((c) => !on.has(String(c.id)) && !excusedFrom(pd, c.id) && messCanDo(c, pd, date, state.messConfig, state.leaves));
      const title = String(pd.title || "the parade"), places = `${left} place${left === 1 ? "" : "s"}`;
      let ids: string[], payload: Obj;
      if (stage === "standby") {
        const sb = new Set(messStandbyIds(state));
        ids = free.filter((c) => sb.has(String(c.id))).map((c) => String(c.id));
        payload = { title: `Mess duty: ${title}`, body: `You offered to help. ${places} at ${when(Number(pd.reportAt))}. Open it to take one.` };
      } else if (stage === "all") {
        ids = free.map((c) => String(c.id));
        payload = { title: `Volunteers wanted: mess duty`, body: `${title}, ${when(Number(pd.reportAt))}: ${places} left. Open it to volunteer.` };
      } else {
        const leads = cadetsOf(state).filter((c) => messLeadRank(c));
        const there = leads.filter((c) => inParade(c, pd));
        ids = (there.length ? there : leads).map((c) => String(c.id));
        payload = { title: `Pick mess duty: ${title}`, body: `${places} still empty at ${when(Number(pd.reportAt))}. Pick cadets on the Parades page.` };
      }
      const people = profiles.filter((p) => p.cadet_id && ids.includes(String(p.cadet_id))).map((p) => p.user_id);
      if (await claimOnce(`messcall:${pd.id}:${stage}`) && people.length) await tell(people, { ...payload, tag: `messcall-${pd.id}`, url: `./?parade=${encodeURIComponent(pd.id)}` }, stage === "leads" ? undefined : "messCalls");
      state = await changeState(null, (s) => {
        const p = findParade(s, pd.id); if (!p) return false;
        if (!Array.isArray(s.messDuty)) s.messDuty = [];
        let d = s.messDuty.find((x: Obj) => x && x.paradeId === p.id);
        if (!d) { d = { id: `mess-${p.id}`, paradeId: p.id, date: istDay(Number(p.reportAt)).date, cadetIds: [], volunteers: [], at: Date.now(), by: "CadetFlow" }; s.messDuty.push(d); }
        const asked = d.asked && typeof d.asked === "object" ? d.asked : {};
        if (asked[stage]) return false;
        d.asked = { ...asked, [stage]: now, [stage + "N"]: ids.length };
        addHistory(s, "mess-call", null, `Mess duty at ${title}: ${stage === "standby" ? "asked the advance volunteers" : stage === "all" ? "asked every cadet who can do it" : "asked the lance corporals and corporals to pick"} (${ids.length})`);
        return true;
      });
      made++;
    }
  }
  return made;
}
async function approvedProfiles() {
  const { data, error } = await db.from("cadetflow_profiles").select("user_id, cadet_id, status, role").eq("status", "approved");
  if (error) throw new Error("could not read accounts: " + error.message);
  return data || [];
}
/** The CQMS's accounts (the administrator when nobody is CQMS). */
async function cqmsPeople(state: Obj) {
  const all = await approvedProfiles();
  const cqms = all.filter((p) => String(findCadet(state, p.cadet_id)?.rank || "").toUpperCase() === "CQMS").map((p) => p.user_id);
  return cqms.length ? cqms : all.filter((p) => p.role === "admin").map((p) => p.user_id);
}
async function adminPeople() { return (await approvedProfiles()).filter((p) => p.role === "admin").map((p) => p.user_id); }
/** Send without failing the action that triggered it. */
async function tell(userIds: string[], payload: Obj, kind?: string) {
  try { return await sendTo(await devicesOf(userIds, kind), payload); } catch (e) { console.error("notify", e); return { sent: 0, failed: 0, removed: 0 }; }
}

// ---- files ---------------------------------------------------------------------------------------
const MAX_IMAGE = 4 * 1024 * 1024;
async function saveImage(path: string, dataUrl: unknown) {
  const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ""));
  if (!m) fail(400, "The picture could not be read. Use a JPG or PNG.");
  const bin = atob(m[2]);
  if (bin.length > MAX_IMAGE) fail(413, "The picture is too large (4 MB at most).");
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const full = `${path}.${m[1] === "jpeg" ? "jpg" : m[1]}`;
  const { error } = await db.storage.from(BUCKET).upload(full, bytes, { contentType: `image/${m[1]}`, upsert: true });
  if (error) throw new Error("could not save the picture: " + error.message);
  return full;
}
async function removeFiles(paths: (string | null | undefined)[]) {
  const list = [...new Set(paths.filter((p): p is string => !!p))];
  if (!list.length) return;
  const { error } = await db.storage.from(BUCKET).remove(list);
  if (error) console.error("remove files", error.message);
}
async function signed(path: string) {
  const { data, error } = await db.storage.from(BUCKET).createSignedUrl(path, 600);
  if (error || !data?.signedUrl) throw new Error("could not open the file: " + (error?.message || "unknown"));
  return data.signedUrl;
}
const safePart = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "_");

let lastCleanup = 0;
/** Delete files nobody needs any more (see the top of this file). */
async function cleanup(state: Obj, by: string, force = false) {
  if (!force && Date.now() - lastCleanup < 5 * 60_000) return;
  lastCleanup = Date.now();
  try {
    // Late/absence request screenshots, and requests for deleted parades.
    const { data, error } = await db.from("cadetflow_requests").select("id, parade_id, status, image_path, to_date").limit(5000);
    if (error) throw error;
    const { deleteRows, clearImages } = requestCleanup(data || [], Array.isArray(state.parades) ? state.parades : []);
    await removeFiles([...deleteRows, ...clearImages].map((r: Obj) => r.image_path));
    if (clearImages.length) await db.from("cadetflow_requests").update({ image_path: null }).in("id", clearImages.map((r: Obj) => r.id));
    if (deleteRows.length) await db.from("cadetflow_requests").delete().in("id", deleteRows.map((r: Obj) => r.id));

    // Payment screenshots that are finished with.
    const done: string[] = payProofsToDelete(uniformOf(state));
    if (done.length) {
      await removeFiles(uniformOf(state).filter((r) => done.includes(r.pay?.proofId)).map((r) => r.pay.file));
      await changeState(by, (s) => {
        let changed = false;
        uniformOf(s).forEach((r) => { if (r.pay?.file && done.includes(r.pay.proofId)) { delete r.pay.file; changed = true; } });
        return changed;
      });
    }
    // Payment screenshots whose requests were removed.
    const used = new Set(uniformOf(state).map((r) => r.pay?.file).filter(Boolean));
    const { data: files } = await db.storage.from(BUCKET).list("pay", { limit: 1000 });
    const stale = (files || []).filter((f) => f.name && !used.has(`pay/${f.name}`) && Date.now() - Date.parse(f.created_at || "") > 86400_000);
    await removeFiles(stale.map((f) => `pay/${f.name}`));
  } catch (e) { console.error("cleanup", e); }
}

function requestOut(r: Obj) {
  return {
    id: r.id, paradeId: r.parade_id, cadetId: r.cadet_id, kind: r.kind, reason: r.reason, status: r.status, note: r.note || "",
    at: Date.parse(r.created_at), updatedAt: Date.parse(r.updated_at), decidedAt: r.decided_at ? Date.parse(r.decided_at) : null,
    decidedBy: r.decided_by_name || "", hasImage: !!r.image_path, hadImage: !!r.had_image, mine: false, ...(r.dismissed_at ? { dismissed: true } : {}),
    ...(isLeaveRequest(r) ? { fromDate: String(r.from_date || "").slice(0, 10), toDate: String(r.to_date || "").slice(0, 10) } : {}),
  };
}
const REQ_COLS = "id, parade_id, cadet_id, user_id, kind, reason, status, note, image_path, had_image, created_at, updated_at, decided_at, decided_by, decided_by_name, from_date, to_date, dismissed_at";

// ---- accounts ------------------------------------------------------------------------------------
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const cleanEmail = (v: unknown) => String(v || "").trim().toLowerCase();
const cleanRegNo = (v: unknown) => String(v || "").toUpperCase().replace(/\s+/g, "").slice(0, 30);
function checkPassword(p: unknown) {
  const s = String(p || "");
  if (s.length < 8) fail(400, "The password needs at least 8 characters.");
  if (s.length > 72) fail(400, "The password is too long.");
  return s;
}
/** Where links in emails lead: this site (or a local copy being tested). */
function siteOf(body: Obj) {
  const s = String(body.site || "").split("#")[0].split("?")[0];
  return s.startsWith(SITE) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(s) ? s : SITE;
}
async function profileOf(userId: string) {
  const { data, error } = await db.from("cadetflow_profiles").select("*").eq("user_id", userId).maybeSingle();
  if (error) throw new Error("could not read the account: " + error.message);
  return data as Profile | null;
}
async function keepAnAdmin(userId: string) {
  const admins = await adminPeople();
  if (admins.length === 1 && admins[0] === userId) fail(400, "This is the only administrator. Make someone else administrator first.");
}
async function allUsers() {
  const out: Obj[] = [];
  for (let page = 1; page < 50; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error("could not list accounts: " + error.message);
    out.push(...data.users);
    if (data.users.length < 1000) break;
  }
  return out;
}
async function userByEmail(email: string) {
  const { data } = await db.from("cadetflow_profiles").select("user_id").eq("email", email).maybeSingle();
  if (data?.user_id) {
    const { data: u } = await db.auth.admin.getUserById(data.user_id);
    if (u?.user) return u.user;
  }
  return (await allUsers()).find((u) => (u.email || "").toLowerCase() === email) || null;
}
/** A link that signs the person in to set a password (no email sent). */
async function passwordLink(email: string, type: "invite" | "recovery", site: string, data?: Obj) {
  const { data: made, error } = await db.auth.admin.generateLink(
    type === "invite" ? { type, email, options: { redirectTo: site, data } } : { type, email, options: { redirectTo: site } },
  );
  if (error || !made?.properties?.action_link) throw new Error("could not make the link: " + (error?.message || "unknown"));
  return { link: made.properties.action_link as string, userId: made.user?.id as string | undefined };
}

// ---- the actions -----------------------------------------------------------------------------------
async function handle(req: Request, body: Obj): Promise<Response> {
  const action = String(body.action || "");

  // Anyone ------------------------------------------------------------------------------------------
  if (action === "key") return json({ publicKey: (await vapidKeys()).public_key });

  if (action === "roster") {
    const { state } = await readState();
    const { data, error } = await db.from("cadetflow_profiles").select("cadet_id").not("cadet_id", "is", null).neq("status", "rejected");
    if (error) throw new Error("could not read accounts: " + error.message);
    const taken = new Set((data || []).map((p) => String(p.cadet_id)));
    const cadets = cadetsOf(state).map((c) => ({ id: String(c.id), name: String(c.name || ""), rank: c.rank || "CDT", company: c.company || "", year: c.year || "", taken: taken.has(String(c.id)) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return json({ cadets });
  }

  if (action === "register") {
    const email = cleanEmail(body.email);
    const regNo = cleanRegNo(body.regNo);
    if (!EMAIL.test(email)) fail(400, "Enter a valid email address.");
    if (regNo && regNo.length < 4) fail(400, "That regimental number looks too short. Leave it empty to add it later.");
    const password = checkPassword(body.password);
    const { state } = await readState();
    const cadet = findCadet(state, body.cadetId);
    if (!cadet) fail(400, "Choose your name from the roster.");
    // The regimental number is not checked here: an answer of "does not match" would let anyone try numbers
    // until one fits. The administrator sees whether it matches the roster before approving.
    const { count } = await db.from("cadetflow_profiles").select("user_id", { count: "exact", head: true }).eq("status", "pending");
    if ((count || 0) > 300) fail(429, "Too many registrations are waiting. Ask the administrator.");
    const { data: holder } = await db.from("cadetflow_profiles").select("user_id").eq("cadet_id", String(cadet.id)).neq("status", "rejected").maybeSingle();
    if (holder) fail(409, `${cadet.name} already has an account. If that is you, sign in, or ask the administrator.`);

    const { data: made, error } = await db.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { name: cadet.name } });
    if (error || !made?.user) {
      if (/already|registered|exists/i.test(error?.message || "")) fail(409, "An account with this email already exists. Sign in instead.");
      throw new Error("could not create the account: " + (error?.message || "unknown"));
    }
    const { error: profErr } = await db.from("cadetflow_profiles").insert({
      user_id: made.user.id, display_name: cadet.name, role: "viewer", status: "pending", email,
      cadet_id: String(cadet.id), regimental_no: regNo || null, requested_at: new Date().toISOString(),
    });
    if (profErr) {
      await db.auth.admin.deleteUser(made.user.id);
      if (profErr.code === "23505") fail(409, `${cadet.name} already has an account.`);
      throw new Error("could not save the registration: " + profErr.message);
    }
    await tell(await adminPeople(), { title: "New registration", body: `${rankName(cadet)} is waiting for approval.`, tag: "accounts", url: "./?page=accounts" });
    return json({ ok: true });
  }

  if (action === "forgot") {
    // Always the same answer, so nobody can find out which emails have accounts.
    const email = cleanEmail(body.email);
    if (EMAIL.test(email)) {
      const user = await userByEmail(email);
      if (user) {
        const prof = await profileOf(user.id);
        const last = prof && (prof as Obj).reset_requested_at ? Date.parse((prof as Obj).reset_requested_at) : 0;
        if (prof && Date.now() - last > 10 * 60_000) {
          await db.from("cadetflow_profiles").update({ reset_requested_at: new Date().toISOString(), email }).eq("user_id", user.id);
          await tell(await adminPeople(), { title: "Password reset asked", body: `${prof.display_name || email} forgot their password. Send them a reset link from Accounts.`, tag: "accounts", url: "./?page=accounts" });
        }
      }
    }
    return json({ ok: true });
  }

  if (action === "unsubscribe") {
    if (typeof body.endpoint !== "string") fail(400, "Bad request");
    await db.from("cadetflow_push_subscriptions").delete().eq("endpoint", body.endpoint);
    return json({ ok: true });
  }

  if (action === "test") {
    const { data: sub } = await db.from("cadetflow_push_subscriptions").select("endpoint, p256dh, auth").eq("endpoint", String(body.endpoint || "")).maybeSingle();
    if (!sub) fail(404, "This device is not registered for notifications.");
    const r = await sendTo([sub as Sub], { title: "CadetFlow", body: "Notifications are working. You'll get one when a parade for you is posted.", tag: "cadetflow-test", url: "./" });
    return json({ ok: r.sent === 1, ...r });
  }

  // Signed in -----------------------------------------------------------------------------------------
  const me = await caller(req);

  if (action === "remind") {
    let { state } = await readState();
    const now = Date.now();
    let parades = 0, mess = 0;
    // Mess duty: ask the advance volunteers, then every cadet who can do it, then the lance corporals and corporals.
    const calls = await runMessCalls(null);
    if (calls) state = (await readState()).state;
    const claim = claimOnce;
    const due = paradesToRemind(Array.isArray(state.parades) ? state.parades : [], now);
    const days = messToRemind(Array.isArray(state.messDuty) ? state.messDuty : [], now);
    const profiles = (due.length || days.length) ? await approvedProfiles() : [];
    for (const pd of due) {
      // One reminder per parade time, so a parade moved after its reminder went out gets a new one.
      // Reminders sent before keys carried the time ("remind:<id>") still count for the time they were for.
      const { data: legacy } = await db.from("cadetflow_push_sent").select("sent_at").eq("parade_id", "remind:" + pd.id).maybeSingle();
      if (legacy && Date.parse(legacy.sent_at) >= Number(pd.reportAt) - REMIND_BEFORE_MS - 20 * 60000 && Date.parse(legacy.sent_at) <= Number(pd.reportAt)) continue;
      if (!(await claim(`remind:${pd.id}@${pd.reportAt}`))) continue;
      const people = paradeRecipients(profiles, cadetsOf(state), pd, state.leaves || []); // not those on leave
      const mins = Math.round((Number(pd.reportAt) - now) / 60000);
      const left = mins >= 60 ? `${Math.floor(mins / 60)} h ${String(mins % 60).padStart(2, "0")} min` : `${mins} min`;
      await tell(people, { title: `In ${left}: ${String(pd.title || "Parade")}`, body: [when(Number(pd.reportAt)), pd.venue ? String(pd.venue) : "", pd.dress ? `Turnout: ${String(pd.dress)}` : "", pd.kit ? `Bring: ${String(pd.kit)}` : ""].filter(Boolean).join(" · "), tag: `remind-${pd.id}`, url: `./?parade=${encodeURIComponent(pd.id)}` }, "reminders");
      parades++;
    }
    for (const d of days) {
      const pd = d.paradeId ? findParade(state, d.paradeId) : null;
      if (d.paradeId && !pd) continue; // the parade was cancelled: no mess duty
      if (pd && !hasRefreshments(pd, state.messDuty)) continue; // the CQMS turned refreshments off for it
      // Each cadet once (so someone put on it later still hears); a day reminded before keys carried the
      // cadet ("mess:<id>") is done.
      const { data: legacy } = await db.from("cadetflow_push_sent").select("parade_id").eq("parade_id", "mess:" + d.id).maybeSingle();
      if (legacy) continue;
      const day = new Intl.DateTimeFormat("en-IN", { timeZone: IST, weekday: "long", day: "numeric", month: "short" }).format(new Date(`${d.date}T12:00:00+05:30`));
      let told = 0;
      for (const id of (d.cadetIds as unknown[]).map(String)) {
        if (!(await claim(`mess:${d.id}@${id}`))) continue;
        const people = profiles.filter((p) => p.cadet_id && String(p.cadet_id) === id).map((p) => p.user_id);
        const picked = !(Array.isArray(d.volunteers) ? d.volunteers.map(String) : []).includes(id);
        await tell(people, { title: "Mess duty", body: pd ? `You are on mess duty at ${String(pd.title || "the parade")} on ${day}${picked ? " (picked: not enough volunteers)" : ""}: return the refreshments to the mess.` : `You are on mess duty on ${day}.`, tag: `mess-${d.id}`, url: "./?page=parades" });
        told++;
      }
      if (told) mess++;
    }
    // A parade marked in the last 3 days took a cadet below 75%: tell them once.
    let drops = 0, overdue = 0;
    const drop = attendanceDrops(state, now);
    const equip = equipmentOverdue(state.equipment, now);
    if (drop.length || equip.length) {
      const everyone = profiles.length ? profiles : await approvedProfiles();
      const accountsOf = (cadetId: string) => everyone.filter((p) => String(p.cadet_id || "") === cadetId).map((p) => p.user_id);
      for (const d of drop) {
        if (!(await claim(`below75:${d.cadetId}@${d.paradeId}`))) continue;
        await tell(accountsOf(d.cadetId), { title: `Attendance ${d.pct}%`, body: `You are below 75%. Attend the next ${d.need} parade${d.need === 1 ? "" : "s"} to get back to 75%.`, tag: "attendance", url: "./?page=home" });
        drops++;
      }
      for (const e of equip) {
        if (!(await claim(`equip:${e.id}@${e.dueDate}`))) continue;
        await tell(accountsOf(String(e.cadetId)), { title: "Return equipment", body: `${String(e.item || "Equipment")}${Number(e.qty) > 1 ? ` x${e.qty}` : ""} was due back on ${e.dueDate}. Return it to the CQMS.`, tag: `equip-${e.id}`, url: "./?page=uniform" });
        overdue++;
      }
    }
    // Sunday evening: the week in numbers for the administrator.
    let weekly = 0;
    if (istWeekday(now) === 0 && istDay(now).hour >= WEEKLY_HOUR && await claim("weekly:" + istDay(now).date)) {
      const w = weekSummary(state, now);
      const [{ count: waitingRequests }, { count: waitingAccounts }] = await Promise.all([
        db.from("cadetflow_requests").select("id", { count: "exact", head: true }).eq("status", "pending"),
        db.from("cadetflow_profiles").select("user_id", { count: "exact", head: true }).eq("status", "pending"),
      ]);
      const parts = [
        `${w.parades} parade${w.parades === 1 ? "" : "s"}${w.pct != null ? `, attendance ${w.pct}%` : ""}${w.byCompany.length > 1 ? ` (${w.byCompany.map((x: Obj) => `${x.company} ${x.pct}%`).join(", ")})` : ""}`,
        w.under.length ? `${w.under.length} under 75%` : "",
        waitingRequests ? `${waitingRequests} request${waitingRequests === 1 ? "" : "s"} waiting` : "",
        w.owed ? `${rupees(w.owed)} uniform money owed` : "",
        waitingAccounts ? `${waitingAccounts} account${waitingAccounts === 1 ? "" : "s"} to approve` : "",
      ].filter(Boolean);
      await tell(await adminPeople(), { title: "The week in CadetFlow", body: parts.join(" · "), tag: "weekly", url: "./?page=home" }, "weekly");
      weekly = 1;
    }
    // Kept for the administrator's System check: when the reminders last ran (the job runs every 10 minutes).
    const result = { parades, mess, calls, weekly, drops, overdue };
    const { error: recErr } = await db.from("cadetflow_settings").upsert({ key: "remind", value: { at: new Date().toISOString(), ...result }, updated_at: new Date().toISOString() }, { onConflict: "key" });
    if (recErr) console.error("remind record", recErr.message);
    return json(result);
  }
  if (action === "subscribe") {
    const a = await access(me, null);
    const s = body.subscription;
    if (!s || typeof s.endpoint !== "string" || !/^https:\/\//.test(s.endpoint) || !s.keys?.p256dh || !s.keys?.auth) fail(400, "Bad subscription");
    const { error } = await db.from("cadetflow_push_subscriptions").upsert({
      endpoint: s.endpoint, p256dh: String(s.keys.p256dh), auth: String(s.keys.auth), user_id: a.me.id,
      user_agent: String(req.headers.get("user-agent") || "").slice(0, 300), updated_at: new Date().toISOString(),
    }, { onConflict: "endpoint" });
    if (error) throw error;
    return json({ ok: true });
  }

  // ---- own regimental number, added once (changing it later is for the administrator)
  if (action === "myRegNo") {
    const a = await access(me, null);
    if (!a.who.cadet) fail(400, "Your account is not linked to your name on the roster. Ask the administrator.");
    const regNo = cleanRegNo(body.regNo);
    if (regNo.length < 4 || !/^[A-Z0-9/-]+$/.test(regNo)) fail(400, "Enter your regimental number as on your NCC card.");
    const cadetId = String(a.who.cadet.id);
    await changeState(a.me.id, (s) => {
      const c = findCadet(s, cadetId);
      if (!c) fail(404, "You are no longer on the roster.");
      if (c.regNo) fail(409, "Your regimental number is already on the roster. Ask the administrator to change it.");
      const dup = cadetsOf(s).find((x) => String(x.id) !== cadetId && cleanRegNo(x.regNo) === regNo);
      if (dup) fail(409, "Another cadet already has that regimental number. Ask the administrator.");
      c.regNo = regNo;
      addHistory(s, "roster-regno", cadetId, `Regimental number added by ${rankName(c)}`);
      return true;
    });
    await db.from("cadetflow_profiles").update({ regimental_no: regNo }).eq("user_id", a.me.id);
    return json({ ok: true });
  }

  // ---- late / absence requests
  if (action === "report") {
    const a = await access(me, null);
    if (!a.who.cadet) fail(400, "Your account is not linked to your name on the roster. Ask the administrator.");
    const cadetId = String(a.who.cadet.id);
    const kind = body.kind === "late" || body.kind === "absent" ? body.kind : fail(400, "Choose coming late or can't come.");
    const reason = String(body.reason || "").trim().replace(/\s+/g, " ").slice(0, 500);
    if (reason.length < 3) fail(400, "Write the reason.");
    const pd = findParade(a.state, String(body.paradeId || ""));
    if (!pd) fail(404, "That parade no longer exists.");
    if (!inParade(a.who.cadet, pd)) fail(403, "This parade is not for you.");
    if (!requestsOpen(pd)) fail(403, `Requests closed ${CUTOFF_MIN} minutes before reporting time. Tell a senior directly.`);

    const { data: old, error: oldErr } = await db.from("cadetflow_requests").select(REQ_COLS).eq("parade_id", pd.id).eq("cadet_id", cadetId).eq("status", "pending").maybeSingle();
    if (oldErr) throw new Error("could not read your request: " + oldErr.message);
    const id = old?.id || crypto.randomUUID();
    let image = old?.image_path || null;
    const replaced: (string | null)[] = [];
    if (body.image) { replaced.push(image); image = await saveImage(`${safePart(pd.id)}/${id}-${Date.now().toString(36)}`, body.image); }
    else if (body.removeImage && image) { replaced.push(image); image = null; }
    const row = { parade_id: pd.id, cadet_id: cadetId, user_id: a.me.id, kind, reason, image_path: image, had_image: !!image || !!old?.had_image, updated_at: new Date().toISOString() };
    const { data: saved, error } = old
      ? await db.from("cadetflow_requests").update(row).eq("id", id).select(REQ_COLS).single()
      : await db.from("cadetflow_requests").insert({ id, ...row }).select(REQ_COLS).single();
    if (error) {
      if (image && image !== old?.image_path) await removeFiles([image]);
      if (error.code === "23505") fail(409, "You already sent a request for this parade.");
      throw new Error("could not save your request: " + error.message);
    }
    await removeFiles(replaced.filter((p) => p !== image));
    return json({ request: { ...requestOut(saved), mine: true } });
  }

  if (action === "withdraw") {
    const a = await access(me, null);
    const { data: r } = await db.from("cadetflow_requests").select("id, user_id, status, image_path").eq("id", String(body.id || "")).maybeSingle();
    if (!r || r.user_id !== a.me.id) fail(404, "That request no longer exists.");
    if (r.status !== "pending") fail(400, "That request was already decided.");
    await db.from("cadetflow_requests").delete().eq("id", r.id);
    await removeFiles([r.image_path]);
    return json({ ok: true });
  }

  // A cadet clears their own declined request from their view ({ id, undo? }); sergeants and above still see it.
  if (action === "dismiss") {
    const a = await access(me, null);
    const { data: r } = await db.from("cadetflow_requests").select("id, user_id, status").eq("id", String(body.id || "")).maybeSingle();
    if (!r || r.user_id !== a.me.id) fail(404, "That request no longer exists.");
    if (r.status !== "rejected") fail(400, r.status === "pending" ? "That request is still waiting: withdraw it instead." : "Only a request that was not approved can be cleared.");
    const { error } = await db.from("cadetflow_requests").update({ dismissed_at: body.undo === true ? null : new Date().toISOString() }).eq("id", r.id);
    if (error) throw new Error("could not clear it: " + error.message);
    return json({ ok: true });
  }

  if (action === "leave") {
    const a = await access(me, null);
    if (!a.who.cadet) fail(400, "Your account is not linked to your name on the roster. Ask the administrator.");
    const cadetId = String(a.who.cadet.id);
    const from = String(body.from || ""), to = String(body.to || "");
    if (!/^\d{4}-\d\d-\d\d$/.test(from) || !/^\d{4}-\d\d-\d\d$/.test(to) || !Number.isFinite(Date.parse(from)) || !Number.isFinite(Date.parse(to))) fail(400, "Pick the first and the last day of your leave.");
    if (to < from) fail(400, "The last day is before the first day.");
    if (to < istDay(Date.now()).date) fail(400, "Those days are already over.");
    if ((Date.parse(to) - Date.parse(from)) / 86400000 > 120) fail(400, "Leave can be 120 days at most. Ask the administrator.");
    const reason = String(body.reason || "").trim().replace(/\s+/g, " ").slice(0, 500);
    if (reason.length < 3) fail(400, "Write the reason.");
    const { count } = await db.from("cadetflow_requests").select("id", { count: "exact", head: true }).eq("cadet_id", cadetId).eq("kind", "leave").eq("status", "pending");
    if ((count || 0) >= 3) fail(429, "You already have 3 leave requests waiting. Wait for a decision, or withdraw one.");
    const id = crypto.randomUUID();
    const image = body.image ? await saveImage(`leave/${id}-${Date.now().toString(36)}`, body.image) : null;
    const now = new Date().toISOString();
    const { data: saved, error } = await db.from("cadetflow_requests").insert({
      id, parade_id: `leave:${from}`, cadet_id: cadetId, user_id: a.me.id, kind: "leave", reason, image_path: image, had_image: !!image,
      from_date: from, to_date: to, created_at: now, updated_at: now,
    }).select(REQ_COLS).single();
    if (error) {
      if (image) await removeFiles([image]);
      if (error.code === "23505") fail(409, "You already asked for leave from that day. Withdraw that request to change it.");
      throw new Error("could not save your request: " + error.message);
    }
    return json({ request: { ...requestOut(saved), mine: true } });
  }

  if (action === "requests") {
    const a = await access(me, null);
    const everyone = can(a.who, "requests");
    if (everyone) await cleanup(a.state, a.me.id);
    const since = new Date(Date.now() - 45 * 86400_000).toISOString();
    let q = db.from("cadetflow_requests").select(REQ_COLS).gte("created_at", since).order("created_at", { ascending: true }).limit(2000);
    // (Leave asked for more than 45 days ago has long been decided; approved leave lives on in the shared data.)
    if (!everyone) q = q.eq("user_id", a.me.id).is("dismissed_at", null); // a cadet's cleared requests stay with the seniors
    const { data, error } = await q;
    if (error) throw new Error("could not read requests: " + error.message);
    // Sergeants: only cadets of their own company (rules requestsFor); their own requests always.
    const shown = (data || []).filter((r) => !everyone || r.user_id === a.me.id || requestsFor(a.who, findCadet(a.state, r.cadet_id)));
    return json({ requests: shown.map((r) => ({ ...requestOut(r), mine: r.user_id === a.me.id })) });
  }

  if (action === "reportImage") {
    const a = await access(me, "requests");
    const { data: r } = await db.from("cadetflow_requests").select("image_path, cadet_id").eq("id", String(body.id || "")).maybeSingle();
    if (r && !requestsFor(a.who, findCadet(a.state, r.cadet_id))) fail(403, SCOPE_DENIED);
    if (!r?.image_path) fail(404, "The screenshot was already deleted.");
    return json({ url: await signed(r.image_path) });
  }

  if (action === "decide") {
    const a = await access(me, "requests");
    const { data: r, error } = await db.from("cadetflow_requests").select(REQ_COLS).eq("id", String(body.id || "")).maybeSingle();
    if (error) throw new Error("could not read the request: " + error.message);
    if (!r) fail(404, "That request was withdrawn.");
    if (r.status !== "pending") return json({ request: requestOut(r), already: true });
    if (r.user_id === a.me.id && !a.who.admin) fail(403, "Another senior has to decide on your own request.");
    if (!requestsFor(a.who, findCadet(a.state, r.cadet_id))) fail(403, SCOPE_DENIED);
    const approve = body.approve === true;
    const note = String(body.note || "").trim().slice(0, 300);
    const decider = nameOf(a);
    let state = a.state;
    if (isLeaveRequest(r)) {
      const from = String(r.from_date || "").slice(0, 10), to = String(r.to_date || "").slice(0, 10);
      if (approve) {
        state = await changeState(a.me.id, (s) => {
          const c = findCadet(s, r.cadet_id);
          s.leaves = (Array.isArray(s.leaves) ? s.leaves : []).filter((l: Obj) => l && l.requestId !== r.id);
          s.leaves.push({ id: `leave-${r.id}`, cadetId: r.cadet_id, from, to, requestId: r.id, at: Date.now(), by: decider });
          addHistory(s, "leave-approved", r.cadet_id, `${c?.name || r.cadet_id}: leave ${from} to ${to} approved by ${decider}`);
          return true;
        });
      }
      const { data: done, error: upErr } = await db.from("cadetflow_requests").update({
        status: approve ? "approved" : "rejected", note: note || null, decided_at: new Date().toISOString(), decided_by: a.me.id, decided_by_name: decider, updated_at: new Date().toISOString(),
      }).eq("id", r.id).select(REQ_COLS).single();
      if (upErr) throw new Error("could not save the decision: " + upErr.message);
      const day = (d: string) => new Intl.DateTimeFormat("en-IN", { timeZone: IST, day: "numeric", month: "short" }).format(new Date(`${d}T12:00:00+05:30`));
      if (r.user_id) await tell([r.user_id], { title: approve ? "Leave approved" : "Leave not approved", body: [from === to ? day(from) : `${day(from)} to ${day(to)}`, note].filter(Boolean).join(" · "), tag: `request-${r.id}`, url: "./?page=parades" });
      await cleanup(state, a.me.id, true);
      return json({ request: requestOut(done) });
    }
    if (approve) {
      state = await changeState(a.me.id, (s) => {
        const pd = findParade(s, r.parade_id);
        if (!pd) fail(404, "That parade was deleted.");
        const c = findCadet(s, r.cadet_id);
        pd.reports = (Array.isArray(pd.reports) ? pd.reports : []).filter((x: Obj) => x && x.cadetId !== r.cadet_id);
        pd.reports.push(approvedReport(r, { cadetId: a.who.cadet ? String(a.who.cadet.id) : "", name: decider }));
        addHistory(s, "parade-report", r.cadet_id, `${c?.name || r.cadet_id}: ${r.kind === "absent" ? "can't come" : "coming late"} to ${pd.title} – ${r.reason}; request approved by ${decider}`);
        return true;
      });
    }
    const { data: done, error: upErr } = await db.from("cadetflow_requests").update({
      status: approve ? "approved" : "rejected", note: note || null, decided_at: new Date().toISOString(), decided_by: a.me.id, decided_by_name: decider, updated_at: new Date().toISOString(),
    }).eq("id", r.id).select(REQ_COLS).single();
    if (upErr) throw new Error("could not save the decision: " + upErr.message);
    const pd = findParade(state, r.parade_id);
    if (r.user_id && pd) {
      await tell([r.user_id], {
        title: approve ? "Request approved" : "Request not approved",
        body: [`${pd.title || "Parade"}, ${when(Number(pd.reportAt))}`, r.kind === "absent" ? "Can't come" : "Coming late", note].filter(Boolean).join(" · "),
        tag: `request-${r.id}`, url: `./?parade=${encodeURIComponent(r.parade_id)}`,
      });
    }
    await cleanup(state, a.me.id, true);
    return json({ request: requestOut(done) });
  }

  // ---- a page ran into a problem: kept for the administrator's System check (same message counted, not repeated)
  if (action === "reportError") {
    const a = await access(me, null);
    const message = String(body.message || "").slice(0, 300).trim();
    if (!message) return json({ ok: true });
    const place = String(body.place || "").slice(0, 200), agent = String(req.headers.get("user-agent") || "").slice(0, 200), page = String(body.page || "").slice(0, 40);
    const id = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(message + "|" + place)))).slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
    const { data: old } = await db.from("cadetflow_errors").select("id, count").eq("id", id).maybeSingle();
    const now = new Date().toISOString();
    if (old) await db.from("cadetflow_errors").update({ count: Math.min(1000000, (old.count || 1) + 1), last_at: now, agent, page, name: nameOf(a) }).eq("id", id);
    else {
      const { count } = await db.from("cadetflow_errors").select("id", { count: "exact", head: true });
      if ((count || 0) < 500) await db.from("cadetflow_errors").insert({ id, message, place, agent, page, count: 1, first_at: now, last_at: now, name: nameOf(a) });
    }
    return json({ ok: true });
  }

  // ---- timetables: the administrator edits the roster directly; POCs change anyone's timetable through here
  // (the roster itself stays locked to the administrator).
  if (action === "setTimetable") {
    const a = await access(me, null);
    if (!a.who.admin && !a.who.poc) fail(403, "Only POCs and the administrator can edit timetables.");
    const SLOTS = ["MON1", "MON2", "TUE1", "TUE2", "WED1", "WED2", "THU1", "THU2", "FRI1", "FRI2", "SAT1", "SAT2"];
    const free = SLOTS.filter((x) => (Array.isArray(body.free) ? body.free : []).map(String).includes(x));
    const cadetId = String(body.cadetId || ""), detail = String(body.detail || "timetable edited").slice(0, 120);
    await changeState(a.me.id, (s) => {
      const c = findCadet(s, cadetId);
      if (!c) fail(404, "That cadet is no longer on the roster.");
      c.free = free;
      addHistory(s, "timetable-edited", cadetId, `${c.name}: ${detail} (${nameOf(a)})`);
      return true;
    });
    return json({ ok: true, free });
  }

  // ---- own birthday (month and day only), shown on Home on the day; the cadet adds, changes or removes it
  if (action === "myBirthday") {
    const a = await access(me, null);
    if (!a.who.cadet) fail(400, "Your account is not linked to your name on the roster. Ask the administrator.");
    const md = String(body.md || "");
    if (md && !/^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(md)) fail(400, "Pick the month and day.");
    const cadetId = String(a.who.cadet.id);
    await changeState(a.me.id, (s) => {
      const c = findCadet(s, cadetId);
      if (!c) fail(404, "You are no longer on the roster.");
      if ((c.birthday || "") === md) return false;
      if (md) c.birthday = md; else delete c.birthday;
      return true;
    });
    return json({ ok: true });
  }

  // ---- notification choices: { off: [kinds] } in cadetflow_settings "prefs:<user>"
  if (action === "myPrefs" || action === "setPrefs") {
    const a = await access(me, null);
    const key = "prefs:" + a.me.id;
    if (action === "setPrefs") {
      const off = [...new Set((Array.isArray(body.off) ? body.off : []).map(String).filter((k) => NOTIFY_KINDS.includes(k)))];
      const { error } = await db.from("cadetflow_settings").upsert({ key, value: { off }, updated_at: new Date().toISOString(), updated_by: a.me.id }, { onConflict: "key" });
      if (error) throw new Error("could not save: " + error.message);
      return json({ off });
    }
    const { data } = await db.from("cadetflow_settings").select("value").eq("key", key).maybeSingle();
    return json({ off: Array.isArray((data?.value as Obj)?.off) ? (data!.value as Obj).off : [] });
  }

  // ---- parades
  if (action === "seen") {
    const a = await access(me, null);
    const items = [...new Set((Array.isArray(body.items) ? body.items : []).map(String).filter((i) => SEEN_ITEM.test(i)))].slice(0, 50);
    if (!items.length) return json({ ok: true });
    const { error } = await db.from("cadetflow_seen").upsert(items.map((item) => ({ item, user_id: a.me.id })), { onConflict: "item,user_id", ignoreDuplicates: true });
    if (error) throw new Error("could not record it: " + error.message);
    return json({ ok: true });
  }

  if (action === "seenBy") {
    const a = await access(me, "write");
    const item = String(body.item || "");
    if (!SEEN_ITEM.test(item)) fail(400, "Unknown item.");
    const [kind, id] = [item.slice(0, item.indexOf(":")), item.slice(item.indexOf(":") + 1)];
    const { data: profs, error: pe } = await db.from("cadetflow_profiles").select("user_id, cadet_id, status, role, display_name, email").eq("status", "approved");
    if (pe) throw new Error("could not read accounts: " + pe.message);
    let people = profs || [];
    if (kind === "parade") {
      const pd = findParade(a.state, id);
      if (!pd) fail(404, "That parade is not saved yet.");
      const ids = new Set(paradeRecipients(people, cadetsOf(a.state), pd));
      people = people.filter((p) => ids.has(p.user_id));
    } else if (!(Array.isArray(a.state.notices) ? a.state.notices : []).some((n: Obj) => n && n.id === id)) fail(404, "That notice is not saved yet.");
    const { data: rows, error } = await db.from("cadetflow_seen").select("user_id, seen_at").eq("item", item);
    if (error) throw new Error("could not read who has seen it: " + error.message);
    const at = new Map((rows || []).map((r) => [r.user_id, r.seen_at]));
    const label = (p: Obj) => rankName(findCadet(a.state, p.cadet_id)) || p.display_name || String(p.email || "").split("@")[0] || "Someone";
    const sortByName = (x: Obj, y: Obj) => String(x.name).localeCompare(String(y.name));
    const seen = people.filter((p) => at.has(p.user_id)).map((p) => ({ name: label(p), at: at.get(p.user_id) })).sort((x, y) => Date.parse(y.at) - Date.parse(x.at));
    const notSeen = people.filter((p) => !at.has(p.user_id)).map((p) => ({ name: label(p) })).sort(sortByName);
    return json({ seen, notSeen, total: people.length });
  }

  // ---- questions on notices: notice.options = ['Yes', 'No', …]; answers in cadetflow_answers
  if (action === "answer" || action === "answers" || action === "answersBy") {
    const a = await access(me, action === "answersBy" ? "write" : null);
    const notices = (Array.isArray(a.state.notices) ? a.state.notices : []).filter((n: Obj) => n && Array.isArray(n.options) && n.options.length >= 2);
    const tallies = async (ids: string[]) => {
      const out: Obj = {};
      ids.forEach((id) => { const n = notices.find((x: Obj) => x.id === id); out[id] = { mine: null, counts: n.options.map(() => 0), total: 0 }; });
      if (!ids.length) return out;
      const { data, error } = await db.from("cadetflow_answers").select("notice_id, user_id, choice").in("notice_id", ids);
      if (error) throw new Error("could not read the answers: " + error.message);
      for (const row of data || []) {
        const o = out[row.notice_id]; if (!o || !(row.choice >= 0 && row.choice < o.counts.length)) continue;
        o.counts[row.choice]++; o.total++;
        if (row.user_id === a.me.id) o.mine = row.choice;
      }
      return out;
    };
    if (action === "answers") {
      const ids = [...new Set((Array.isArray(body.ids) ? body.ids : []).map(String))].filter((id) => notices.some((n: Obj) => n.id === id)).slice(0, 30);
      return json({ answers: await tallies(ids) });
    }
    const id = String(body.noticeId || "");
    const n = notices.find((x: Obj) => x.id === id);
    if (!n) fail(404, "That question is not saved yet, or was removed.");
    if (action === "answer") {
      const choice = Number(body.choice);
      if (!Number.isInteger(choice) || choice < 0 || choice >= n.options.length) fail(400, "Pick one of the answers.");
      if (n.until && Number(n.until) < Date.now()) fail(400, "This notice has ended.");
      const { error } = await db.from("cadetflow_answers").upsert({ notice_id: id, user_id: a.me.id, choice, answered_at: new Date().toISOString() }, { onConflict: "notice_id,user_id" });
      if (error) throw new Error("could not save your answer: " + error.message);
      return json((await tallies([id]))[id]);
    }
    // answersBy: names under each answer, and who has not answered
    const { data: profs, error: pe } = await db.from("cadetflow_profiles").select("user_id, cadet_id, status, display_name, email").eq("status", "approved");
    if (pe) throw new Error("could not read accounts: " + pe.message);
    const { data: rows, error } = await db.from("cadetflow_answers").select("user_id, choice").eq("notice_id", id);
    if (error) throw new Error("could not read the answers: " + error.message);
    const picked = new Map((rows || []).map((r) => [r.user_id, r.choice]));
    const person = (p: Obj) => { const c = findCadet(a.state, p.cadet_id); return { name: rankName(c) || p.display_name || String(p.email || "").split("@")[0] || "Someone", company: c?.company || "" }; };
    const byName = (x: Obj, y: Obj) => String(x.name).localeCompare(String(y.name));
    const options = n.options.map((label: string, i: number) => ({ label: String(label), people: (profs || []).filter((p) => picked.get(p.user_id) === i).map(person).sort(byName) }));
    const notAnswered = (profs || []).filter((p) => !picked.has(p.user_id)).map(person).sort(byName);
    return json({ options, notAnswered });
  }

  if (action === "announce") {
    const a = await access(me, "write");
    const id = String(body.id || "");
    const n = (Array.isArray(a.state.notices) ? a.state.notices : []).find((x: Obj) => x && x.id === id);
    if (!n) fail(404, "That notice is not saved yet. Try again in a moment.");
    const { error: claim } = await db.from("cadetflow_push_sent").insert({ parade_id: "notice:" + id, sent_by: a.me.id });
    if (claim?.code === "23505") return json({ alreadySent: true, sent: 0, devices: 0, people: 0 });
    if (claim) throw new Error("could not record the send: " + claim.message);
    const people = (await approvedProfiles()).map((p) => p.user_id).filter((u) => u !== a.me.id);
    const subs = await devicesOf(people, "notices");
    const text = String(n.text || "");
    const r = await sendTo(subs, { title: `Notice from ${String(n.by || nameOf(a))}`, body: text.length > 180 ? text.slice(0, 177) + "…" : text, tag: `notice-${id}`, url: "./?page=home" });
    return json({ ...r, devices: subs.length, people: people.length });
  }

  if (action === "notify") {
    const a = await access(me, "parade");
    const paradeId = String(body.paradeId || "");
    const pd = findParade(a.state, paradeId);
    if (!pd) fail(404, "That parade is not saved yet. Try again in a moment.");
    if (!(Number(pd.reportAt) > Date.now())) return json({ sent: 0, skipped: "past" });
    if (body.again === true && a.who.admin) {
      const { error } = await db.from("cadetflow_push_sent").upsert({ parade_id: paradeId, sent_by: a.me.id, sent_at: new Date().toISOString() }, { onConflict: "parade_id" });
      if (error) throw new Error("could not record the send: " + error.message);
    } else {
      const { error: claim } = await db.from("cadetflow_push_sent").insert({ parade_id: paradeId, sent_by: a.me.id });
      if (claim?.code === "23505") {
        const { data: prev } = await db.from("cadetflow_push_sent").select("sent_at").eq("parade_id", paradeId).maybeSingle();
        return json({ alreadySent: true, sentAt: prev?.sent_at || null });
      }
      if (claim) throw new Error("could not record the send: " + claim.message);
    }
    let people: string[] = [], subs: Sub[] = [], r: { sent: number; failed: number; removed: number };
    try {
      people = paradeRecipients(await approvedProfiles(), cadetsOf(a.state), pd, a.state.leaves || []); // not those on leave
      subs = await devicesOf(people, "parades");
      const lines = [when(Number(pd.reportAt)), pd.venue ? String(pd.venue) : "", pd.dress ? `Turnout: ${String(pd.dress)}` : "", `For: ${audienceText(pd)}`].filter(Boolean);
      r = await sendTo(subs, { title: `New parade: ${String(pd.title || "Parade")}`, body: lines.join(" · "), tag: `parade-${paradeId}`, url: `./?parade=${encodeURIComponent(paradeId)}` });
    } catch (e) {
      if (body.again !== true) await db.from("cadetflow_push_sent").delete().eq("parade_id", paradeId);
      throw e;
    }
    await db.from("cadetflow_push_sent").update({ delivered: r.sent, failed: r.failed }).eq("parade_id", paradeId);
    return json({ ...r, devices: subs.length, people: people.length });
  }

  if (action === "paradeChange" || action === "paradeCancel") {
    const a = await access(me, "parade");
    const paradeId = String(body.paradeId || "");
    const pd = findParade(a.state, paradeId);
    if (!pd) fail(404, "That parade is not saved yet. Try again in a moment.");
    const at = Number(pd.reportAt);
    if (!(at > Date.now())) return json({ sent: 0, skipped: "past" });
    const venue = String(pd.venue || "");
    let h = 0; for (const ch of venue) h = (h * 31 + ch.charCodeAt(0)) | 0; // one send per time and place
    const key = action === "paradeCancel" ? `cancel:${paradeId}` : `change:${paradeId}@${at}:${(h >>> 0).toString(36)}`;
    const { error: claimErr } = await db.from("cadetflow_push_sent").insert({ parade_id: key, sent_by: a.me.id });
    if (claimErr?.code === "23505") return json({ alreadySent: true, sent: 0, devices: 0, people: 0 });
    if (claimErr) throw new Error("could not record the send: " + claimErr.message);
    const title = String(pd.title || "Parade");
    let payload: Obj;
    if (action === "paradeCancel") {
      payload = { title: `Cancelled: ${title}`, body: [when(at), venue, `Cancelled by ${nameOf(a)}`].filter(Boolean).join(" · "), tag: `parade-${paradeId}`, url: "./?page=parades" };
    } else {
      const was = body.was && typeof body.was === "object" ? body.was : {};
      const wasAt = Number(was.reportAt);
      const lines = [`Now ${when(at)}`, venue ? `at ${venue}` : "", Number.isFinite(wasAt) && wasAt > 0 && wasAt !== at ? `was ${when(wasAt)}` : "",
        typeof was.venue === "string" && was.venue.trim() && was.venue.trim() !== venue ? `was at ${was.venue.trim().slice(0, 80)}` : ""];
      payload = { title: `Parade changed: ${title}`, body: lines.filter(Boolean).join(" · "), tag: `parade-${paradeId}`, url: `./?parade=${encodeURIComponent(paradeId)}` };
    }
    let people: string[] = [], subs: Sub[] = [], r: { sent: number; failed: number; removed: number };
    try {
      people = paradeRecipients(await approvedProfiles(), cadetsOf(a.state), pd, a.state.leaves || []).filter((u) => u !== a.me.id);
      subs = await devicesOf(people);
      r = await sendTo(subs, payload);
    } catch (e) {
      await db.from("cadetflow_push_sent").delete().eq("parade_id", key);
      throw e;
    }
    return json({ ...r, devices: subs.length, people: people.length });
  }


  // ---- leave: excuse a cadet from one parade while their leave request still waits
  if (action === "excuse") {
    const a = await access(me, "requests");
    const { data: r, error } = await db.from("cadetflow_requests").select(REQ_COLS).eq("id", String(body.id || "")).maybeSingle();
    if (error) throw new Error("could not read the request: " + error.message);
    if (!r || !isLeaveRequest(r)) fail(404, "That leave request was withdrawn.");
    if (r.status !== "pending") fail(409, "That leave request was already decided.");
    if (r.user_id === a.me.id && !a.who.admin) fail(403, "Another senior has to decide on your own request.");
    if (!requestsFor(a.who, findCadet(a.state, r.cadet_id))) fail(403, SCOPE_DENIED);
    const from = String(r.from_date || "").slice(0, 10), to = String(r.to_date || "").slice(0, 10);
    const decider = nameOf(a);
    let title = "", at = 0;
    const paradeId = String(body.paradeId || "");
    await changeState(a.me.id, (s) => {
      const pd = findParade(s, paradeId);
      if (!pd) fail(404, "That parade was deleted.");
      const day = istDay(Number(pd.reportAt)).date;
      if (day < from || day > to) fail(400, "That parade is not in the days of this leave.");
      const c = findCadet(s, r.cadet_id);
      if (!inParade(c, pd)) fail(400, "This parade is not for that cadet.");
      title = String(pd.title || "Parade"); at = Number(pd.reportAt);
      pd.reports = (Array.isArray(pd.reports) ? pd.reports : []).filter((x: Obj) => x && x.cadetId !== r.cadet_id);
      pd.reports.push({
        id: `rep-leave-${r.id}`, cadetId: r.cadet_id, kind: "absent", reason: `On leave ${from} to ${to}${r.reason ? `: ${r.reason}` : ""}`, informedTo: a.who.cadet ? String(a.who.cadet.id) : "",
        at: Date.parse(r.created_at), by: decider, fromCadet: true, fromLeave: true, requestId: r.id, approvedAt: Date.now(),
      });
      addHistory(s, "parade-report", r.cadet_id, `${c?.name || r.cadet_id}: excused from ${title} by ${decider} (leave ${from} to ${to} still waiting)`);
      return true;
    });
    if (r.user_id) await tell([r.user_id], { title: `Excused: ${title}`, body: `${when(at)} · your leave request is still waiting for a decision`, tag: `request-${r.id}-${paradeId}`, url: `./?parade=${encodeURIComponent(paradeId)}` });
    return json({ ok: true });
  }

  // ---- sign-ups: cadets apply; JUOs, SUOs and the administrator run them on the site
  if (action === "signup") {
    const a = await access(me, null);
    if (!a.who.cadet) fail(400, "Your account is not linked to your name on the roster. Ask the administrator.");
    const cadetId = String(a.who.cadet.id), id = String(body.id || ""), join = body.join !== false;
    await changeState(a.me.id, (s) => {
      const item = (Array.isArray(s.signups) ? s.signups : []).find((x: Obj) => x && x.id === id);
      if (!item) fail(404, "That sign-up was removed.");
      if (!signupOpen(item)) fail(400, "Sign-ups for this have closed.");
      if (!inParade(findCadet(s, cadetId), item)) fail(403, "This sign-up is not open to you.");
      const list: Obj[] = Array.isArray(item.applicants) ? item.applicants : [];
      const mine = list.find((x) => x && x.cadetId === cadetId);
      if (join) {
        if (mine) return false;
        if (list.length >= 500) fail(400, "This sign-up is full.");
        item.applicants = [...list, { id: `ap-${cadetId}`, cadetId, at: Date.now(), status: "applied" }];
      } else {
        if (!mine) return false;
        if (mine.status === "selected") fail(400, "You were already selected. Ask the organiser to take you off.");
        item.applicants = list.filter((x) => x !== mine);
      }
      return true;
    });
    return json({ ok: true });
  }
  if (action === "signupAnnounce" || action === "signupTell") {
    const a = await access(me, "write");
    const id = String(body.id || "");
    const item = (Array.isArray(a.state.signups) ? a.state.signups : []).find((x: Obj) => x && x.id === id);
    if (!item) fail(404, "That sign-up is not saved yet. Try again in a moment.");
    const profiles = await approvedProfiles();
    let people: string[], key: string, payload: Obj;
    if (action === "signupAnnounce") {
      people = paradeRecipients(profiles, cadetsOf(a.state), item).filter((u) => u !== a.me.id);
      key = `signup:${id}`;
      payload = { title: `Sign up: ${String(item.title || "")}`, body: `${item.place ? `${String(item.place).slice(0, 80)} · ` : ""}Apply on CadetFlow by ${when(Number(item.closesAt))}${item.seats ? ` · ${item.seats} vacancies` : ""}`, tag: `signup-${id}`, url: "./?page=home" };
    } else {
      const chosen = (Array.isArray(item.applicants) ? item.applicants : []).filter((x: Obj) => x && x.status === "selected").map((x: Obj) => String(x.cadetId)).sort();
      if (!chosen.length) fail(400, "Nobody is selected yet.");
      people = profiles.filter((p) => p.cadet_id && chosen.includes(String(p.cadet_id))).map((p) => p.user_id);
      let h = 0; for (const ch of chosen.join(",")) h = (h * 31 + ch.charCodeAt(0)) | 0;
      key = `signup-sel:${id}:${(h >>> 0).toString(36)}`;
      payload = { title: `Selected: ${String(item.title || "")}`, body: "You were selected. Watch the notice board for what comes next.", tag: `signup-${id}`, url: "./?page=home" };
    }
    const { error: claimErr } = await db.from("cadetflow_push_sent").insert({ parade_id: key, sent_by: a.me.id });
    if (claimErr?.code === "23505") return json({ alreadySent: true, sent: 0, devices: 0, people: 0 });
    if (claimErr) throw new Error("could not record the send: " + claimErr.message);
    const subs = await devicesOf(people, action === "signupAnnounce" ? "signups" : undefined);
    const r = await sendTo(subs, payload);
    return json({ ...r, devices: subs.length, people: people.length });
  }

  // ---- mess duty swaps: a cadet on duty puts their duty up for anyone to take, or asks one cadet
  // (optionally taking one of their duties in return). Taking it, or agreeing, makes the change at once:
  // both cadets agreed, so no senior needs to approve it.
  // A cadet on duty who cannot do it either finds someone (above) or asks a senior to let them off with a
  // reason (messOut, kind 'out' in the same list); sergeants and above decide it (messOutDecide).
  if (action === "swapAsk" || action === "swapAnswer" || action === "swapWithdraw" || action === "swapTake" || action === "messOut" || action === "messOutDecide") {
    const deciding = action === "messOutDecide";
    const a = await access(me, deciding ? "requests" : null);
    const myId = a.who.cadet ? String(a.who.cadet.id) : "";
    if (!myId && !deciding) fail(400, "Your account is not linked to your name on the roster. Ask the administrator.");
    let tellAdmins = false;
    const today = istDay(Date.now()).date;
    const dayLabel = (d: string) => new Intl.DateTimeFormat("en-IN", { timeZone: IST, weekday: "short", day: "numeric", month: "short" }).format(new Date(`${d}T12:00:00+05:30`));
    let notify: { cadetIds: string[]; title: string; body: string }[] = [];
    let done = "";
    await changeState(a.me.id, (s) => {
      notify = []; done = ""; tellAdmins = false;
      const days: Obj[] = Array.isArray(s.messDuty) ? s.messDuty : [];
      const swaps: Obj[] = Array.isArray(s.messSwaps) ? s.messSwaps : (s.messSwaps = []);
      const name = (id: string) => rankName(findCadet(s, id)) || "A cadet";
      const ids = (d: Obj | null) => (Array.isArray(d?.cadetIds) ? d!.cadetIds : []).map(String);
      const where = (d: Obj) => { const pd = d.paradeId ? findParade(s, d.paradeId) : null; return `${pd ? String(pd.title || "the parade") + ", " : ""}${dayLabel(d.date)}`; };
      const canDo = (id: string, d: Obj) => messCanDo(findCadet(s, id), d.paradeId ? findParade(s, d.paradeId) : null, d.date, s.messConfig, s.leaves);
      const live = (x: Obj) => x && (x.status === "open" || x.status === "asked");
      const tidy = () => { s.messSwaps = swaps.filter((x) => x && (live(x) || Number(x.answeredAt || x.decidedAt || x.at) > Date.now() - 30 * 86400000)); };
      /** Give `from`'s duty on day d to `to` (and, for a two-way swap, `to`'s duty on t to `from`). */
      const apply = (sw: Obj, to: string) => {
        const d = days.find((x) => x && x.id === sw.dayId) || null;
        if (!d || d.date < today || !ids(d).includes(String(sw.from))) fail(409, "That mess duty changed meanwhile, so this swap no longer fits.");
        if (ids(d).includes(to)) fail(409, `${to === myId ? "You are" : "They are"} already on that mess duty.`);
        if (!canDo(to, d!)) fail(400, to === myId ? "You cannot take this duty: mess duty is only for cadets (no rank holders, no locals) who are expected at that parade and not on leave." : "They can no longer take this duty.");
        let t: Obj | null = null;
        if (sw.takeDayId) {
          t = days.find((x) => x && x.id === sw.takeDayId) || null;
          if (!t || t.date < today || !ids(t).includes(to) || ids(t).includes(String(sw.from))) fail(409, "Mess duty on the other day changed meanwhile, so this swap no longer fits.");
        }
        // Whoever takes a duty chose it: they count as a volunteer; the one who gave it away does not.
        const vol = (x: Obj, out: string, inn: string) => { x.volunteers = [...(Array.isArray(x.volunteers) ? x.volunteers : []).map(String).filter((v: string) => v !== out), inn]; };
        d!.cadetIds = d!.cadetIds.map((x: unknown) => String(x) === String(sw.from) ? to : x);
        vol(d!, String(sw.from), to);
        if (t) {
          t.cadetIds = t.cadetIds.map((x: unknown) => String(x) === to ? sw.from : x);
          vol(t, to, String(sw.from));
        }
        sw.to = to; sw.status = "done"; sw.answeredAt = Date.now();
        // Other requests about the same duty are settled by this one.
        for (const x of swaps) if (x !== sw && live(x) && ((x.dayId === d!.id && x.from === sw.from) || (t && x.dayId === t.id && x.from === to))) { x.status = "withdrawn"; x.answeredAt = Date.now(); }
        addHistory(s, "mess-swapped", null, `Mess duty ${where(d!)}: ${name(to)} took it from ${name(String(sw.from))}${t ? `, who took ${name(to)}'s on ${dayLabel(t.date)}` : ""}`);
        return t;
      };
      if (action === "swapAsk") {
        const d = days.find((x) => x && x.id === String(body.dayId || ""));
        if (!d || d.date < today) fail(404, "That mess duty is over or was removed.");
        if (!ids(d!).includes(myId)) fail(400, "You are not on that mess duty.");
        if (swaps.some((x) => live(x) && x.dayId === d!.id && x.from === myId)) fail(409, "You already asked about that duty. Withdraw it first.");
        const to = String(body.to || "");
        if (!to) {
          swaps.push({ id: rid("swap"), dayId: d!.id, date: d!.date, from: myId, to: null, status: "open", at: Date.now() });
          return true;
        }
        const other = findCadet(s, to);
        if (!other || to === myId) fail(400, "Pick another cadet.");
        if (ids(d!).includes(to)) fail(400, "They are already on that mess duty.");
        if (!canDo(to, d!)) fail(400, "Mess duty is only for cadets (no rank holders, no locals) who are expected at that parade and not on leave. Pick someone else.");
        let t: Obj | null = null;
        if (body.takeDayId) {
          t = days.find((x) => x && x.id === String(body.takeDayId)) || null;
          if (!t || t.date < today || !ids(t).includes(to)) fail(400, "They are not on that other mess duty.");
          if (ids(t).includes(myId)) fail(400, "You are already on that other mess duty.");
          if (!canDo(myId, t)) fail(400, "You cannot do that other duty (you are not expected at that parade, or on leave).");
        }
        swaps.push({ id: rid("swap"), dayId: d!.id, date: d!.date, from: myId, to, ...(t ? { takeDayId: t.id, takeDate: t.date } : {}), status: "asked", at: Date.now() });
        notify.push({ cadetIds: [to], title: "Mess duty swap", body: `${name(myId)} asks you to take their mess duty at ${where(d!)}${t ? `, and they take yours on ${dayLabel(t.date)}` : ""}. Answer on the Parades page.` });
        return true;
      }
      if (action === "messOut") {
        const d = days.find((x) => x && x.id === String(body.dayId || ""));
        const pd = d && d.paradeId ? findParade(s, d.paradeId) : null;
        if (!d || d.date < today || (pd && Number(pd.reportAt) <= Date.now())) fail(404, "That mess duty is over or was removed.");
        if (!ids(d!).includes(myId)) fail(400, "You are not on that mess duty.");
        if (swaps.some((x) => live(x) && x.dayId === d!.id && x.from === myId)) fail(409, "You already asked about that duty. Withdraw it first.");
        const reason = String(body.reason || "").replace(/\s+/g, " ").trim().slice(0, 300);
        if (reason.length < 3) fail(400, "Write why you cannot do it.");
        swaps.push({ id: rid("swap"), kind: "out", dayId: d!.id, date: d!.date, from: myId, to: null, reason, status: "asked", at: Date.now() });
        // Sergeants and above expected at that parade (all of them if none); the administrator when there are none.
        const seniors = cadetsOf(s).filter((c) => requestsFor({ admin: false, rank: String(c.rank || "").toUpperCase(), cadet: c }, findCadet(s, myId)));
        const there = pd ? seniors.filter((c) => inParade(c, pd)) : [];
        const to = (there.length ? there : seniors).map((c) => String(c.id));
        if (!to.length) tellAdmins = true;
        notify.push({ cadetIds: to, title: "Mess duty: asks to be let off", body: `${name(myId)}, ${where(d!)}: ${reason}. Decide on the Parades page.` });
        addHistory(s, "mess-out-asked", myId, `${name(myId)} asked to be let off mess duty at ${where(d!)}: ${reason}`);
        return true;
      }
      const sw = swaps.find((x) => x && x.id === String(body.id || ""));
      if (!sw) fail(404, "That request was removed.");
      if (deciding) {
        if (sw!.kind !== "out") fail(400, "That is a swap between cadets: they settle it themselves.");
        if (!requestsFor(a.who, findCadet(s, sw!.from))) fail(403, SCOPE_DENIED);
        if (sw!.status !== "asked") fail(409, "That request was already decided or withdrawn.");
        const d = days.find((x) => x && x.id === sw!.dayId) || null;
        sw!.decidedBy = nameOf(a); sw!.answeredAt = Date.now();
        if (body.approve !== true) {
          sw!.status = "refused";
          notify.push({ cadetIds: [String(sw!.from)], title: "Mess duty: stay on it", body: `${nameOf(a)} did not let you off mess duty at ${d ? where(d) : dayLabel(sw!.date)}. You can still ask a cadet to take your place.` });
          addHistory(s, "mess-out-refused", String(sw!.from), `${nameOf(a)} kept ${name(String(sw!.from))} on mess duty at ${d ? where(d) : dayLabel(sw!.date)}`);
          tidy();
          return true;
        }
        if (!d || d.date < today || !ids(d).includes(String(sw!.from))) fail(409, "That mess duty changed meanwhile, so there is nothing to let them off.");
        d!.cadetIds = d!.cadetIds.filter((x: unknown) => String(x) !== String(sw!.from));
        if (Array.isArray(d!.volunteers)) d!.volunteers = d!.volunteers.filter((x: unknown) => String(x) !== String(sw!.from));
        sw!.status = "approved";
        for (const x of swaps) if (x !== sw && live(x) && x.dayId === d!.id && x.from === sw!.from) { x.status = "withdrawn"; x.answeredAt = Date.now(); }
        notify.push({ cadetIds: [String(sw!.from)], title: "Mess duty: you are off it", body: `${nameOf(a)} let you off mess duty at ${where(d!)}.` });
        // The call to the lance corporals has gone already: tell them a place opened again.
        if (d!.asked && d!.asked.leads) {
          const pd = d!.paradeId ? findParade(s, d!.paradeId) : null;
          const leads = cadetsOf(s).filter((c) => messLeadRank(c)), there = pd ? leads.filter((c) => inParade(c, pd)) : [];
          notify.push({ cadetIds: (there.length ? there : leads).map((c) => String(c.id)), title: "Pick mess duty", body: `${name(String(sw!.from))} was let off mess duty at ${where(d!)}. Pick someone on the Parades page.` });
        }
        addHistory(s, "mess-out-approved", String(sw!.from), `${nameOf(a)} let ${name(String(sw!.from))} off mess duty at ${where(d!)}`);
        done = "off";
        tidy();
        return true;
      }
      if (sw!.kind === "out" && action !== "swapWithdraw") fail(400, "That request is for a senior to decide.");
      if (action === "swapTake") {
        if (sw!.status !== "open") fail(409, sw!.status === "done" ? "Someone already took it." : "That request was withdrawn.");
        if (sw!.from === myId) fail(400, "That is your own duty.");
        const d = days.find((x) => x && x.id === sw!.dayId);
        apply(sw!, myId);
        notify.push({ cadetIds: [String(sw!.from)], title: "Mess duty taken", body: `${name(myId)} takes your mess duty at ${d ? where(d) : dayLabel(sw!.date)}. You are off it.` });
        done = "taken";
        tidy();
        return true;
      }
      if (action === "swapAnswer") {
        if (sw!.to !== myId) fail(403, "That request is for someone else.");
        if (sw!.status !== "asked") fail(409, "That request was already answered.");
        if (body.accept === true) {
          const t = apply(sw!, myId);
          notify.push({ cadetIds: [String(sw!.from)], title: "Mess duty swap done", body: `${name(myId)} agreed: they do ${dayLabel(sw!.date)}${t ? `, you do ${dayLabel(t.date)}` : ""}.` });
          done = "swapped";
        } else {
          sw!.status = "declined"; sw!.answeredAt = Date.now();
          notify.push({ cadetIds: [String(sw!.from)], title: "Mess duty swap", body: `${name(myId)} said no. Your duty on ${dayLabel(sw!.date)} stays.` });
        }
        tidy();
        return true;
      }
      // swapWithdraw
      if (sw!.from !== myId) fail(403, "That request is someone else's.");
      if (!live(sw!)) fail(409, "That request was already answered.");
      sw!.status = "withdrawn"; sw!.answeredAt = Date.now();
      tidy();
      return true;
    });
    if (notify.length) {
      const profiles = await approvedProfiles();
      for (const n of notify) await tell(profiles.filter((p) => p.cadet_id && n.cadetIds.includes(String(p.cadet_id))).map((p) => p.user_id), { title: n.title, body: n.body, tag: "mess-swap", url: "./?page=parades" });
      if (tellAdmins && notify[0]) await tell(profiles.filter((p) => p.role === "admin").map((p) => p.user_id), { title: notify[0].title, body: notify[0].body, tag: "mess-swap", url: "./?page=parades" });
    }
    return json({ ok: true, ...(done ? { done } : {}) });
  }

  // ---- mess duty volunteers: { paradeId } to volunteer, only while there are places left. Getting off it
  // again goes through a senior (messOut) or another cadet who agrees to take the place (swapAsk).
  if (action === "messVolunteer") {
    const a = await access(me, null);
    const myId = a.who.cadet ? String(a.who.cadet.id) : "";
    if (!myId) fail(400, "Your account is not linked to your name on the roster. Ask the administrator.");
    const undo = body.undo === true;
    await changeState(a.me.id, (s) => {
      const pd = findParade(s, String(body.paradeId || ""));
      if (!pd || Number(pd.reportAt) <= Date.now()) fail(404, "That parade is over or was removed.");
      if (!hasRefreshments(pd, s.messDuty)) fail(400, "There are no refreshments at that parade.");
      if (!Array.isArray(s.messDuty)) s.messDuty = [];
      const date = istDay(Number(pd.reportAt)).date;
      let d = s.messDuty.find((x: Obj) => x && x.paradeId === pd.id);
      const ids = () => (Array.isArray(d?.cadetIds) ? d!.cadetIds : []).map(String);
      if (undo) fail(400, "To get off mess duty, ask a senior with a reason, or ask a cadet to take your place.");
      if (!messCanDo(a.who.cadet, pd, date, s.messConfig, s.leaves)) fail(400, "Mess duty is only for cadets (no rank holders, no locals) who are expected at that parade and not on leave.");
      if ((Array.isArray(pd.reports) ? pd.reports : []).some((r: Obj) => r && String(r.cadetId) === myId && r.kind === "absent")) fail(400, "You are excused from that parade.");
      if (d && ids().includes(myId)) fail(409, "You are already on it.");
      const per = messPerDay(s.messConfig);
      if (d && ids().length >= per) fail(409, `It is full: ${per} cadets are already on it.`);
      if (!d) { d = { id: `mess-${pd.id}`, paradeId: pd.id, date, cadetIds: [], volunteers: [], at: Date.now(), by: nameOf(a) }; s.messDuty.push(d); }
      d.cadetIds = [...(Array.isArray(d.cadetIds) ? d.cadetIds : []), myId];
      d.volunteers = [...(Array.isArray(d.volunteers) ? d.volunteers : []), myId];
      addHistory(s, "mess-volunteer", myId, `${nameOf(a)} volunteered for mess duty at ${String(pd.title || "the parade")} (${date})`);
      return true;
    });
    return json({ ok: true });
  }

  // ---- mess duty: { on } puts the caller on (or off) the advance volunteers list: asked first when a parade
  // gets refreshments. messCall { paradeId } makes the call that is due now for that parade (the site asks right
  // after refreshments are turned on, so the advance volunteers hear at once; the reminders job does the rest).
  if (action === "messStandby") {
    const a = await access(me, null);
    const c = a.who.cadet;
    if (!c) fail(400, "Your account is not linked to your name on the roster. Ask the administrator.");
    const on = body.on !== false, myId = String(c.id);
    await changeState(a.me.id, (s) => {
      const list: Obj[] = Array.isArray(s.messStandby) ? s.messStandby : (s.messStandby = []);
      const has = list.some((x) => x && String(x.cadetId) === myId);
      if (on) {
        if (has) return false;
        if (!messCanDo(c, null, "", s.messConfig, [])) fail(400, "Mess duty is only for cadets (no rank holders, no locals) from the years on the mess duty list.");
        list.push({ id: `sb-${myId}`, cadetId: myId, at: Date.now() });
        addHistory(s, "mess-standby", myId, `${nameOf(a)} offered to do mess duty`);
      } else {
        if (!has) return false;
        s.messStandby = list.filter((x) => x && String(x.cadetId) !== myId);
        addHistory(s, "mess-standby", myId, `${nameOf(a)} is off the mess duty volunteers list`);
      }
      return true;
    });
    return json({ ok: true, on });
  }
  if (action === "messCall") {
    await access(me, "write");
    return json({ ok: true, calls: await runMessCalls(String(body.paradeId || "") || null) });
  }

  // ---- study library: links only (files stay on Google Drive, YouTube or a website)
  if (action === "suggestLink") {
    const a = await access(me, null);
    const url = cleanLink(body.url);
    if (!url) fail(400, "Paste a full link starting with https://");
    const title = String(body.title || "").trim().replace(/\s+/g, " ").slice(0, 120);
    if (title.length < 3) fail(400, "Write what the link is.");
    const subject = String(body.subject || "").trim().replace(/\s+/g, " ").slice(0, 60) || "General";
    const cert = ["B", "C", "both"].includes(body.cert) ? body.cert : "";
    const by = nameOf(a);
    await changeState(a.me.id, (s) => {
      const lib: Obj[] = Array.isArray(s.library) ? s.library : (s.library = []);
      if (lib.filter((x) => x && x.status === "suggested" && x.by === by).length >= 5) fail(429, "You already have 5 links waiting. Wait until a senior looks at them.");
      if (lib.some((x) => x && x.url === url)) fail(409, "That link is already in the library or waiting.");
      lib.push({ id: rid("lib"), title, url, subject, ...(cert ? { cert } : {}), status: "suggested", by, ...(a.who.cadet ? { byCadet: String(a.who.cadet.id) } : {}), at: Date.now() });
      return true;
    });
    return json({ ok: true });
  }

  // ---- suggestion box (the administrator reads them). Anonymous ones keep no account or name.
  if (action === "suggest") {
    const a = await access(me, null);
    const text = String(body.text || "").trim().slice(0, 1500);
    if (text.length < 5) fail(400, "Write your suggestion.");
    const anonymous = body.anonymous === true;
    const since = new Date(Date.now() - 86400000).toISOString();
    if (anonymous) {
      const { count } = await db.from("cadetflow_suggestions").select("id", { count: "exact", head: true }).is("user_id", null).gte("created_at", since);
      if ((count || 0) >= 30) fail(429, "Too many suggestions today. Try again tomorrow.");
    } else {
      const { count } = await db.from("cadetflow_suggestions").select("id", { count: "exact", head: true }).eq("user_id", a.me.id).gte("created_at", since);
      if ((count || 0) >= 5) fail(429, "You sent 5 suggestions today. Try again tomorrow.");
    }
    const { error } = await db.from("cadetflow_suggestions").insert({
      id: crypto.randomUUID(), text, created_at: new Date().toISOString(), status: "new",
      ...(anonymous ? { user_id: null, name: null, cadet_id: null } : { user_id: a.me.id, name: nameOf(a), cadet_id: a.who.cadet ? String(a.who.cadet.id) : null }),
    });
    if (error) throw new Error("could not save it: " + error.message);
    await tell(await adminPeople(), { title: "New suggestion", body: text.length > 120 ? text.slice(0, 117) + "…" : text, tag: "suggestions", url: "./?page=home" });
    return json({ ok: true });
  }
  if (action === "mySuggestions") {
    const a = await access(me, null);
    const { data, error } = await db.from("cadetflow_suggestions").select("id, text, created_at, status, reply, replied_at, replied_by_name").eq("user_id", a.me.id).order("created_at", { ascending: false }).limit(20);
    if (error) throw new Error("could not read them: " + error.message);
    return json({ suggestions: (data || []).map((x) => ({ id: x.id, text: x.text, at: Date.parse(x.created_at), status: x.status, reply: x.reply || "", repliedAt: x.replied_at ? Date.parse(x.replied_at) : null, repliedBy: x.replied_by_name || "" })) });
  }

  // ---- practice questions (B and C certificates)
  if (action === "quizBank") {
    await access(me, null);
    const { data, error } = await db.from("cadetflow_quiz").select("id, cert, subject, question, options, answer, explain").order("created_at", { ascending: true }).limit(5000);
    if (error) throw new Error("could not read the questions: " + error.message);
    return json({ questions: data || [] });
  }
  if (action === "quizSave" || action === "quizImport" || action === "quizDelete") {
    const a = await access(me, "requests");
    if (action === "quizDelete") {
      const { error } = await db.from("cadetflow_quiz").delete().eq("id", String(body.id || ""));
      if (error) throw new Error("could not remove it: " + error.message);
      return json({ ok: true });
    }
    const rows = action === "quizSave" ? [body.question] : (Array.isArray(body.rows) ? body.rows : []).slice(0, 1000);
    const good: Obj[] = [], bad: { row: number; error: string }[] = [];
    rows.forEach((x: Obj, i: number) => { const r = cleanQuestion(x); if (r.error) bad.push({ row: i + 1, error: r.error }); else good.push(r.q); });
    if (action === "quizSave") {
      if (bad.length) fail(400, bad[0].error);
      const id = String(body.question?.id || "");
      const row = { ...good[0], updated_at: new Date().toISOString() };
      const { error } = id
        ? await db.from("cadetflow_quiz").update(row).eq("id", id)
        : await db.from("cadetflow_quiz").insert({ id: crypto.randomUUID(), ...row, created_at: new Date().toISOString(), created_by: a.me.id });
      if (error) throw new Error("could not save it: " + error.message);
      return json({ ok: true });
    }
    if (good.length) {
      const at = Date.now();
      const { error } = await db.from("cadetflow_quiz").insert(good.map((q, i) => ({ id: crypto.randomUUID(), ...q, created_at: new Date(at + i).toISOString(), updated_at: new Date(at).toISOString(), created_by: a.me.id })));
      if (error) throw new Error("could not save them: " + error.message);
    }
    return json({ added: good.length, skipped: bad.slice(0, 20), skippedCount: bad.length });
  }
  if (action === "quizScore") {
    const a = await access(me, null);
    const total = Math.round(Number(body.total)), score = Math.round(Number(body.score));
    if (!(total >= 1 && total <= 100) || !(score >= 0 && score <= total)) fail(400, "That score does not add up.");
    const since = new Date(Date.now() - 86400000).toISOString();
    const { count } = await db.from("cadetflow_quiz_scores").select("id", { count: "exact", head: true }).eq("user_id", a.me.id).gte("taken_at", since);
    if ((count || 0) >= 100) return json({ ok: true, kept: false });
    const { error } = await db.from("cadetflow_quiz_scores").insert({
      id: crypto.randomUUID(), user_id: a.me.id, cadet_id: a.who.cadet ? String(a.who.cadet.id) : null, cert: ["B", "C"].includes(body.cert) ? body.cert : "B",
      subject: String(body.subject || "All subjects").slice(0, 60), score, total, taken_at: new Date().toISOString(),
    });
    if (error) throw new Error("could not save the score: " + error.message);
    return json({ ok: true, kept: true });
  }
  if (action === "quizScores") {
    const a = await access(me, null);
    const { data: mine, error } = await db.from("cadetflow_quiz_scores").select("cert, subject, score, total, taken_at").eq("user_id", a.me.id).order("taken_at", { ascending: false }).limit(30);
    if (error) throw new Error("could not read the scores: " + error.message);
    const out: Obj = { mine: (mine || []).map((x) => ({ cert: x.cert, subject: x.subject, score: x.score, total: x.total, at: Date.parse(x.taken_at) })) };
    if (can(a.who, "requests")) {
      const since = new Date(Date.now() - 120 * 86400000).toISOString();
      const { data: all } = await db.from("cadetflow_quiz_scores").select("cadet_id, score, total, taken_at").gte("taken_at", since).limit(20000);
      const by = new Map<string, Obj>();
      for (const x of all || []) {
        if (!x.cadet_id) continue;
        const t = by.get(x.cadet_id) || { cadetId: x.cadet_id, tries: 0, right: 0, asked: 0, last: 0 };
        t.tries++; t.right += x.score; t.asked += x.total; t.last = Math.max(t.last, Date.parse(x.taken_at));
        by.set(x.cadet_id, t);
      }
      out.everyone = [...by.values()].map((t) => ({ cadetId: t.cadetId, tries: t.tries, pct: t.asked ? Math.round(t.right / t.asked * 100) : 0, last: t.last }));
    }
    return json(out);
  }

  // ---- uniform: cadets' own items, payment
  if (action === "payInfo") {
    await access(me, null);
    const { data } = await db.from("cadetflow_settings").select("value").eq("key", "payment").maybeSingle();
    const v = (data?.value || {}) as Obj;
    return json({ upi: v.upi || "", payee: v.payee || "", note: v.note || "", qrUrl: v.qr ? await signed(v.qr).catch(() => "") : "" });
  }

  if (action === "setPayInfo") {
    const a = await access(me, "uniform");
    const { data } = await db.from("cadetflow_settings").select("value").eq("key", "payment").maybeSingle();
    const old = (data?.value || {}) as Obj;
    const value: Obj = { upi: String(body.upi || "").trim().slice(0, 100), payee: String(body.payee || "").trim().slice(0, 100), note: String(body.note || "").trim().slice(0, 300), qr: old.qr || null };
    if (body.image) { value.qr = await saveImage(`settings/payment-qr-${Date.now().toString(36)}`, body.image); await removeFiles([old.qr]); }
    else if (body.removeQr) { await removeFiles([old.qr]); value.qr = null; }
    const { error } = await db.from("cadetflow_settings").upsert({ key: "payment", value, updated_at: new Date().toISOString(), updated_by: a.me.id }, { onConflict: "key" });
    if (error) throw new Error("could not save: " + error.message);
    return json({ ok: true });
  }

  if (action === "uniformRequest") {
    const a = await access(me, null);
    if (!a.who.cadet) fail(400, "Your account is not linked to your name on the roster. Ask the administrator.");
    const cadetId = String(a.who.cadet.id);
    const qty = Math.min(20, Math.max(1, parseInt(String(body.qty || 1), 10) || 1));
    const note = String(body.note || "").trim().slice(0, 80);
    const wanted = (Array.isArray(body.items) ? body.items : []).slice(0, 12).map((x: Obj) => {
      const def = UNIFORM_ITEMS.find((i: Obj) => i.key === x?.item);
      if (!def) fail(400, "Unknown item.");
      const out: Obj = { item: def.key };
      if (def.key === "custom") { out.custom = String(x.custom || "").trim().slice(0, 60); if (!out.custom) fail(400, "Write what the other item is."); }
      if (def.sized) { out.size = String(x.size || "").trim().slice(0, 12); if (!out.size) fail(400, "Enter your beret size."); }
      return out;
    });
    if (!wanted.length) fail(400, "Pick at least one item.");
    let added: Obj[] = [], skipped = 0;
    await changeState(a.me.id, (s) => {
      added = []; skipped = 0;
      if (!Array.isArray(s.uniform)) s.uniform = [];
      const now = Date.now(), by = nameOf(a);
      for (const w of wanted) {
        if (uniformOf(s).some((r) => r.cadetId === cadetId && r.status !== "received" && uniformKeyOf(r) === uniformKeyOf(w))) { skipped++; continue; }
        const r = { id: rid("uni"), cadetId, ...w, qty, ...(note ? { note } : {}), status: "requested", requestedAt: now, requestedBy: by, self: true };
        s.uniform.unshift(r);
        added.push(r);
      }
      if (added.length) addHistory(s, "uniform-requested", cadetId, `Uniform request by ${by}: ${added.map(uniformLabelOf).join(", ")}`);
      return added.length > 0;
    });
    if (added.length) {
      await tell(await cqmsPeople(a.state), { title: "Uniform request", body: `${rankName(a.who.cadet)}: ${added.map((r) => uniformLabelOf(r) + (r.qty > 1 ? ` x${r.qty}` : "")).join(", ")}`, tag: "uniform", url: "./?page=uniform" });
    }
    return json({ added: added.length, skipped });
  }

  if (action === "uniformCancel" || action === "uniformReceived") {
    const a = await access(me, null);
    const id = String(body.id || "");
    let label = "";
    const state = await changeState(a.me.id, (s) => {
      const r = uniformOf(s).find((x) => x.id === id);
      if (!r) fail(404, "That request no longer exists.");
      const own = a.who.cadet && r.cadetId === String(a.who.cadet.id);
      if (!own && !can(a.who, "uniform")) fail(403, "That is not your request.");
      label = uniformLabelOf(r);
      if (action === "uniformCancel") {
        if (r.status !== "requested") fail(400, "CQMS has already placed the order for this item.");
        if (r.pay?.status === "approved") fail(400, "This item is already paid. Ask CQMS.");
        s.uniform = uniformOf(s).filter((x) => x.id !== id);
        addHistory(s, "uniform-deleted", r.cadetId, `Uniform request withdrawn: ${label}`);
      } else {
        const block = uniformReceiveBlock(r, s.uniformPrices || []);
        if (block) fail(400, block);
        r.status = "received"; r.receivedAt = Date.now(); r.receivedBy = nameOf(a);
        addHistory(s, "uniform-received", r.cadetId, `Uniform received: ${label} (${nameOf(a)})`);
      }
      return true;
    });
    if (action === "uniformReceived") await cleanup(state, a.me.id, true);
    return json({ ok: true });
  }

  if (action === "uniformPay") {
    const a = await access(me, null);
    if (!a.who.cadet) fail(400, "Your account is not linked to your name on the roster. Ask the administrator.");
    const cadetId = String(a.who.cadet.id);
    const ids: string[] = (Array.isArray(body.ids) ? body.ids : []).map(String);
    const mine = uniformOf(a.state).filter((r) => ids.includes(r.id) && r.cadetId === cadetId);
    if (!mine.length) fail(400, "Pick what this payment is for.");
    if (mine.some((r) => r.status === "received" || r.pay?.status === "approved" || r.paid === true)) fail(400, "Some of those items are already paid.");
    const proofId = rid("pay");
    const file = await saveImage(`pay/${proofId}`, body.image);
    const old = new Set<string>();
    let amount = 0;
    try {
      await changeState(a.me.id, (s) => {
        amount = 0;
        const list = uniformOf(s).filter((r) => ids.includes(r.id) && r.cadetId === cadetId && r.status !== "received" && r.pay?.status !== "approved");
        if (!list.length) fail(400, "Those items changed meanwhile. Try again.");
        for (const r of list) {
          if (r.pay?.file) old.add(r.pay.file);
          const unit = uniformUnitOf(r, s.uniformPrices || []);
          if (unit != null) amount += unit * (r.qty || 1);
          r.pay = { status: "submitted", proofId, file, at: Date.now(), by: nameOf(a) };
        }
        addHistory(s, "uniform-paid", cadetId, `Payment screenshot sent by ${nameOf(a)} for ${list.map(uniformLabelOf).join(", ")}`);
        return true;
      });
    } catch (e) { await removeFiles([file]); throw e; }
    // An earlier screenshot is replaced only when none of its other items still use it.
    const still = new Set(uniformOf((await readState()).state).map((r) => r.pay?.file).filter(Boolean));
    await removeFiles([...old].filter((f) => !still.has(f)));
    await tell(await cqmsPeople(a.state), { title: "Payment to check", body: `${rankName(a.who.cadet)} paid${amount ? " " + rupees(amount) : ""} for ${mine.map(uniformLabelOf).join(", ")}`, tag: "uniform-pay", url: "./?page=uniform" });
    return json({ ok: true, proofId });
  }

  if (action === "payDecide") {
    const a = await access(me, "uniform");
    const proofId = String(body.proofId || "");
    const ok = body.ok === true;
    const note = String(body.note || "").trim().slice(0, 200);
    let list: Obj[] = [];
    const state = await changeState(a.me.id, (s) => {
      list = uniformOf(s).filter((r) => r.pay?.proofId === proofId);
      if (!list.length) fail(404, "That payment no longer exists.");
      const at = Date.now();
      for (const r of list) {
        r.pay = { ...r.pay, status: ok ? "approved" : "rejected", decidedAt: at, decidedBy: nameOf(a), ...(ok ? { approvedAt: at, approvedBy: nameOf(a) } : {}), ...(note ? { note } : {}) };
        if (!ok) { delete r.pay.approvedAt; delete r.pay.approvedBy; }
      }
      addHistory(s, "uniform-paid", list[0].cadetId, `Payment ${ok ? "approved" : "not accepted"} by ${nameOf(a)}: ${list.map(uniformLabelOf).join(", ")}${note ? ` (${note})` : ""}`);
      return true;
    });
    const owners = (await approvedProfiles()).filter((p) => String(p.cadet_id || "") === String(list[0].cadetId)).map((p) => p.user_id);
    const ready = list.filter((r) => r.status === "arrived").length;
    await tell(owners, ok
      ? { title: "Payment approved", body: `${list.map(uniformLabelOf).join(", ")}${ready ? " · ready to collect from CQMS" : " · you can collect it once the order arrives"}`, tag: "uniform-pay", url: "./?page=uniform" }
      : { title: "Payment not accepted", body: `${list.map(uniformLabelOf).join(", ")}${note ? ` · ${note}` : ""} · send the screenshot again`, tag: "uniform-pay", url: "./?page=uniform" });
    if (ok) await cleanup(state, a.me.id, true);
    return json({ ok: true });
  }

  if (action === "payImage") {
    const a = await access(me, null);
    const r = uniformOf(a.state).find((x) => x.pay?.proofId === String(body.proofId || "") && x.pay.file);
    if (!r) fail(404, "The screenshot was already deleted.");
    const own = a.who.cadet && r.cadetId === String(a.who.cadet.id);
    if (!own && !can(a.who, "uniform")) fail(403, DENIED.uniform);
    return json({ url: await signed(r.pay.file) });
  }

  // Administrator ---------------------------------------------------------------------------------------
  if (action === "accounts") {
    const a = await access(me, "admin");
    const [{ data: profiles, error }, users, { data: subs }] = await Promise.all([db.from("cadetflow_profiles").select("*"), allUsers(), db.from("cadetflow_push_subscriptions").select("user_id")]);
    if (error) throw new Error("could not read accounts: " + error.message);
    const devices = new Map<string, number>();
    (subs || []).forEach((s: Obj) => { if (s.user_id) devices.set(s.user_id, (devices.get(s.user_id) || 0) + 1); });
    const byId = new Map((profiles || []).map((p) => [p.user_id, p]));
    // Keep emails on the profiles so "Forgot password" can find people quickly.
    const missing = users.filter((u) => u.email && byId.has(u.id) && !byId.get(u.id).email);
    await Promise.all(missing.map((u) => db.from("cadetflow_profiles").update({ email: u.email.toLowerCase() }).eq("user_id", u.id)));
    const accounts = users.map((u) => {
      const p = byId.get(u.id);
      return {
        userId: u.id, email: u.email || "", name: p?.display_name || "", role: p?.role === "admin" ? "admin" : "viewer", status: p ? p.status : "none",
        cadetId: p?.cadet_id || null, regNo: p?.regimental_no || "", requestedAt: p?.requested_at || null, decidedAt: p?.decided_at || null,
        invitedAt: p?.invited_at || null, resetAsked: p?.reset_requested_at || null, passwordSet: !!u.last_sign_in_at || !!u.email_confirmed_at && !p?.invited_at,
        lastSignIn: u.last_sign_in_at || null, createdAt: u.created_at, you: u.id === a.me.id, devices: devices.get(u.id) || 0,
      };
    });
    return json({ accounts });
  }

  // ---- System check for the administrator: is the scheduled job running, how big is the data, who is waiting,
  // and the problems pages ran into (table cadetflow_errors).
  if (action === "health") {
    await access(me, "admin");
    const { state, updatedAt } = await readState();
    const [rem, profs, subs, reqs, backs, sugg, errs] = await Promise.all([
      db.from("cadetflow_settings").select("value").eq("key", "remind").maybeSingle(),
      db.from("cadetflow_profiles").select("user_id, status, role, cadet_id"),
      db.from("cadetflow_push_subscriptions").select("user_id"),
      db.from("cadetflow_requests").select("id", { count: "exact", head: true }).eq("status", "pending"),
      db.from("cadetflow_backups").select("taken_at, kind").order("taken_at", { ascending: false }).limit(50),
      db.from("cadetflow_suggestions").select("id", { count: "exact", head: true }).eq("status", "new"),
      db.from("cadetflow_errors").select("id, message, place, agent, page, count, first_at, last_at, name").order("last_at", { ascending: false }).limit(50),
    ]);
    const people = (profs.data || []) as Obj[], approved = people.filter((p) => p.status === "approved");
    const withDevice = new Set(((subs.data || []) as Obj[]).map((x) => x.user_id).filter(Boolean));
    const list = (k: string) => (Array.isArray(state[k]) ? state[k].length : 0);
    const copies = ((backs.data || []) as Obj[]).filter((b) => b.kind !== "archive");
    return json({
      build: BUILD,
      remind: (rem.data?.value as Obj) || null,
      state: { size: JSON.stringify(state).length, updatedAt, cadets: cadetsOf(state).length, parades: list("parades"), history: list("history"), tasks: list("events") },
      accounts: { approved: approved.length, waiting: people.filter((p) => p.status === "pending").length, admins: approved.filter((p) => p.role === "admin").length,
        unlinked: approved.filter((p) => !p.cadet_id).length, devices: (subs.data || []).length, withDevice: approved.filter((p) => withDevice.has(p.user_id)).length },
      waiting: { requests: reqs.count || 0, suggestions: sugg.count || 0 },
      backups: { last: copies[0]?.taken_at || null },
      errors: ((errs.data || []) as Obj[]).map((e) => ({ id: e.id, message: e.message, place: e.place || "", agent: e.agent || "", page: e.page || "", count: e.count || 1, first: Date.parse(e.first_at), last: Date.parse(e.last_at), name: e.name || "" })),
    });
  }
  if (action === "errorsClear") {
    await access(me, "admin");
    const { error } = await db.from("cadetflow_errors").delete().lt("first_at", new Date(Date.now() + 86400000).toISOString());
    if (error) throw new Error("could not clear them: " + error.message);
    return json({ ok: true });
  }

  // ---- Archive (administrator): parades, finished tasks, mess duty, leave and activity from before a date leave the
  // shared data (so every page stays quick); a full copy of the data as it was is kept as an "archive" backup that is
  // never deleted, and can be restored from Backups.
  if (action === "archive") {
    const a = await access(me, "admin");
    const before = String(body.before || "");
    if (!/^\d{4}-\d\d-\d\d$/.test(before) || !Number.isFinite(Date.parse(before))) fail(400, "Pick the date: records from before it are archived.");
    const cut = Date.parse(`${before}T00:00:00+05:30`);
    if (cut > Date.now() - 30 * 86400000) fail(400, "Pick a date at least a month ago.");
    const { state: was } = await readState();
    const { error: bErr } = await db.from("cadetflow_backups").insert({ kind: "archive", state: was, taken_at: new Date().toISOString(), taken_by: a.me.id,
      size: JSON.stringify(was).length, cadets: cadetsOf(was).length, parades: Array.isArray(was.parades) ? was.parades.length : 0, tasks: Array.isArray(was.events) ? was.events.length : 0 });
    if (bErr) throw new Error("could not keep the archive copy: " + bErr.message);
    const n = { parades: 0, tasks: 0, history: 0, other: 0 };
    await changeState(a.me.id, (s) => {
      const keep = (k: string, ok: (x: Obj) => boolean, count: keyof typeof n) => {
        if (!Array.isArray(s[k])) return;
        const len = s[k].length; s[k] = s[k].filter((x: Obj) => !x || ok(x)); n[count] += len - s[k].length;
      };
      keep("parades", (p) => !(Number(p.reportAt) < cut), "parades");
      keep("events", (e) => !(e.archived === true && Number(e.archivedAt || e.createdAt || 0) < cut && e.id !== s.activeEventId), "tasks");
      keep("history", (h) => !(Number(h.at) < cut), "history");
      keep("messDuty", (d) => !(String(d.date || "9") < before), "other");
      keep("messSwaps", (d) => !(String(d.date || "9") < before), "other");
      keep("leaves", (l) => !(String(l.to || "9") < before), "other");
      keep("signups", (x) => !(Number(x.closesAt) < cut), "other");
      keep("notices", (x) => !(Number(x.until || x.at || Infinity) < cut), "other");
      addHistory(s, "archived", null, `Archived records from before ${before} (${n.parades} parades, ${n.tasks} tasks, ${n.history} activity entries) by ${nameOf(a)}. A copy is in Backups.`);
      return true;
    });
    return json({ ok: true, ...n });
  }

  // ---- backups of the shared data (table cadetflow_backups), made by hand by the administrator,
  // plus one just before each restore. Kept 30 days. There is no nightly copy.
  if (action === "backups" || action === "backupNow" || action === "restoreBackup") {
    const a = await access(me, "admin");
    const summary = (s: Obj) => ({
      size: JSON.stringify(s).length, cadets: Array.isArray(s.cadets) ? s.cadets.length : 0,
      parades: Array.isArray(s.parades) ? s.parades.length : 0, tasks: Array.isArray(s.events) ? s.events.length : 0,
    });
    const keep = async (kind: string, s: Obj) => {
      const { error } = await db.from("cadetflow_backups").insert({ kind, state: s, taken_at: new Date().toISOString(), taken_by: a.me.id, ...summary(s) });
      if (error) throw new Error("could not save the backup: " + error.message);
      await db.from("cadetflow_backups").delete().neq("kind", "archive").lt("taken_at", new Date(Date.now() - 30 * 86400_000).toISOString());
    };
    if (action === "backupNow") { await keep("manual", (await readState()).state); return json({ ok: true }); }
    if (action === "restoreBackup") {
      const { data: b, error } = await db.from("cadetflow_backups").select("id, taken_at, state").eq("id", String(body.id || "")).maybeSingle();
      if (error) throw new Error("could not read the backup: " + error.message);
      if (!b?.state || !Array.isArray(b.state.cadets) || !Array.isArray(b.state.events)) fail(404, "That backup no longer exists.");
      await keep("before-restore", (await readState()).state); // so the restore itself can be undone
      const day = when(Date.parse(b.taken_at));
      await changeState(a.me.id, (s) => {
        Object.keys(s).forEach((k) => delete s[k]);
        Object.assign(s, JSON.parse(JSON.stringify(b.state)));
        addHistory(s, "backup-restored", null, `Restored the backup from ${day} (${nameOf(a)})`);
        return true;
      });
      return json({ ok: true });
    }
    const { data, error } = await db.from("cadetflow_backups").select("id, taken_at, kind, size, cadets, parades, tasks").order("taken_at", { ascending: false }).limit(100);
    if (error) throw new Error("could not list the backups: " + error.message);
    return json({ backups: (data || []).map((b) => ({ id: b.id, at: Date.parse(b.taken_at), kind: b.kind, size: b.size, cadets: b.cadets, parades: b.parades, tasks: b.tasks })) });
  }


  if (action === "suggestions" || action === "suggestionUpdate") {
    const a = await access(me, "admin");
    if (action === "suggestionUpdate") {
      const { data: x, error: re } = await db.from("cadetflow_suggestions").select("id, user_id, text").eq("id", String(body.id || "")).maybeSingle();
      if (re) throw new Error("could not read it: " + re.message);
      if (!x) fail(404, "That suggestion was removed.");
      const change: Obj = {};
      if (["new", "seen", "done"].includes(body.status)) change.status = body.status;
      if (typeof body.reply === "string") {
        const reply = body.reply.trim().slice(0, 1000);
        Object.assign(change, reply ? { reply, replied_at: new Date().toISOString(), replied_by_name: nameOf(a) } : { reply: null, replied_at: null, replied_by_name: null });
        if (reply && !x.user_id) fail(400, "This one was sent without a name, so a reply cannot reach anyone.");
      }
      if (!Object.keys(change).length) return json({ ok: true });
      const { error } = await db.from("cadetflow_suggestions").update(change).eq("id", x.id);
      if (error) throw new Error("could not save it: " + error.message);
      if (change.reply && x.user_id) await tell([x.user_id], { title: "Reply to your suggestion", body: change.reply.length > 150 ? change.reply.slice(0, 147) + "…" : change.reply, tag: `suggestion-${x.id}`, url: "./?page=home" });
      return json({ ok: true });
    }
    const { data, error } = await db.from("cadetflow_suggestions").select("id, text, created_at, status, name, cadet_id, user_id, reply, replied_at, replied_by_name").order("created_at", { ascending: false }).limit(300);
    if (error) throw new Error("could not read them: " + error.message);
    return json({ suggestions: (data || []).map((x) => ({ id: x.id, text: x.text, at: Date.parse(x.created_at), status: x.status, name: x.name || "", cadetId: x.cadet_id || null, anonymous: !x.user_id, reply: x.reply || "", repliedAt: x.replied_at ? Date.parse(x.replied_at) : null, repliedBy: x.replied_by_name || "" })) });
  }

  if (action === "invite") {
    const a = await access(me, "admin");
    const site = siteOf(body);
    const people = (Array.isArray(body.people) ? body.people : []).slice(0, 200);
    const users = await allUsers();
    const results: Obj[] = [];
    const regNos = new Map<string, string>();
    const seen = new Set<string>();
    for (const p of people) {
      const email = cleanEmail(p?.email);
      const cadet = findCadet(a.state, p?.cadetId);
      const regNo = cleanRegNo(p?.regNo);
      const out: Obj = { email, cadetId: cadet ? String(cadet.id) : null };
      try {
        if (!EMAIL.test(email)) fail(400, "No valid email.");
        if (seen.has(email)) fail(400, "This email is already higher up in the list.");
        seen.add(email);
        if (!cadet) fail(400, "Not matched to a cadet on the roster.");
        let existing = users.find((u) => (u.email || "").toLowerCase() === email);
        const prof = existing ? await profileOf(existing.id) : null;
        const { data: holder } = await db.from("cadetflow_profiles").select("user_id, email, status").eq("cadet_id", String(cadet.id)).neq("status", "rejected").maybeSingle();
        if (holder && holder.user_id !== existing?.id) {
          fail(409, holder.status === "pending"
            ? `${cadet.name} has a registration waiting from ${holder.email || "another email"}: approve or reject it on the Accounts page first.`
            : `${cadet.name} is already linked to another account${holder.email ? ` (${holder.email})` : ""}.`);
        }
        if (prof?.status === "approved" && prof.cadet_id && String(prof.cadet_id) !== String(cadet.id)) {
          const other = findCadet(a.state, prof.cadet_id);
          fail(409, `This email's account belongs to ${other ? other.name : "another cadet"}. If that is wrong, change it on the Accounts page.`);
        }
        const profile = { cadet_id: String(cadet.id), display_name: cadet.name, email, ...(regNo ? { regimental_no: regNo } : {}) };
        if (existing && prof?.status !== "approved") {
          // Waiting, turned down, or made outside the site: whoever made it chose its password, and nobody checked
          // they own this email. Remove it (its password and sign-ins go with it) and invite again: only the
          // email's owner gets the invite.
          if (existing.id === a.me.id) fail(400, "That is your own account.");
          const { error } = await db.auth.admin.deleteUser(existing.id);
          if (error) throw new Error(error.message);
          users.splice(users.indexOf(existing), 1);
          existing = undefined;
          out.replaced = true;
        }
        if (existing) {
          // Already has an approved account: link it to the cadet.
          const { error } = await db.from("cadetflow_profiles").update({ ...profile, decided_at: new Date().toISOString(), decided_by: a.me.id }).eq("user_id", existing.id);
          if (error) throw new Error(error.message);
          out.result = "linked";
        } else {
          let userId: string | undefined, link = "";
          if (body.send !== false) {
            const { data: inv, error } = await db.auth.admin.inviteUserByEmail(email, { redirectTo: site, data: { name: cadet.name } });
            if (!error && inv?.user) userId = inv.user.id;
            else console.error("invite email", email, error?.message);
          }
          if (!userId) {
            try { ({ link, userId } = await passwordLink(email, "invite", site, { name: cadet.name })); }
            catch (e) {
              // The failed invite may still have made the account: a reset link sets the password too. Only an
              // account nobody has used: someone may have registered this email meanwhile, with their own password.
              const made = await userByEmail(email);
              if (!made || made.email_confirmed_at || made.last_sign_in_at || await profileOf(made.id)) throw e;
              ({ link } = await passwordLink(email, "recovery", site));
              userId = made.id;
            }
          }
          if (!userId) throw new Error("the account was not created");
          const { error } = await db.from("cadetflow_profiles").upsert({ user_id: userId, ...profile, role: "viewer", status: "approved", invited_at: new Date().toISOString(), decided_at: new Date().toISOString(), decided_by: a.me.id }, { onConflict: "user_id" });
          if (error) throw new Error(error.message);
          users.push({ id: userId, email });
          out.result = link ? "link" : "sent";
          if (link) out.link = link;
        }
        if (regNo) regNos.set(String(cadet.id), regNo);
      } catch (e) {
        out.result = "error";
        out.error = e instanceof HttpError ? e.message : "Could not set up: " + String((e as Error)?.message || e).slice(0, 150);
      }
      results.push(out);
    }
    // The list's regimental numbers go onto the roster.
    if (regNos.size) {
      await changeState(a.me.id, (s) => {
        let changed = false;
        for (const [id, no] of regNos) { const c = findCadet(s, id); if (c && c.regNo !== no) { c.regNo = no; changed = true; } }
        if (changed) addHistory(s, "roster-regno", null, `Regimental numbers updated from the account list (${regNos.size})`);
        return changed;
      });
    }
    return json({ results });
  }

  if (["approve", "reject", "setRole", "setPassword", "resetLink", "remove", "link"].includes(action)) {
    const a = await access(me, "admin");
    const userId = String(body.userId || "");
    const { data: target } = await db.auth.admin.getUserById(userId);
    if (!target?.user) fail(404, "That account no longer exists.");
    const prof = await profileOf(userId);
    const email = (target.user.email || "").toLowerCase();
    const stamp = { decided_at: new Date().toISOString(), decided_by: a.me.id };

    if (action === "approve") {
      const role = ROLES.includes(body.role) ? body.role : (prof?.role === "admin" ? "admin" : "viewer");
      const { error } = prof
        ? await db.from("cadetflow_profiles").update({ status: "approved", role, ...stamp }).eq("user_id", userId)
        : await db.from("cadetflow_profiles").insert({ user_id: userId, display_name: email.split("@")[0], email, role, status: "approved", ...stamp });
      if (error) fail(error.code === "23505" ? 409 : 500, error.code === "23505" ? "Another account is already linked to that cadet." : "could not approve: " + error.message);
      // The regimental number they gave goes onto their roster entry if it has none yet.
      if (prof?.cadet_id && prof.regimental_no) {
        await changeState(a.me.id, (s) => {
          const c = findCadet(s, prof.cadet_id);
          if (!c || c.regNo) return false;
          c.regNo = prof.regimental_no;
          return true;
        });
      }
      return json({ ok: true });
    }
    if (action === "reject") {
      if (userId === a.me.id) fail(400, "You cannot reject your own account.");
      if (prof?.role === "admin") await keepAnAdmin(userId);
      const { error } = prof
        ? await db.from("cadetflow_profiles").update({ status: "rejected", ...stamp }).eq("user_id", userId)
        : await db.from("cadetflow_profiles").insert({ user_id: userId, display_name: email.split("@")[0], email, role: "viewer", status: "rejected", ...stamp });
      if (error) throw new Error("could not reject: " + error.message);
      await db.from("cadetflow_push_subscriptions").delete().eq("user_id", userId);
      return json({ ok: true });
    }
    if (action === "setRole") {
      if (!ROLES.includes(body.role)) fail(400, "Unknown role.");
      if (!prof) fail(400, "Approve the account first.");
      if (prof.role === "admin" && body.role !== "admin") await keepAnAdmin(userId);
      const { error } = await db.from("cadetflow_profiles").update({ role: body.role }).eq("user_id", userId);
      if (error) throw new Error("could not change the role: " + error.message);
      return json({ ok: true });
    }
    if (action === "setPassword") {
      const password = checkPassword(body.password);
      const { error } = await db.auth.admin.updateUserById(userId, { password });
      if (error) throw new Error("could not set the password: " + error.message);
      if (prof) await db.from("cadetflow_profiles").update({ reset_requested_at: null }).eq("user_id", userId);
      return json({ ok: true });
    }
    if (action === "resetLink") {
      // Email the link, or (send: false, or the email could not go) hand it back to be shared.
      const site = siteOf(body);
      let link = "", emailed = false;
      if (body.send !== false) {
        const { error } = await db.auth.resetPasswordForEmail(email, { redirectTo: site });
        if (!error) emailed = true; else console.error("reset email", email, error.message);
      }
      if (!emailed) link = (await passwordLink(email, "recovery", site)).link;
      if (prof) await db.from("cadetflow_profiles").update({ reset_requested_at: null }).eq("user_id", userId);
      return json({ emailed, link, email });
    }
    if (action === "remove") {
      if (userId === a.me.id) fail(400, "You cannot remove your own account.");
      if (prof?.role === "admin") await keepAnAdmin(userId);
      const { error } = await db.auth.admin.deleteUser(userId);
      if (error) throw new Error("could not remove the account: " + error.message);
      return json({ ok: true });
    }
    if (action === "link") {
      if (!prof) fail(400, "Approve the account first.");
      let cadetId: string | null = null;
      if (body.cadetId) {
        const c = findCadet(a.state, body.cadetId);
        if (!c) fail(400, "That cadet is not on the roster.");
        cadetId = String(c.id);
      }
      const { error } = await db.from("cadetflow_profiles").update({ cadet_id: cadetId }).eq("user_id", userId);
      if (error) fail(error.code === "23505" ? 409 : 500, error.code === "23505" ? "Another account is already linked to that cadet." : "could not link: " + error.message);
      return json({ ok: true });
    }
  }

  return json({ error: "Unknown action" }, 400);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);
  let body: Obj;
  try { body = await req.json(); } catch { return json({ error: "Bad request" }, 400); }
  try {
    return await handle(req, body || {});
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.error(e);
    return json({ error: "Server problem: " + String((e as Error)?.message || e).slice(0, 200) }, 500);
  }
});
