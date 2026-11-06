// In-page stand-in for supabase-js, used only by the automated tests.
// Every database call is forwarded to a fake database living in the test process
// (window.__db), so several browser pages can share one "server" and save at the same time.
(() => {
  const user = window.__testUser || null; // { id, email } or null for a visitor
  const session = user ? { user: { id: user.id, email: user.email, user_metadata: {} } } : null;
  const channels = [];
  window.__realtime = () => channels.forEach(c => c.cb && c.cb({ eventType: 'UPDATE' }));

  function query(table) {
    const q = { table, op: 'select', values: null, filters: [] };
    const builder = {
      select() { return builder; },
      update(values) { q.op = 'update'; q.values = values; return builder; },
      eq(column, value) { q.filters.push(['eq', column, value]); return builder; },
      is(column, value) { q.filters.push(['is', column, value]); return builder; },
      maybeSingle() { return window.__db(q); },
      then(resolve, reject) { return window.__db(q).then(resolve, reject); }
    };
    return builder;
  }

  window.supabase = {
    createClient() {
      return {
        auth: {
          onAuthStateChange(cb) { setTimeout(() => cb('INITIAL_SESSION', session), 0); return { data: { subscription: { unsubscribe() {} } } }; },
          signInWithPassword: async () => ({ error: null }),
          signOut: async () => ({ error: null })
        },
        from: query,
        // Edge functions: tests set window.__fn(name, body, user) to fake them; default does nothing.
        functions: {
          async invoke(name, { body } = {}) {
            const data = window.__fn ? await window.__fn(name, body, user) : { sent: 0 };
            return data && data.__error ? { data: null, error: { message: data.__error } } : { data, error: null };
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
