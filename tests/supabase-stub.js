// In-page stand-in for supabase-js, used only by the automated tests.
// Database calls, sign-in and the server function are forwarded to the in-memory backend living
// in the test process (tests/fake-supabase.cjs) through window.__db, window.__auth and window.__fn,
// so several browser pages can share one "Supabase" and save at the same time.
(() => {
  const KEY = '__stub_session';
  // An invite / reset link opens the site signed in (#access_token=tok-<user id>&type=...).
  const linkUser = (() => { const t = new URLSearchParams(location.hash.slice(1)).get('access_token'); return t && t.startsWith('tok-') ? t.slice(4) : null; })();
  let stored;
  try { stored = JSON.parse(localStorage.getItem(KEY) || 'undefined'); } catch (_) { stored = undefined; }
  let user = stored !== undefined ? stored : (window.__testUser || null); // { id, email } or null
  const listeners = [];
  const channels = [];
  window.__realtime = () => channels.forEach(c => c.cb && c.cb({ eventType: 'UPDATE' }));
  const sessionOf = u => (u ? { user: { id: u.id, email: u.email, user_metadata: {} }, access_token: 'tok-' + u.id } : null);
  const remember = () => { try { localStorage.setItem(KEY, JSON.stringify(user)); } catch (_) {} };
  const emit = event => listeners.forEach(cb => setTimeout(() => cb(event, sessionOf(user)), 0));

  const ready = (async () => {
    if (!linkUser) return;
    const r = await window.__auth('getUser', { id: linkUser });
    if (r.user) { user = r.user; remember(); }
  })();

  function query(table) {
    const q = { table, op: 'select', cols: '*', values: null, filters: [], order: null, limit: null, returning: false,
      count: null, head: false, single: null, onConflict: null, ignoreDuplicates: false };
    const run = () => window.__db(q, user ? user.id : null);
    const b = {
      select(cols = '*', opts = {}) {
        if (q.op === 'select') { q.cols = cols; q.count = opts.count || null; q.head = !!opts.head; } else { q.returning = true; q.cols = cols; }
        return b;
      },
      insert(v) { q.op = 'insert'; q.values = v; return b; },
      upsert(v, o = {}) { q.op = 'upsert'; q.values = v; q.onConflict = o.onConflict || null; q.ignoreDuplicates = !!o.ignoreDuplicates; return b; },
      update(v) { q.op = 'update'; q.values = v; return b; },
      delete() { q.op = 'delete'; return b; },
      eq(c, v) { q.filters.push(['eq', c, v]); return b; },
      neq(c, v) { q.filters.push(['neq', c, v]); return b; },
      is(c, v) { q.filters.push(['is', c, v]); return b; },
      in(c, v) { q.filters.push(['in', c, v]); return b; },
      gte(c, v) { q.filters.push(['gte', c, v]); return b; },
      order(c, o = {}) { q.order = [c, o.ascending !== false]; return b; },
      limit(n) { q.limit = n; return b; },
      maybeSingle() { q.single = 'maybe'; return run(); },
      single() { q.single = 'one'; return run(); },
      then(resolve, reject) { return run().then(resolve, reject); }
    };
    return b;
  }

  window.supabase = {
    createClient() {
      // Like supabase-js, take the token out of the address once it has been read.
      if (linkUser) setTimeout(() => history.replaceState(null, '', location.pathname + location.search), 0);
      return {
        auth: {
          onAuthStateChange(cb) {
            listeners.push(cb);
            ready.then(() => setTimeout(() => cb('INITIAL_SESSION', sessionOf(user)), 0));
            return { data: { subscription: { unsubscribe() { const i = listeners.indexOf(cb); if (i >= 0) listeners.splice(i, 1); } } } };
          },
          async signInWithPassword({ email, password }) {
            const r = await window.__auth('signIn', { email, password });
            if (r.error) return { data: { user: null, session: null }, error: { message: r.error, status: 400 } };
            user = r.user; remember(); emit('SIGNED_IN');
            return { data: { user: r.user, session: sessionOf(user) }, error: null };
          },
          async signOut() { user = null; remember(); emit('SIGNED_OUT'); return { error: null }; },
          async updateUser({ password } = {}) {
            if (!user) return { data: { user: null }, error: { message: 'Auth session missing!' } };
            const r = await window.__auth('updateUser', { userId: user.id, password });
            if (r.error) return { data: { user: null }, error: { message: r.error } };
            emit('USER_UPDATED');
            return { data: { user: r.user }, error: null };
          },
          async getSession() { return { data: { session: sessionOf(user) }, error: null }; }
        },
        from: query,
        functions: {
          async invoke(name, { body } = {}) {
            const r = await window.__fn(name, body ?? {}, user ? user.id : null);
            if (r.network) return { data: null, error: { name: 'FunctionsFetchError', message: 'Failed to send a request to the Edge Function' } };
            if (r.status >= 200 && r.status < 300) return { data: r.body, error: null };
            return { data: null, error: { name: 'FunctionsHttpError', message: 'Edge Function returned a non-2xx status code', context: { status: r.status, json: async () => r.body } } };
          }
        },
        channel() {
          const ch = { cb: null, on(_type, _filter, cb) { ch.cb = cb; return ch; }, subscribe() { channels.push(ch); return ch; } };
          return ch;
        },
        removeChannel(ch) { const i = channels.indexOf(ch); if (i >= 0) channels.splice(i, 1); }
      };
    }
  };
})();
