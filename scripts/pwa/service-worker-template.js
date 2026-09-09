/**
 * Service worker source TEMPLATE — never shipped as-is.
 *
 * Transformed into dist/sw.js at build time by the `pwaBuild` Vite plugin
 * (see vite.config.ts): `__BUILD_ID__` becomes a content hash of the actual
 * built assets, and `__PRECACHE_URLS__` becomes the real list of hashed
 * asset URLs for this build. Both substitutions guarantee sw.js's own bytes
 * change whenever the app's assets change — required for the browser's
 * update check (a byte-identical sw.js across deploys is treated as "no
 * update", so the old cache would otherwise never be replaced).
 *
 * No bundler PWA plugin is used here (network policy in some deployment/dev
 * environments blocks installing new npm packages from a private registry
 * mirror) — this hand-rolled worker is deliberately simple and explicit
 * instead: no cross-origin caching, no interference with API/widget/call
 * traffic, and a clear, single caching rule per request category.
 */
const CACHE_NAME = 'app-shell-__BUILD_ID__';
const PRECACHE_URLS = __PRECACHE_URLS__;
const OFFLINE_FALLBACK_URL = '/index.html';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      // Move to "installed, waiting to activate" immediately; the client
      // decides when to actually hand control over (see the SKIP_WAITING
      // message handler below), so an already-open tab is never yanked out
      // from under a mid-conversation operator without their say-so.
      .catch(() => undefined),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

/**
 * Only same-origin GET requests for the app shell/static assets are ever
 * intercepted. Everything else (API calls, the live-chat/call widget embed
 * scripts, cross-origin requests, the runtime-config.js deployment file)
 * must always reach the network untouched and uncached.
 */
function shouldHandle(request) {
  if (request.method !== 'GET') return false;
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return false;
  }
  if (url.origin !== self.location.origin) return false;
  if (url.pathname.startsWith('/api/')) return false;
  if (url.pathname.startsWith('/widget/')) return false;
  if (url.pathname.startsWith('/call-widget/')) return false;
  if (url.pathname === '/runtime-config.js') return false;
  return true;
}

function putInCache(request, response) {
  const copy = response.clone();
  caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
  return response;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (!shouldHandle(request)) return;

  // SPA navigations: network-first, so a signed-in user always gets a live
  // page when online; falls back to the cached shell (client-side router
  // resolves the actual route from there) only when the network is down.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match(OFFLINE_FALLBACK_URL)),
    );
    return;
  }

  const path = new URL(request.url).pathname;

  // Hashed, content-addressed build assets never change for a given
  // filename -- cache-first, with a network fetch (cached for next time)
  // only on a genuine miss.
  if (path.startsWith('/assets/')) {
    event.respondWith(
      caches.match(request).then((cached) => cached || fetch(request).then((res) => putInCache(request, res))),
    );
    return;
  }

  // Everything else same-origin (icons, fonts, root document, ...):
  // stale-while-revalidate -- instant from cache when available, while a
  // background fetch keeps the cache fresh for the next load.
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((res) => putInCache(request, res))
        .catch(() => cached);
      return cached || network;
    }),
  );
});

// The client sends this once the operator has actually chosen to reload
// (see src/lib/pwa.ts) -- an update is applied on demand, never silently
// mid-session, since an unannounced reload could drop an in-progress
// operator reply or visitor conversation state.
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
