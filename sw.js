/* Offline cache so SoundLab installs as a PWA and works with no network.
 *
 * Update strategy: stale-while-revalidate. A visitor gets the cached copy instantly
 * (and offline), while the SW quietly refetches in the background so the *next* load
 * has the newest files. That means pushing new code propagates on its own — no need
 * to hand-edit this list on every deploy. Still bump CACHE when you want to force a
 * clean wipe of old entries. */
const CACHE = 'soundlab-v2';
const ASSETS = [
  './',
  './index.html',
  './app.js',
  './manifest.webmanifest',
  './icon.svg',
  './icon-180.png',
  './icon-192.png',
  './icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  // Only handle same-origin GETs; let everything else hit the network normally.
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  e.respondWith(
    caches.open(CACHE).then((cache) =>
      cache.match(req).then((cached) => {
        const network = fetch(req)
          .then((res) => {
            if (res && res.ok) cache.put(req, res.clone());
            return res;
          })
          .catch(() => cached); // offline: fall back to whatever we have
        return cached || network;
      })
    )
  );
});
