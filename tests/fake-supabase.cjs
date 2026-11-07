// In-memory Supabase for the automated tests.
//
// One Backend per test holds the tables, the sign-in accounts, stored files and the notifications
// that were "sent". Browser pages talk to it through tests/supabase-stub.js (with the row-level
// security rules the live database has after launch), and the real server function
// supabase/functions/cadetflow-api/index.ts runs against it with full access, like on Supabase.
//
// Running the server needs Node 22.6 or newer (TypeScript is loaded with --experimental-strip-types).
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');

const SERVER_DIR = path.join(__dirname, '..', 'supabase', 'functions', 'cadetflow-api');
const clone = v => (v == null ? v : JSON.parse(JSON.stringify(v)));
const now = () => new Date().toISOString();

// Primary keys and the partial unique indexes from supabase/migrations.
const KEYS = {
  cadetflow_state: ['id'], cadetflow_profiles: ['user_id'], cadetflow_requests: ['id'], cadetflow_settings: ['key'],
  cadetflow_push_subscriptions: ['endpoint'], cadetflow_push_keys: ['id'], cadetflow_push_sent: ['parade_id'],
};
const UNIQUE = {
  cadetflow_profiles: [{ cols: ['cadet_id'], where: r => r.cadet_id != null && r.status !== 'rejected' }],
  cadetflow_requests: [{ cols: ['parade_id', 'cadet_id'], where: r => r.status === 'pending' }],
};
const DEFAULTS = {
  cadetflow_profiles: () => ({ role: 'viewer', status: 'pending', display_name: null, cadet_id: null, regimental_no: null, email: null,
    requested_at: null, decided_at: null, decided_by: null, invited_at: null, reset_requested_at: null }),
  cadetflow_requests: () => ({ status: 'pending', had_image: false, image_path: null, note: null, created_at: now(), updated_at: now(),
    decided_at: null, decided_by: null, decided_by_name: null }),
  cadetflow_settings: () => ({ updated_at: now(), updated_by: null }),
  cadetflow_push_subscriptions: () => ({ created_at: now(), user_id: null }),
  cadetflow_push_sent: () => ({ sent_at: now(), sent_by: null, delivered: null, failed: null }),
};

const isTime = v => typeof v === 'string' && /^\d{4}-\d\d-\d\dT/.test(v);
const same = (a, b) => (isTime(a) && isTime(b) ? Date.parse(a) === Date.parse(b) : String(a) === String(b));
const cmp = (a, b) => (isTime(a) && isTime(b) ? Date.parse(a) - Date.parse(b) : a < b ? -1 : a > b ? 1 : 0);
function passes([op, col, val], row) {
  const v = row[col];
  switch (op) {
    case 'eq': return v != null && same(v, val);
    case 'neq': return v != null && !same(v, val);
    case 'is': return val === null ? v == null : v === val;
    case 'not.is': return val === null ? v != null : v !== val;
    case 'in': return v != null && val.some(x => same(v, x));
    case 'gte': return v != null && cmp(v, val) >= 0;
    case 'gt': return v != null && cmp(v, val) > 0;
    case 'lte': return v != null && cmp(v, val) <= 0;
    case 'lt': return v != null && cmp(v, val) < 0;
    default: throw new Error('fake supabase: filter not supported: ' + op);
  }
}
function pick(row, cols) {
  if (!cols || cols.trim() === '*') return clone(row);
  const out = {};
  cols.split(',').map(c => c.trim()).filter(Boolean).forEach(c => { out[c] = row[c] === undefined ? null : clone(row[c]); });
  return out;
}
const WRITER_RANKS = ['LCPL', 'CPL', 'SGT', 'CQMS', 'CSM', 'JUO', 'SUO'];
const SAFE_ID = /^[A-Za-z0-9_.:-]{1,128}$/; // ids the site keeps (safeId in index.html)
/** JSON text with object keys sorted, so two values compare like jsonb does. */
const canonical = v => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map(k => [k, x[k]])) : x));
/** The roster entry with this id in a saved state, like `c ->> 'id' = cadet_id` in SQL. */
const cadetOf = (state, id) => (id == null ? null : (Array.isArray(state?.cadets) ? state.cadets : [])
  .find(x => x && typeof x === 'object' && !Array.isArray(x) && x.id != null && typeof x.id !== 'object' && String(x.id) === String(id)) || null);
