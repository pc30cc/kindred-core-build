/**
 * Recovery from a page chunk that cannot be loaded.
 *
 * Pages are separate JS files with content hashes in their names (see
 * src/App.tsx and src/lib/perf/lazyPage.tsx). Two things make `import()` of
 * one fail:
 *  - a deploy: a tab opened before it still runs the old entry script, which
 *    asks for the OLD page files, and the new image no longer has them;
 *  - the network: a page file (or one it imports) failed to download, e.g.
 *    a prefetch during a Wi-Fi drop. Browsers remember a failed module for
 *    the life of the page (Chromium keeps the failure in its module map and
 *    never requests that URL again), so every later `import()` of it fails
 *    at once, even after the connection is back.
 * Either way only loading the page again cures it: one automatic reload.
 *
 * Usually it never comes to that: the service worker keeps this build's page
 * files (it fills its cache in the background, see warmServiceWorkerCache in
 * src/lib/perf/prefetch.ts), so an old tab goes on opening its own pages
 * after a deploy, as it did when the app was one file; and prefetching stands
 * down while the browser is offline (canPrefetch).
 *
 * The reload happens only when all of these hold (confirmStaleBuild):
 *  - the browser is online. Offline, a reload could land on the browser's
 *    own offline page, so the page area shows "try again" instead;
 *  - nothing live would be cut off: no microphone, camera or screen capture
 *    is running in this tab (an operator's call keeps going across
 *    navigations, see trackMediaCapture);
 *  - this tab has not already reloaded for a missing chunk within the last
 *    CHUNK_RELOAD_WINDOW_MS (sessionStorage survives the reload). A second
 *    failure inside that window (a broken deploy) shows "try again" instead
 *    of reloading in a loop. Without sessionStorage there is no guard, so
 *    there is no automatic reload either.
 *
 * Only route-level page loads use this (lazyPage). At that moment the
 * previous page has already been replaced by the loading state, so reloading
 * loses nothing the navigation had not already left behind. Lazy imports
 * inside a page (a dialog, the realtime client) are NOT wired to it: an
 * unannounced reload there could drop an operator's half-written reply.
 */

export const CHUNK_RELOAD_KEY = 'wy:chunk-reload-at';
export const CHUNK_RELOAD_WINDOW_MS = 60_000;

const CHUNK_ERROR_PATTERNS: readonly RegExp[] = [
  /Failed to fetch dynamically imported module/i, // Chromium
  /error loading dynamically imported module/i, // Firefox
  /Importing a module script failed/i, // Safari
  /Unable to preload CSS/i, // Vite's preload helper (a page's stylesheet)
  /Loading (?:CSS )?chunk [\w-]+ failed/i, // other bundlers' wording
];

/** True for the errors a missing or unreachable JS/CSS chunk produces. */
export function isChunkLoadError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { name, message } = error as { name?: unknown; message?: unknown };
  if (name === 'ChunkLoadError') return true;
  if (typeof message !== 'string') return false;
  return CHUNK_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

export interface ChunkReloadEnv {
  /** sessionStorage, or null where it is unavailable (privacy modes). */
  storage: Pick<Storage, 'getItem' | 'setItem'> | null;
  now: () => number;
  reload: () => void;
  /**
   * Resolves true when a reload is safe right now (see the list above).
   * Left out, a reload is always allowed.
   */
  confirm?: () => Promise<boolean>;
}

function browserEnv(): ChunkReloadEnv {
  let storage: ChunkReloadEnv['storage'] = null;
  try {
    storage = typeof window !== 'undefined' ? window.sessionStorage : null;
  } catch {
    storage = null;
  }
  return {
    storage,
    now: () => Date.now(),
    reload: () => window.location.reload(),
    confirm: () => confirmStaleBuild(),
  };
}

// ─── Is a reload safe and useful? ─────────────────────────────────────────

const capturedStreams = new Set<MediaStream>();
let captureTracked = false;

type CaptureMethod = (...args: unknown[]) => Promise<MediaStream>;

/**
 * Notes every camera, microphone and screen stream this tab opens, so that
 * hasLiveMediaCapture() can tell whether one is still running. Installed
 * once at start-up (src/App.tsx), before any call can begin. The browser's
 * own method still does all the work and its promise is handed back as is:
 * callers (LiveKit, the voice recorder) see no difference.
 */
export function trackMediaCapture(
  media: MediaDevices | undefined = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined,
): void {
  if (captureTracked || !media) return;
  captureTracked = true;
  for (const method of ['getUserMedia', 'getDisplayMedia'] as const) {
    const original = media[method] as unknown as CaptureMethod | undefined;
    if (typeof original !== 'function') continue;
    const tracked: CaptureMethod = (...args) => {
      const result = original.apply(media, args);
      if (result && typeof result.then === 'function') {
        result.then((stream) => {
          if (stream && typeof stream.getTracks === 'function') {
            hasLiveMediaCapture(); // drops streams that have ended, so the set stays small
            capturedStreams.add(stream);
          }
        }, () => {});
      }
      return result;
    };
    try {
      Object.defineProperty(media, method, { value: tracked, configurable: true, writable: true });
    } catch {
      // Not replaceable in this browser: no tracking, and no other change.
    }
  }
}

/** True while a stream opened through trackMediaCapture still has a live track. */
export function hasLiveMediaCapture(): boolean {
  for (const stream of capturedStreams) {
    if (stream.getTracks().some((track) => track.readyState === 'live')) return true;
    capturedStreams.delete(stream);
  }
  return false;
}

/** The browser's answer to ChunkReloadEnv.confirm: see the list at the top. */
export async function confirmStaleBuild(): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return false;
  return !hasLiveMediaCapture();
}

/**
 * Reloads the page unless this tab already did so for a missing chunk within
 * the last CHUNK_RELOAD_WINDOW_MS. Returns true when a reload was started.
 */
export function reloadOnceForStaleChunk(env: ChunkReloadEnv = browserEnv()): boolean {
  const { storage } = env;
  if (!storage) return false;
  try {
    const now = env.now();
    const last = Number(storage.getItem(CHUNK_RELOAD_KEY));
    // `abs`: a clock that moved backwards must not open the gate again.
    if (Number.isFinite(last) && last > 0 && Math.abs(now - last) < CHUNK_RELOAD_WINDOW_MS) {
      return false;
    }
    storage.setItem(CHUNK_RELOAD_KEY, String(now));
  } catch {
    return false;
  }
  env.reload();
  return true;
}

/**
 * Runs `load`; when it fails because a chunk could not be loaded, and a
 * reload is confirmed (see above), reloads the page once and keeps the
 * returned promise pending, so the loading state stays up until the new page
 * replaces it. Any other failure, an unconfirmed one, and a second chunk
 * failure inside the window reject as before (the page area then offers
 * "try again").
 */
export function loadWithChunkRecovery<T>(
  load: () => Promise<T>,
  env?: ChunkReloadEnv,
): Promise<T> {
  return load().catch(async (error: unknown) => {
    if (!isChunkLoadError(error)) throw error;
    const active = env ?? browserEnv();
    let confirmed = false;
    try {
      confirmed = active.confirm ? await active.confirm() : true;
    } catch {
      confirmed = false;
    }
    if (confirmed && reloadOnceForStaleChunk(active)) return new Promise<T>(() => {});
    throw error;
  });
}
