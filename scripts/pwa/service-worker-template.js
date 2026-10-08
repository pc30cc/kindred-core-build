/**
 * Service worker source TEMPLATE — never shipped as-is.
 *
 * Transformed into dist/sw.js at build time by the `pwaBuild` Vite plugin
 * (see vite.config.ts): `__BUILD_ID__` becomes a content hash of the actual
 * built assets, `__PRECACHE_URLS__` becomes the real list of hashed
 * asset URLs the app starts with (precached at install) and `__LAZY_URLS__`
 * the rest of this build's files (each page's own file), cached on request
 * (WARM_CACHE, below). Both substitutions guarantee sw.js's own bytes
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
const LAZY_URLS = __LAZY_URLS__;
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
  // An explicit "no-store" fetch asks for the server's current answer: never
  // a cached one. The app's check for a new deploy relies on it
  // (newBuildDeployed in src/lib/perf/chunkReload.ts).
  if (request.cache === 'no-store') return false;
  return true;
}

// Only complete, same-origin successes are kept. A 404 for a page file that
// a deploy removed, or a 5xx while the container restarts, must not be
// stored: under /assets/ the cache is read first, so a stored failure would
// be served for the rest of this worker's life.
function putInCache(request, response) {
  if (!response || !response.ok || response.type !== 'basic') return response;
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
  // only on a genuine miss. Only the app's core is precached at install
  // (vite.config.ts, pwaBuild); each page file lands here the first time
  // it is opened or prefetched.
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

/**
 * Downloads this build's remaining files (LAZY_URLS: one per page) into the
 * cache, three at a time, skipping any already there. Asked for by the app
 * once it is idle (warmServiceWorkerCache in src/lib/perf/prefetch.ts).
 *
 * Besides making every later page open from the cache, this is what keeps a
 * tab that stays open across a deploy working: until the operator applies
 * the update, this worker stays in control of that tab and keeps answering
 * its requests for its own build's page files from here, after the server
 * has replaced them. A file that fails is skipped (and fetched on use); a
 * worker stopped half-way resumes at the next request.
 */
let warming = null;
function warmCache() {
  if (!warming) {
    warming = caches.open(CACHE_NAME).then((cache) => {
      const queue = LAZY_URLS.slice();
      const next = () => {
        const url = queue.shift();
        if (!url) return undefined;
        return cache
          .match(url)
          .then((cached) => cached || fetch(url, { credentials: 'same-origin' }).then((res) => {
            if (res.ok && res.type === 'basic') return cache.put(url, res);
            return undefined;
          }))
          .catch(() => undefined)
          .then(next);
      };
      return Promise.all([next(), next(), next()]);
    }).catch(() => {
      warming = null;
    });
  }
  return warming;
}

// SKIP_WAITING: the client sends this once the operator has actually chosen
// to reload (see src/lib/pwa.ts) -- an update is applied on demand, never
// silently mid-session, since an unannounced reload could drop an
// in-progress operator reply or visitor conversation state.
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
  else if (event.data === 'WARM_CACHE') event.waitUntil(warmCache());
});
