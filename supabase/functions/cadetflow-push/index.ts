// CadetFlow push notifications (Supabase Edge Function "cadetflow-push").
// Deployed with verify_jwt = false: the site uses a publishable key (not a JWT), so this function
// checks sign-in itself where it matters (sending).
//
// POST { action: 'key' }                          -> { publicKey }        public VAPID key for subscribing
// POST { action: 'subscribe', subscription }      -> { ok }               save this device
// POST { action: 'unsubscribe', endpoint }        -> { ok }               forget this device
// POST { action: 'test', endpoint }               -> { ok }               test notification to one saved device
// POST { action: 'notify', paradeId }  (signed-in senior/admin)  -> { sent, failed } | { alreadySent }
//   Announces a parade that is saved in cadetflow_state, once, to every saved device.
//
// Tables (RLS on, no policies; only this function's service role uses them):
//   cadetflow_push_subscriptions, cadetflow_push_keys, cadetflow_push_sent
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import webpush from "npm:web-push@3.6.7";

const SITE = "https://pathakabhinav777.github.io/cadetmanagement/";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

/** Server key: the new-style secret key when the project has one, else the legacy service role key. */
function serverKey() {
  try { const k = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}"); if (k.default) return String(k.default); } catch { /* not set */ }
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
}
const db = createClient(Deno.env.get("SUPABASE_URL")!, serverKey(), {
  auth: { persistSession: false, autoRefreshToken: false },
});

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
/** Send one payload to many devices; forget devices the push service says are gone. */
async function sendTo(subs: Sub[], payload: Record<string, unknown>) {
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

const IST = "Asia/Kolkata"; // the units are in Nagaland
function when(ms: number) {
  const d = new Date(ms);
  const day = new Intl.DateTimeFormat("en-IN", { timeZone: IST, weekday: "short", day: "numeric", month: "short" }).format(d);
  const time = new Intl.DateTimeFormat("en-IN", { timeZone: IST, hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
  return `${day}, ${time}`;
}
function audience(pd: Record<string, unknown>) {
  if (Array.isArray(pd.cadetIds) && pd.cadetIds.length) return `${pd.cadetIds.length} picked cadet${pd.cadetIds.length === 1 ? "" : "s"}`;
  const scope = !pd.scope || pd.scope === "All" ? "All companies" : String(pd.scope);
  const years = Array.isArray(pd.years) && pd.years.length ? ` (${pd.years.join(" & ")} year)` : "";
  return scope + years;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);
  let body: Record<string, any>;
  try { body = await req.json(); } catch { return json({ error: "Bad request" }, 400); }

  try {
    switch (body.action) {
      case "key":
        return json({ publicKey: (await vapidKeys()).public_key });

      case "subscribe": {
        const s = body.subscription;
        if (!s || typeof s.endpoint !== "string" || !/^https:\/\//.test(s.endpoint) || !s.keys?.p256dh || !s.keys?.auth) return json({ error: "Bad subscription" }, 400);
        const { error } = await db.from("cadetflow_push_subscriptions").upsert({
          endpoint: s.endpoint, p256dh: String(s.keys.p256dh), auth: String(s.keys.auth),
          user_agent: String(req.headers.get("user-agent") || "").slice(0, 300), updated_at: new Date().toISOString(),
        }, { onConflict: "endpoint" });
        if (error) throw error;
        return json({ ok: true });
      }

      case "unsubscribe":
        if (typeof body.endpoint !== "string") return json({ error: "Bad request" }, 400);
        await db.from("cadetflow_push_subscriptions").delete().eq("endpoint", body.endpoint);
        return json({ ok: true });

      case "test": {
        const { data: sub } = await db.from("cadetflow_push_subscriptions").select("endpoint, p256dh, auth").eq("endpoint", String(body.endpoint || "")).maybeSingle();
        if (!sub) return json({ error: "This device is not registered for notifications." }, 404);
        const r = await sendTo([sub], { title: "CadetFlow", body: "Notifications are working. You'll get one when a new parade is posted.", tag: "cadetflow-test", url: SITE });
        return json({ ok: r.sent === 1, ...r });
      }

      case "notify": {
        const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
        const { data: who } = await db.auth.getUser(token);
        if (!who?.user) return json({ error: "Sign in to send notifications." }, 401);
        const { data: prof } = await db.from("cadetflow_profiles").select("role").eq("user_id", who.user.id).maybeSingle();
        if (!["admin", "editor", "senior"].includes(String(prof?.role))) return json({ error: "Only seniors and administrators can send notifications." }, 403);

        const paradeId = String(body.paradeId || "");
        const { data: row } = await db.from("cadetflow_state").select("state").eq("id", 1).maybeSingle();
        const pd = (row?.state?.parades || []).find((p: Record<string, unknown>) => p && p.id === paradeId);
        if (!pd) return json({ error: "That parade is not saved yet." }, 404);
        if (!(Number(pd.reportAt) > Date.now())) return json({ sent: 0, skipped: "past" });

        // Claim the parade first so two clicks (or two seniors) never announce it twice.
        const { error: claim } = await db.from("cadetflow_push_sent").insert({ parade_id: paradeId, sent_by: who.user.id });
        if (claim) return claim.code === "23505" ? json({ alreadySent: true }) : json({ error: claim.message }, 500);

        const { data: subs } = await db.from("cadetflow_push_subscriptions").select("endpoint, p256dh, auth");
        const lines = [when(Number(pd.reportAt)), pd.venue ? String(pd.venue) : "", `For: ${audience(pd)}`].filter(Boolean);
        const r = await sendTo(subs || [], {
          title: `New parade: ${String(pd.title || "Parade")}`,
          body: lines.join(" · "),
          tag: `parade-${paradeId}`,
          url: `${SITE}?parade=${encodeURIComponent(paradeId)}`,
        });
        await db.from("cadetflow_push_sent").update({ delivered: r.sent, failed: r.failed }).eq("parade_id", paradeId);
        return json(r);
      }
    }
    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: "Server error" }, 500);
  }
});