const duplicate = table => ({ data: null, error: { message: `duplicate key value violates unique constraint (${table})`, code: '23505' } });
const denied = table => ({ data: null, error: { message: `permission denied for table ${table}`, code: '42501' } });

/** Chainable query like supabase-js's; `run(q)` executes it. */
function queryBuilder(table, run) {
  const q = { table, op: 'select', cols: '*', values: null, filters: [], order: null, limit: null, returning: false,
    count: null, head: false, single: null, onConflict: null, ignoreDuplicates: false };
  const b = {
    select(cols = '*', opts = {}) {
      if (q.op === 'select') { q.cols = cols; q.count = opts.count || null; q.head = !!opts.head; } else { q.returning = true; q.cols = cols; }
      return b;
    },
    insert(values) { q.op = 'insert'; q.values = values; return b; },
    upsert(values, opts = {}) { q.op = 'upsert'; q.values = values; q.onConflict = opts.onConflict || null; q.ignoreDuplicates = !!opts.ignoreDuplicates; return b; },
    update(values) { q.op = 'update'; q.values = values; return b; },
    delete() { q.op = 'delete'; return b; },
    eq(c, v) { q.filters.push(['eq', c, v]); return b; },
    neq(c, v) { q.filters.push(['neq', c, v]); return b; },
    is(c, v) { q.filters.push(['is', c, v]); return b; },
    in(c, v) { q.filters.push(['in', c, v]); return b; },
    gte(c, v) { q.filters.push(['gte', c, v]); return b; },
    gt(c, v) { q.filters.push(['gt', c, v]); return b; },
    lte(c, v) { q.filters.push(['lte', c, v]); return b; },
    lt(c, v) { q.filters.push(['lt', c, v]); return b; },
    not(c, op, v) { q.filters.push(['not.' + op, c, v]); return b; },
    order(c, { ascending = true } = {}) { q.order = [c, ascending]; return b; },
    limit(n) { q.limit = n; return b; },
    maybeSingle() { q.single = 'maybe'; return Promise.resolve().then(() => run(q)); },
    single() { q.single = 'one'; return Promise.resolve().then(() => run(q)); },
    then(resolve, reject) { return Promise.resolve().then(() => run(q)).then(resolve, reject); },
  };
  return b;
}

// ---- The real server, with npm imports swapped for these fakes -------------------------------
let preparedDir = null, serverCount = 0;
function prepareServer() {
  if (preparedDir) return preparedDir;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadetflow-api-test-'));
  let src = fs.readFileSync(path.join(SERVER_DIR, 'index.ts'), 'utf8');
  const swaps = [[/"npm:@supabase\/supabase-js@[^"]+"/, '"./fake-supabase-js.mjs"'], [/"npm:web-push@[^"]+"/, '"./fake-web-push.mjs"']];
  for (const [from, to] of swaps) {
    if (!from.test(src)) throw new Error('fake supabase: import not found in index.ts: ' + from);
    src = src.replace(from, to);
  }
  fs.writeFileSync(path.join(dir, 'index.mts'), src);
  fs.copyFileSync(path.join(SERVER_DIR, 'rules.mjs'), path.join(dir, 'rules.mjs'));
  fs.writeFileSync(path.join(dir, 'fake-supabase-js.mjs'), 'export function createClient() { return globalThis.__cadetflowBackend.adminClient(); }\n');
  fs.writeFileSync(path.join(dir, 'fake-web-push.mjs'), 'export default new Proxy({}, { get: (_t, k) => (...a) => globalThis.__cadetflowBackend.webpush[k](...a) });\n');
  preparedDir = dir;
  return dir;
}
async function loadServer(backend) {
  const dir = prepareServer();
  let handler = null;
  globalThis.Deno = {
    env: { get: k => ({ SUPABASE_URL: 'https://fake.supabase.test', SUPABASE_SERVICE_ROLE_KEY: 'service-role' })[k] },
    serve: h => { handler = h; return {}; },
  };
  globalThis.__cadetflowBackend = backend;
  // A fresh copy of the module per backend, so its caches start empty.
  await import(pathToFileURL(path.join(dir, 'index.mts')).href + '?backend=' + (++serverCount));
  if (!handler) throw new Error('fake supabase: the server did not call Deno.serve');
  return handler;
}

