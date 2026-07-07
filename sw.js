/* Offline cache so SoundLab installs as a PWA and works with no network.
 *
 * Update strategy: stale-while-revalidate. A visitor gets the cached copy instantly
 * (and offline), while the SW quietly refetches in the background so the *next* load
 * has the newest files. That means pushing new code propagates on its own — no need
 * to hand-edit this list on every deploy. Still bump CACHE when you want to force a
 * clean wipe of old entries. */
// Key the cache to the deployed version, so every push lands in a fresh cache and
// old entries are dropped on activate. version.js is fetched fresh during SW update,
// so a new deploy is detected and installed automatically.
importScripts('./version.js');
const CACHE = 'soundlab-' + (self.__APP_VERSION__ || 'dev');
const ASSETS = [
  './',
  './index.html',
  './app.js',
  './version.js',
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

  // The version stamp must be accurate the instant you open the page after a deploy,
  // so fetch it network-first (fall back to cache only when offline).
  if (new URL(req.url).pathname.endsWith('/version.js')) {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

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
