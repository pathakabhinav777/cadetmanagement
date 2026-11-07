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
// Approved accounts:
//   subscribe { subscription }             -> { ok }             this device, for this person
//   report    { paradeId, kind, reason, image?, removeImage? } -> { request }   own late/absence request
//   withdraw  { id }                       -> { ok }
//   requests                               -> { requests }       SGT and above: everyone's; others: own
//   payInfo                                -> { upi, payee, note, qrUrl }      where to pay CQMS
//   uniformRequest  { items: [{ item, custom?, size? }], qty?, note? } -> { added, skipped }   own items
//   uniformCancel   { id }  /  uniformReceived { id }  /  uniformPay { ids, image } -> { ok }
// SGT and above:   decide { id, approve, note? }, reportImage { id }
// JUO / SUO:       notify { paradeId, again? (administrator) }
// CQMS:            payImage { proofId }, payDecide { proofId, ok, note? }, setPayInfo { upi, payee, note, image?, removeQr? }
// Administrator:   accounts, invite { people: [{ cadetId, email, regNo }], send, site },
//                  resetLink { userId, send, site }, setPassword { userId, password },
//                  approve { userId, role? }, reject, setRole { role }, remove, link { cadetId|null }
//
// Files (private bucket cadetflow-report-files): request screenshots under <parade>/, payment
// screenshots under pay/, the payment QR under settings/. Request screenshots go once the request
// is decided and the parade is over; payment screenshots once every item they paid for is approved
// and collected.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import webpush from "npm:web-push@3.6.7";
// @ts-ignore plain JavaScript module shared with the tests
import * as rules from "./rules.mjs";

const { approvedReport, audienceText, can, CUTOFF_MIN, inParade, paradeRecipients, payProofsToDelete, requestCleanup,
  requestsOpen, uniformKeyOf, uniformLabelOf, uniformReceiveBlock, uniformUnitOf, UNIFORM_ITEMS } = rules;

const SITE = "https://pathakabhinav777.github.io/cadetmanagement/";
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
type Who = { admin: boolean; rank: string | null; cadet: Obj | null };

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
  const who: Who = { admin: me.profile.role === "admin", rank: cadet ? String(cadet.rank || "CDT").toUpperCase() : null, cadet };
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
async function devicesOf(userIds: string[]): Promise<Sub[]> {
  if (!userIds.length) return [];
  const { data, error } = await db.from("cadetflow_push_subscriptions").select("endpoint, p256dh, auth").in("user_id", userIds);
  if (error) throw new Error("could not read devices: " + error.message);
  return (data || []) as Sub[];
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
async function tell(userIds: string[], payload: Obj) {
  try { return await sendTo(await devicesOf(userIds), payload); } catch (e) { console.error("notify", e); return { sent: 0, failed: 0, removed: 0 }; }
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
    const { data, error } = await db.from("cadetflow_requests").select("id, parade_id, status, image_path").limit(5000);
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
    decidedBy: r.decided_by_name || "", hasImage: !!r.image_path, hadImage: !!r.had_image, mine: false,
  };
}
const REQ_COLS = "id, parade_id, cadet_id, user_id, kind, reason, status, note, image_path, had_image, created_at, updated_at, decided_at, decided_by, decided_by_name";

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
    if (regNo.length < 4) fail(400, "Enter your regimental number.");
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
      cadet_id: String(cadet.id), regimental_no: regNo, requested_at: new Date().toISOString(),
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

  if (action === "requests") {
    const a = await access(me, null);
    const everyone = can(a.who, "requests");
    if (everyone) await cleanup(a.state, a.me.id);
    const since = new Date(Date.now() - 45 * 86400_000).toISOString();
    let q = db.from("cadetflow_requests").select(REQ_COLS).gte("created_at", since).order("created_at", { ascending: true }).limit(2000);
    if (!everyone) q = q.eq("user_id", a.me.id);
    const { data, error } = await q;
    if (error) throw new Error("could not read requests: " + error.message);
    return json({ requests: (data || []).map((r) => ({ ...requestOut(r), mine: r.user_id === a.me.id })) });
  }

  if (action === "reportImage") {
    await access(me, "requests");
    const { data: r } = await db.from("cadetflow_requests").select("image_path").eq("id", String(body.id || "")).maybeSingle();
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
    const approve = body.approve === true;
    const note = String(body.note || "").trim().slice(0, 300);
    const decider = nameOf(a);
    let state = a.state;
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

  // ---- parades
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
      people = paradeRecipients(await approvedProfiles(), cadetsOf(a.state), pd);
      subs = await devicesOf(people);
      const lines = [when(Number(pd.reportAt)), pd.venue ? String(pd.venue) : "", `For: ${audienceText(pd)}`].filter(Boolean);
      r = await sendTo(subs, { title: `New parade: ${String(pd.title || "Parade")}`, body: lines.join(" · "), tag: `parade-${paradeId}`, url: `./?parade=${encodeURIComponent(paradeId)}` });
    } catch (e) {
      if (body.again !== true) await db.from("cadetflow_push_sent").delete().eq("parade_id", paradeId);
      throw e;
    }
    await db.from("cadetflow_push_sent").update({ delivered: r.sent, failed: r.failed }).eq("parade_id", paradeId);
    return json({ ...r, devices: subs.length, people: people.length });
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
    const [{ data: profiles, error }, users] = await Promise.all([db.from("cadetflow_profiles").select("*"), allUsers()]);
    if (error) throw new Error("could not read accounts: " + error.message);
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
        lastSignIn: u.last_sign_in_at || null, createdAt: u.created_at, you: u.id === a.me.id,
      };
    });
    return json({ accounts });
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