class Backend {
  constructor() {
    this.tables = Object.fromEntries(Object.keys(KEYS).map(t => [t, []]));
    this.tables.cadetflow_state.push({ id: 1, state: null, updated_at: null, updated_by: null });
    this.users = new Map();      // auth.users
    this.files = new Map();      // storage: path -> { base64, contentType, created_at }
    this.pushes = [];            // notifications sent: { endpoint, payload, userId }
    this.mails = [];             // emails sent: { type: 'invite' | 'recovery', email, link }
    this.mailWorks = true;       // false: Supabase cannot send email (no SMTP set up)
    this.goneEndpoints = new Set();
    this.pages = [];
    this.writes = 0;             // saves of the shared data
    this.autoNotify = true;      // tell open pages about saves (Realtime)
    this.calls = [];             // server actions called: { action, userId, status }
    this.tick = 0;
    this.webpush = {
      generateVAPIDKeys: () => ({ publicKey: 'B' + crypto.randomBytes(32).toString('base64url'), privateKey: crypto.randomBytes(16).toString('base64url') }),
      setVapidDetails: () => {},
      sendNotification: async (sub, body) => {
        if (this.goneEndpoints.has(sub.endpoint)) { const e = new Error('push subscription has unsubscribed or expired'); e.statusCode = 410; throw e; }
        const row = this.tables.cadetflow_push_subscriptions.find(s => s.endpoint === sub.endpoint);
        this.pushes.push({ endpoint: sub.endpoint, userId: row ? row.user_id : null, payload: JSON.parse(body) });
        return { statusCode: 201 };
      },
    };
  }

  // ---- shared data -------------------------------------------------------------------------------
  get row() { return this.tables.cadetflow_state[0]; }
  stamp() { return new Date(Date.now() + ++this.tick).toISOString().replace('Z', '000+00:00'); } // like Postgres now()
  profile(userId) { return this.tables.cadetflow_profiles.find(p => p.user_id === userId) || null; }
  /** Same as cadetflow_my_access() in supabase/launch: admin | writer (rank above CDT) | member | null. */
  accessOf(userId) {
    const p = userId && this.profile(userId);
    if (!p || p.status !== 'approved') return null;
    if (p.role === 'admin') return 'admin';
    const c = cadetOf(this.row.state, p.cadet_id);
    return c && WRITER_RANKS.includes(String(c.rank ?? '').toUpperCase()) ? 'writer' : 'member';
  }
  /**
   * Same as the trigger cadetflow_state_guard in supabase/launch: why the database refuses this save of
   * the shared data ('' when it is fine). level: what cadetflow_my_access() says about the person saving.
   */
  guardRefuses(userId, level, oldRow, values) {
    if ('id' in values && !same(values.id, oldRow.id)) return 'The shared data cannot be moved.';
    if (level === 'admin' || !('state' in values)) return '';
    const before = oldRow.state, after = values.state;
    // jsonb: a missing key is SQL null, JSON null is a value; objects compare without key order.
    const part = (s, k) => (s && typeof s === 'object' && !Array.isArray(s) && k in s ? canonical(s[k]) : undefined);
    if (part(after, 'cadets') !== part(before, 'cadets')) return 'Only the administrator can change the roster.';
    const ids = s => new Set((Array.isArray(s?.events) ? s.events : []).filter(e => e && typeof e === 'object' && !Array.isArray(e) && typeof e.id === 'string' && SAFE_ID.test(e.id)).map(e => e.id));
    const kept = new Set((Array.isArray(after?.events) ? after.events : []).filter(e => e && typeof e === 'object').map(e => String(e.id)));
    if ([...ids(before)].some(id => !kept.has(id))) return 'Only the administrator can remove tasks.';
    if (part(after, 'uniform') !== part(before, 'uniform') || part(after, 'uniformPrices') !== part(before, 'uniformPrices')) {
      const p = this.profile(userId);
      const c = p && p.status === 'approved' ? cadetOf(before, p.cadet_id) : null;
      if (!c || String(c.rank ?? '').toUpperCase() !== 'CQMS') return 'Only the CQMS and the administrator can change uniform orders, payments and prices.';
    }
    return '';
  }

