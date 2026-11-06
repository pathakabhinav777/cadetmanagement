// CadetFlow service worker: makes the site installable and lets it open without a connection.
// - The page itself is fetched from the network first, so every push to GitHub shows up straight
//   away; the saved copy is used only when offline.
// - Libraries and fonts from CDNs are served from the cache and refreshed in the background.
// - Supabase (data and sign-in) is never cached.
const VERSION = 'cadetflow-v2';
const SHELL = ['./', './index.html', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png', './icons/favicon-48.png'];
const CDN_HOSTS = ['cdn.jsdelivr.net', 'cdn.tailwindcss.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(VERSION).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    // Network first: fresh page when online, saved copy when offline. `no-cache` asks GitHub
    // whether the page changed (cheap when it hasn't) instead of trusting its 10-minute cache.
    event.respondWith(
      fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' })
        .then(res => {
          if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); }
          return res;
        })
        .catch(() => caches.match(req, { ignoreSearch: true })
          .then(hit => hit || (req.mode === 'navigate' ? caches.match('./index.html') : Response.error())))
    );
    return;
  }

  if (CDN_HOSTS.includes(url.hostname)) {
    // Cache first, refresh in the background.
    event.respondWith(
      caches.open(VERSION).then(cache => cache.match(req).then(hit => {
        const fresh = fetch(req)
          .then(res => { if (res.ok || res.type === 'opaque') cache.put(req, res.clone()); return res; })
          .catch(() => hit || Response.error());
        return hit || fresh;
      }))
    );
  }
  // Everything else (Supabase etc.) goes straight to the network.
});
