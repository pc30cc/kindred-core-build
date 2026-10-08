/**
 * Prefetching page code before it is needed (pages are split out by
 * src/lib/perf/lazyPage.tsx). Two triggers, both only download — nothing runs
 * until the page is opened:
 *
 *  - idle: a while after the app has loaded, for a signed-in user, the pages
 *    almost every session opens (inbox, contacts, dashboard) — see
 *    RoutePrefetcher in App.tsx — and then the rest of this build's files
 *    into the service worker's cache (warmServiceWorkerCache);
 *  - intent: pointing at or focusing a link to a page starts its download,
 *    usually 100-300 ms before the click lands. One delegated listener on the
 *    document covers every menu (Classic, Art's top menu and side menu, the
 *    admin menu) without those components knowing about it.
 *
 * Both stand down when the browser asks to save data, the connection is 2G,
 * or the browser is offline: a page file that fails to download is remembered
 * as failed for the life of the page (see src/lib/perf/chunkReload.ts), so a
 * speculative download during a drop would only make the page fail later.
 */

export type PreloadFn = () => Promise<void>;

interface NetworkInformationLike {
  saveData?: boolean;
  effectiveType?: string;
}

/** False offline, on Save-Data and on 2G connections, where speculative downloads hurt. */
export function canPrefetch(nav: Navigator | undefined = typeof navigator !== 'undefined' ? navigator : undefined): boolean {
  if (nav?.onLine === false) return false;
  const connection = (nav as (Navigator & { connection?: NetworkInformationLike }) | undefined)?.connection;
  if (!connection) return true;
  if (connection.saveData) return false;
  return !/(?:^|-)2g$/.test(connection.effectiveType ?? '');
}

/**
 * Runs `callback` once the page has finished loading, `delayMs` has passed
 * and the main thread is idle (setTimeout where requestIdleCallback is
 * missing, e.g. Safari). Returns a cancel function.
 */
export function afterLoadWhenIdle(callback: () => void, delayMs = 1500): () => void {
  if (typeof window === 'undefined') return () => {};
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let idle: number | undefined;

  const schedule = () => {
    if (cancelled) return;
    timer = setTimeout(() => {
      if (cancelled) return;
      if (typeof requestIdleCallback === 'function') {
        idle = requestIdleCallback(() => { if (!cancelled) callback(); }, { timeout: 4000 });
      } else {
        callback();
      }
    }, delayMs);
  };

  if (document.readyState === 'complete') schedule();
  else window.addEventListener('load', schedule, { once: true });

  return () => {
    cancelled = true;
    window.removeEventListener('load', schedule);
    if (timer !== undefined) clearTimeout(timer);
    if (idle !== undefined && typeof cancelIdleCallback === 'function') cancelIdleCallback(idle);
  };
}

/**
 * Prefetches the page behind a same-origin link when the pointer moves onto
 * it or it receives focus. `resolve` maps a pathname to the preloads of the
 * page(s) it opens (an empty list for anything else). Returns a remover.
 */
export function installLinkPrefetch(
  resolve: (pathname: string) => readonly { preload: PreloadFn }[],
  doc: Document = document,
): () => void {
  const view = doc.defaultView;
  if (!view) return () => {};
  const done = new Set<string>();

  const onIntent = (event: Event) => {
    const target = event.target;
    if (!(target instanceof view.Element)) return;
    const anchor = target.closest('a[href]');
    if (!(anchor instanceof view.HTMLAnchorElement)) return;
    if (anchor.target && anchor.target !== '_self') return;
    if (anchor.hasAttribute('download')) return;

    let url: URL;
    try {
      url = new URL(anchor.href, view.location.href);
    } catch {
      return;
    }
    if (url.origin !== view.location.origin) return;
    if (done.has(url.pathname)) return;
    done.add(url.pathname);
    if (!canPrefetch(view.navigator)) return;
    for (const page of resolve(url.pathname)) void page.preload();
  };

  doc.addEventListener('pointerover', onIntent, { passive: true });
  doc.addEventListener('focusin', onIntent);
  return () => {
    doc.removeEventListener('pointerover', onIntent);
    doc.removeEventListener('focusin', onIntent);
  };
}

/** The message scripts/pwa/service-worker-template.js answers by caching LAZY_URLS. */
export const WARM_CACHE_MESSAGE = 'WARM_CACHE';

/**
 * Asks the service worker to download the rest of this build's files (every
 * page) into its cache, a few at a time, skipping what it already has. Two
 * gains: every later page opens from the cache, and a tab that stays open
 * across a deploy keeps finding its own build's page files there after the
 * server has replaced them (src/lib/perf/chunkReload.ts), as it did when the
 * whole app was precached at install. Nothing happens without a service
 * worker (development, the native app, unsupported browsers).
 */
export function warmServiceWorkerCache(
  nav: Navigator | undefined = typeof navigator !== 'undefined' ? navigator : undefined,
): void {
  const container = nav && 'serviceWorker' in nav ? nav.serviceWorker : undefined;
  if (!container || !canPrefetch(nav)) return;
  // `ready` waits for an active worker (on a first visit it is still
  // installing) and stays pending where none is registered.
  container.ready
    .then((registration) => registration.active?.postMessage(WARM_CACHE_MESSAGE))
    .catch(() => {});
}