  /** Add a sign-in account with its CadetFlow profile. */
  account(id, { role = 'viewer', status = 'approved', cadetId = null, email = `${id}@example.com`, password = `pass-${id}`, name = null, regNo = null } = {}) {
    if (!this.users.has(id)) this.addUser({ id, email, password });
    const p = this.profile(id);
    const row = { user_id: id, role, status, cadet_id: cadetId, display_name: name, email: email.toLowerCase(), regimental_no: regNo };
    if (p) Object.assign(p, row); else this.tables.cadetflow_profiles.push({ ...DEFAULTS.cadetflow_profiles(), ...row });
    return this;
  }
  /** Link an account to a cadet on the roster (rank decides what they can do). */
  link(userId, cadetId) { this.profile(userId).cadet_id = cadetId; return this; }
  cadet(id) { return (this.row.state?.cadets || []).find(c => c.id === id); }
  setRank(cadetId, rank) { this.cadet(cadetId).rank = rank; return this; }

  // ---- queries -------------------------------------------------------------------------------------
  finish(q, list, count = null) {
    const rows = list.map(r => pick(r, q.cols));
    if (q.single === 'maybe') return rows.length > 1 ? { data: null, error: { message: 'multiple rows returned', code: 'PGRST116' } } : { data: rows[0] || null, error: null };
    if (q.single === 'one') return rows.length !== 1 ? { data: null, error: { message: 'JSON object requested, multiple (or no) rows returned', code: 'PGRST116' } } : { data: rows[0], error: null };
    return { data: rows, error: null, count };
  }
  clash(table, row, self) {
    const rows = this.tables[table];
    if (rows.some(r => r !== self && KEYS[table].every(c => r[c] != null && same(r[c], row[c])))) return duplicate(table);
    for (const u of UNIQUE[table] || []) {
      if (u.where(row) && rows.some(r => r !== self && u.where(r) && u.cols.every(c => same(r[c], row[c])))) return duplicate(table);
    }
    return null;
  }
  changed(table) {
    if (table !== 'cadetflow_state') return;
    this.writes++;
    if (this.autoNotify) this.pages.forEach(p => p.evaluate(() => window.__realtime && window.__realtime()).catch(() => {}));
  }
  /** Full access (the server function). */
  exec(q) {
    const rows = this.tables[q.table];
    if (!rows) return { data: null, error: { message: `relation "public.${q.table}" does not exist`, code: '42P01' } };
    const match = r => q.filters.every(f => passes(f, r));
    if (q.op === 'select') {
      let list = rows.filter(match);
      if (q.order) { const [c, asc] = q.order; list = list.slice().sort((a, b) => cmp(a[c], b[c]) * (asc ? 1 : -1)); }
      if (q.limit != null) list = list.slice(0, q.limit);
      if (q.head) return { data: null, count: list.length, error: null };
      return this.finish(q, list, q.count ? list.length : null);
    }
    if (q.op === 'insert' || q.op === 'upsert') {
      const out = [];
      for (const v of [].concat(q.values).map(clone)) {
        const keyCols = q.op === 'upsert' && q.onConflict ? q.onConflict.split(',').map(s => s.trim()) : KEYS[q.table];
        const existing = rows.find(r => keyCols.every(c => r[c] != null && same(r[c], v[c])));
        if (existing && q.op === 'insert') return duplicate(q.table);
        if (existing) {
          if (q.ignoreDuplicates) continue;
          const clash = this.clash(q.table, { ...existing, ...v }, existing); if (clash) return clash;
          Object.assign(existing, v); out.push(existing);
        } else {
          const row = { ...(DEFAULTS[q.table] ? DEFAULTS[q.table]() : {}), ...v };
          const clash = this.clash(q.table, row, null); if (clash) return clash;
          rows.push(row); out.push(row);
        }
      }
      if (out.length) this.changed(q.table);
      return q.returning ? this.finish(q, out) : { data: null, error: null };
    }
    if (q.op === 'update') {
      const list = rows.filter(match);
      const values = clone(q.values);
      if (q.table === 'cadetflow_state') values.updated_at = this.stamp();
      for (const r of list) { const clash = this.clash(q.table, { ...r, ...values }, r); if (clash) return clash; }
      list.forEach(r => Object.assign(r, clone(values)));
      if (list.length) this.changed(q.table);
      return q.returning ? this.finish(q, list) : { data: null, error: null };
    }
    if (q.op === 'delete') {
      const gone = rows.filter(match);
      this.tables[q.table] = rows.filter(r => !gone.includes(r));
      return q.returning ? this.finish(q, gone) : { data: null, error: null };
    }
    throw new Error('fake supabase: unknown operation ' + q.op);
  }
  /** A signed-in (or signed-out) browser: row-level security as after the launch step. */
  clientExec(q, userId) {
    if (q.table === 'cadetflow_profiles') {
      if (q.op !== 'select') return denied(q.table);
      return this.exec({ ...q, filters: [...q.filters, ['eq', 'user_id', userId || '-']] }); // own row only
    }
    if (q.table === 'cadetflow_state') {
      const level = this.accessOf(userId);
      if (q.op === 'select') return level ? this.exec(q) : this.finish(q, []);
      if (q.op === 'update') {
        if (level !== 'admin' && level !== 'writer') return q.returning ? this.finish(q, []) : { data: null, error: null };
        // The guard trigger looks at each row the update matches (none when someone else saved first).
        for (const r of this.tables.cadetflow_state.filter(r => q.filters.every(f => passes(f, r)))) {
          const why = this.guardRefuses(userId, level, r, q.values || {});
          if (why) return { data: null, error: { message: why, code: '42501' } };
        }
        return this.exec(q);
      }
      return denied(q.table);
    }
    return denied(q.table);
  }

