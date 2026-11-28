// Offline support: app shell cached; data fetched fresh when online, cached copy when not.
const CACHE = 'tal-v11';
const SHELL = ['./', 'index.html', 'style.css?v=11', 'app.js?v=11', 'manifest.webmanifest', 'icons/icon-180.png', 'icons/icon-192.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))); self.clients.claim(); });
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  // network first for everything (fresh data and code), cache as fallback
  e.respondWith(fetch(e.request.mode === 'navigate' ? e.request : new Request(e.request, { cache: 'no-cache' })).then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return r; })
    .catch(() => caches.match(e.request, { ignoreSearch: true })));
});
