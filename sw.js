// sw.js — keeps the app shell available offline; live data (APIs) always goes to the network
const CACHE = 'giq-v2';
const SHELL = ['./', 'index.html', 'styles.css', 'design.css', 'app.js', 'engine.js', 'games.js', 'props.js', 'espn.js', 'manifest.webmanifest', 'icons/icon-192.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/espn/') || url.pathname.startsWith('/api/')) return;
  // network first so updates show up immediately; cache is the offline fallback
  e.respondWith(
    fetch(e.request)
      .then(res => { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return res; })
      .catch(() => caches.match(e.request).then(r => r || caches.match('./'))),
  );
});