  // ---- sign-in accounts (auth.users) -----------------------------------------------------------------
  addUser({ id, email, password = null, invited = false }) {
    const u = { id: id || 'user-' + crypto.randomUUID().slice(0, 8), email: String(email).toLowerCase(), password,
      email_confirmed_at: invited ? null : now(), invited_at: invited ? now() : null, created_at: now(), last_sign_in_at: null, user_metadata: {} };
    this.users.set(u.id, u);
    return u;
  }
  userByEmail(email) { return [...this.users.values()].find(u => u.email === String(email || '').toLowerCase()) || null; }
  publicUser(u) { const { password, ...rest } = u; return clone(rest); }
  token(userId) { return `t.${Buffer.from(userId).toString('base64url')}.s`; }
  userOfToken(token) { const m = /^t\.([^.]+)\.s$/.exec(String(token || '')); return m ? this.users.get(Buffer.from(m[1], 'base64url').toString()) || null : null; }
  /** Link in an invite / reset email: opens the site signed in, to set a password. */
  linkFor(u, type, site) { return `${site || 'https://example.test/'}#access_token=tok-${u.id}&type=${type}`; }
  signIn(email, password) {
    const u = this.userByEmail(email);
    if (!u || !u.password || u.password !== password) return { error: 'Invalid login credentials' };
    u.last_sign_in_at = now();
    return { user: { id: u.id, email: u.email } };
  }
  removeUser(id) {
    this.users.delete(id);
    this.tables.cadetflow_profiles = this.tables.cadetflow_profiles.filter(p => p.user_id !== id);            // on delete cascade
    this.tables.cadetflow_push_subscriptions = this.tables.cadetflow_push_subscriptions.filter(s => s.user_id !== id);
    this.tables.cadetflow_requests.forEach(r => { if (r.user_id === id) r.user_id = null; });                   // on delete set null
    if (this.row.updated_by === id) this.row.updated_by = null;
  }
  adminClient() {
    const ok = data => ({ data, error: null });
    const err = message => ({ data: { user: null }, error: { message } });
    return {
      from: table => queryBuilder(table, q => this.exec(q)),
      storage: {
        from: () => ({
          upload: async (p, bytes, opts = {}) => { this.files.set(p, { base64: Buffer.from(bytes).toString('base64'), contentType: opts.contentType || 'image/png', created_at: now() }); return ok({ path: p }); },
          remove: async list => { list.forEach(p => this.files.delete(p)); return ok(list.map(name => ({ name }))); },
          createSignedUrl: async p => {
            const f = this.files.get(p);
            return f ? ok({ signedUrl: `data:${f.contentType};base64,${f.base64}` }) : { data: null, error: { message: 'Object not found' } };
          },
          list: async prefix => ok([...this.files].filter(([k]) => k.startsWith(prefix + '/')).map(([k, f]) => ({ name: k.slice(prefix.length + 1), created_at: f.created_at }))),
        }),
      },
      auth: {
        getUser: async token => { const u = this.userOfToken(token); return u ? ok({ user: this.publicUser(u) }) : err('invalid JWT'); },
        resetPasswordForEmail: async (email, { redirectTo } = {}) => {
          if (!this.mailWorks) return { data: null, error: { message: 'Error sending recovery email' } };
          const u = this.userByEmail(email);
          if (u) this.mails.push({ type: 'recovery', email: u.email, link: this.linkFor(u, 'recovery', redirectTo) });
          return ok({});
        },
        admin: {
          createUser: async ({ email, password }) => {
            if (this.userByEmail(email)) return err('A user with this email address has already been registered');
            return ok({ user: this.publicUser(this.addUser({ email, password })) });
          },
          inviteUserByEmail: async (email, { redirectTo } = {}) => {
            if (this.userByEmail(email)) return err('A user with this email address has already been registered');
            if (!this.mailWorks) return err('Error sending invite email');
            const u = this.addUser({ email, invited: true });
            this.mails.push({ type: 'invite', email: u.email, link: this.linkFor(u, 'invite', redirectTo) });
            return ok({ user: this.publicUser(u) });
          },
          generateLink: async ({ type, email, options = {} }) => {
            // Tests: something that happens just before the link is made (someone registering this email meanwhile)
            if (this.beforeInviteLink && type === 'invite') { const f = this.beforeInviteLink; this.beforeInviteLink = null; f(email); }
            let u = this.userByEmail(email);
            if (type === 'invite') { if (u) return { data: null, error: { message: 'A user with this email address has already been registered' } }; u = this.addUser({ email, invited: true }); }
            else if (!u) return { data: null, error: { message: 'User not found' } };
            return ok({ properties: { action_link: this.linkFor(u, type, options.redirectTo) }, user: this.publicUser(u) });
          },
          getUserById: async id => { const u = this.users.get(id); return u ? ok({ user: this.publicUser(u) }) : err('User not found'); },
          listUsers: async ({ page = 1, perPage = 50 } = {}) => ok({ users: [...this.users.values()].slice((page - 1) * perPage, page * perPage).map(u => this.publicUser(u)) }),
          updateUserById: async (id, { password }) => {
            const u = this.users.get(id); if (!u) return err('User not found');
            if (password) u.password = password;
            return ok({ user: this.publicUser(u) });
          },
          deleteUser: async id => { if (!this.users.has(id)) return err('User not found'); this.removeUser(id); return ok({}); },
        },
      },
    };
  }

