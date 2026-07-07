/* Offline cache so SoundLab installs as a PWA and works with no network.
 *
 * Update strategy:
 *   - App shell (HTML document + all .js): network-first, so a fresh deploy shows on
 *     the next load and markup never desyncs from its scripts; cache is offline only.
 *   - Icons / manifest: stale-while-revalidate — instant from cache, refreshed in bg.
 * The cache name is keyed to the deployed version, so each deploy wipes old entries. */
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

// Network-first: fetch fresh, cache the result, fall back to cache only when offline.
// Used for the HTML shell and version.js so a new deploy shows up on the very next
// load instead of a load later.
function networkFirst(req) {
  return fetch(req)
    .then((res) => {
      if (res && res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
      }
      return res;
    })
    .catch(() => caches.match(req).then((c) => c || caches.match('./index.html')));
}

// Stale-while-revalidate: serve cache instantly, refresh in the background.
function staleWhileRevalidate(req) {
  return caches.open(CACHE).then((cache) =>
    cache.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok) cache.put(req, res.clone());
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  // Only handle same-origin GETs; let everything else hit the network normally.
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  // The app shell — the HTML document and ALL scripts — is network-first so the
  // markup and its JS can never come from different deploys (that desync made new
  // buttons appear with stale handlers). Images/manifest stay stale-while-revalidate.
  const path = new URL(req.url).pathname;
  const isShell = req.mode === 'navigate' || path.endsWith('.js');
  e.respondWith(isShell ? networkFirst(req) : staleWhileRevalidate(req));
});