  // ---- the browser side (called through page.exposeFunction) ------------------------------------------
  async callFunction(name, body, userId) {
    if (name !== 'cadetflow-api') return { status: 404, body: { error: 'Function not found' } };
    if (this.functionDown) return { network: true };
    if (!this.server) this.server = loadServer(this);
    const handler = await this.server;
    globalThis.__cadetflowBackend = this;
    const res = await handler(new Request('https://fake.supabase.test/functions/v1/cadetflow-api', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'CadetFlow test', Authorization: `Bearer ${userId ? this.token(userId) : 'publishable-key'}` },
      body: JSON.stringify(body ?? {}),
    }));
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    this.calls.push({ action: body?.action, userId, status: res.status, error: res.status >= 400 ? data?.error : undefined });
    return { status: res.status, body: data };
  }
  /** Call the server directly from the test (as `userId`); throws on an error answer. */
  async api(userId, action, body = {}) {
    const r = await this.callFunction('cadetflow-api', { ...body, action }, userId);
    if (r.status >= 400) { const e = new Error(r.body?.error || 'status ' + r.status); e.status = r.status; throw e; }
    return r.body;
  }
  authCall(op, args) {
    if (op === 'signIn') return this.signIn(args.email, args.password);
    if (op === 'getUser') { const u = this.users.get(args.id); return u ? { user: { id: u.id, email: u.email } } : { error: 'User not found' }; }
    if (op === 'updateUser') {
      const u = this.users.get(args.userId); if (!u) return { error: 'User not found' };
      if (args.password) { u.password = args.password; u.email_confirmed_at = u.email_confirmed_at || now(); u.last_sign_in_at = u.last_sign_in_at || now(); }
      return { user: { id: u.id, email: u.email } };
    }
    return { error: 'unknown auth call ' + op };
  }
}

module.exports = { Backend, clone };
