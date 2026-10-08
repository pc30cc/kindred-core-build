/**
 * Route-level code splitting (src/App.tsx, src/lib/perf/lazyPage.tsx) and the
 * stale-chunk reload guard (src/lib/perf/chunkReload.ts).
 *
 * The route table itself is asserted on its source text, like the other
 * route tests (src/test/ai-agent/advancedRouteAccessPolicy.test.ts): which
 * pages are lazy is a static composition fact of App.tsx, and mounting the
 * whole provider stack would add nothing to it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  CHUNK_RELOAD_KEY,
  CHUNK_RELOAD_WINDOW_MS,
  confirmStaleBuild,
  hasLiveMediaCapture,
  isChunkLoadError,
  loadWithChunkRecovery,
  reloadOnceForStaleChunk,
  trackMediaCapture,
  type ChunkReloadEnv,
} from '@/lib/perf/chunkReload';

const APP = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf8');
const MAIN = readFileSync(resolve(process.cwd(), 'src/main.tsx'), 'utf8');

const ROUTES = APP.slice(APP.indexOf('<Routes>'), APP.lastIndexOf('</Routes>'));
/** Every component a route renders (JSX tags inside <Routes>). */
const ROUTE_COMPONENTS = new Set([...ROUTES.matchAll(/<([A-Z][A-Za-z0-9]*)\b/g)].map((m) => m[1]));
/** `const X = lazyPage(() => import("module")...` → X → module. */
const LAZY = new Map(
  [...APP.matchAll(/^const (\w+) = lazyPage\(\s*\(\) => import\("([^"]+)"\)/gm)].map((m) => [m[1], m[2]]),
);

const isPage = (name: string) => name.endsWith('Page') || name === 'NotFound';

describe('pages are split out of the main bundle', () => {
  it('imports no page module statically', () => {
    expect(APP).not.toMatch(/^import\s+\w+\s+from\s+["']@\/pages\//m);
    expect(APP).not.toMatch(/from\s+["']@\/pages\//);
    expect(APP).not.toMatch(/from\s+["']@\/mobile\//);
  });

  it('declares every page a route renders with lazyPage', () => {
    const pages = [...ROUTE_COMPONENTS].filter(isPage);
    expect(pages.length).toBeGreaterThan(100);
    const eager = pages.filter((name) => !LAZY.has(name));
    expect(eager).toEqual([]);
  });

  it('points every lazy page at a page module', () => {
    for (const [name, module] of LAZY) {
      if (name === 'MobileRoutes') expect(module).toBe('@/mobile/MobileRoutes');
      else expect(module, name).toMatch(/^@\/pages\//);
    }
  });

  it('keeps the frame eager: providers, gates, layouts and redirects', () => {
    for (const name of [
      'AuthLayout',
      'AppLayout',
      'AdminLayout',
      'SettingsLayout',
      'AiAgentLayout',
      'CallCenterLayout',
      'RequireAuth',
      'RequireAdmin',
      'RequireWorkspaceAdmin',
      'BrandingGate',
      'PlatformBrandingGate',
      'PlanLockedOverlay',
      'AdvancedAiAgentGuard',
      'WorkspaceRedirect',
      'WorkspaceKnowledgeBaseRedirect',
    ]) {
      expect(APP, name).toMatch(new RegExp(`^import \\{ ${name} \\} from "@/`, 'm'));
      expect(LAZY.has(name), name).toBe(false);
    }
  });

  it('gives frameless pages no skeleton and full-bleed pages an inset one', () => {
    expect(APP).toContain('const LoginPage = lazyPage(() => import("@/pages/auth/LoginPage"), { fallback: "blank" });');
    expect(APP).toContain('const HelpArticlePage = lazyPage(() => import("@/pages/public/kb/HelpArticlePage"), { fallback: "blank" });');
    expect(APP).toContain('const InboxPage = lazyPage(() => import("@/pages/app/InboxPage"), { fallback: "inset" });');
    expect(APP).toContain('const OverviewPage = lazyPage(() => import("@/pages/app/OverviewPage"));');
    expect(APP).toContain('const AdminPanelThemePage = lazyPage(() => import("@/pages/admin/PanelThemePage"));');
  });

  it('loads the native route table only in the native shell', () => {
    expect(LAZY.get('MobileRoutes')).toBe('@/mobile/MobileRoutes');
    expect(APP).toContain('if (isNativeApp) void MobileRoutes.preload();');
    expect(APP).toContain('{isNativeApp ? <MobileRoutes /> : (');
  });

  it('starts the current page download at start-up and prefetches the common pages when idle', () => {
    expect(APP).toContain('    trackMediaCapture();\n    preloadPath(window.location.pathname);');
    expect(APP).toMatch(/COMMON_WORKSPACE_PAGES: readonly Preloadable\[\] = \[InboxPage, ContactsPage, OverviewPage\]/);
    expect(APP).toContain('{!isNativeApp && <RoutePrefetcher />}');
    expect(APP).toContain('installLinkPrefetch(pagesForPath)');
  });

  it('downloads nothing for the panel on behalf of a visitor who is not signed in', () => {
    // "/" and "/app" lead to sign-in for a visitor: no dashboard at start-up.
    expect(APP).toContain('case "": return [];');
    expect(APP).toContain('return second ? workspacePagesFor(second, third) : [];');
    // The dashboard for "/" and "/app" once the session shows a user.
    expect(APP).toContain('const toDashboard = signedIn && DASHBOARD_ENTRY_PATHS.has(pathname);');
    expect(APP).toContain('if (toDashboard) void OverviewPage.preload();');
    // Idle work only for a signed-in user inside the panel.
    expect(APP).toContain('const idleWork = signedIn && !OUTSIDE_PANEL.test(pathname);');
    expect(APP).toContain('if (!idleWork || !canPrefetch()) return undefined;');
    expect(APP).toMatch(/OUTSIDE_PANEL = \/\^\\\/\(auth\|invite\|help\|privacy\|terms\|contact\|commerce\)/);
  });

  it('warms the service worker cache after the common pages', () => {
    expect(APP).toMatch(/for \(const page of COMMON_WORKSPACE_PAGES\) void page\.preload\(\);\s+warmServiceWorkerCache\(\);/);
  });

  it('keeps main.tsx free of page imports', () => {
    expect(MAIN).not.toMatch(/@\/pages\//);
    expect(MAIN).toMatch(/import App from "\.\/App\.tsx";/);
  });
});

// ─── The stale-chunk guard ────────────────────────────────────────────────

interface MemoryEnv extends ChunkReloadEnv {
  store: Map<string, string>;
  clock: { now: number };
  reloads: number;
}

function memoryEnv(start = 1_700_000_000_000): MemoryEnv {
  const store = new Map<string, string>();
  const env: MemoryEnv = {
    store,
    clock: { now: start },
    reloads: 0,
    storage: {
      getItem: (key) => store.get(key) ?? null,
      setItem: (key, value) => {
        store.set(key, value);
      },
    },
    now: () => env.clock.now,
    reload: () => {
      env.reloads += 1;
    },
  };
  return env;
}

const CHROME = new TypeError('Failed to fetch dynamically imported module: https://app.example/assets/InboxPage-abc123.js');
const FIREFOX = new TypeError('error loading dynamically imported module: https://app.example/assets/InboxPage-abc123.js');
const SAFARI = new TypeError('Importing a module script failed.');
const VITE_CSS = new Error('Unable to preload CSS for /assets/VisitorsPage-abc123.css');

describe('isChunkLoadError', () => {
  it('recognises what each browser and Vite report for a missing chunk', () => {
    for (const error of [CHROME, FIREFOX, SAFARI, VITE_CSS]) expect(isChunkLoadError(error), error.message).toBe(true);
    const named = new Error('x');
    named.name = 'ChunkLoadError';
    expect(isChunkLoadError(named)).toBe(true);
  });

  it('ignores every other failure', () => {
    expect(isChunkLoadError(new Error('Cannot read properties of undefined'))).toBe(false);
    expect(isChunkLoadError(new TypeError('Failed to fetch'))).toBe(false);
    expect(isChunkLoadError('Failed to fetch dynamically imported module')).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
    expect(isChunkLoadError(undefined)).toBe(false);
    expect(isChunkLoadError({ message: 42 })).toBe(false);
  });
});

describe('reloadOnceForStaleChunk', () => {
  it('reloads the first time and records when', () => {
    const env = memoryEnv();
    expect(reloadOnceForStaleChunk(env)).toBe(true);
    expect(env.reloads).toBe(1);
    expect(env.store.get(CHUNK_RELOAD_KEY)).toBe(String(env.clock.now));
  });

  it('does not reload again inside the window (no reload loop)', () => {
    const env = memoryEnv();
    reloadOnceForStaleChunk(env);
    env.clock.now += CHUNK_RELOAD_WINDOW_MS - 1;
    expect(reloadOnceForStaleChunk(env)).toBe(false);
    expect(env.reloads).toBe(1);
  });

  it('allows one more reload once the window has passed (a later deploy)', () => {
    const env = memoryEnv();
    reloadOnceForStaleChunk(env);
    env.clock.now += CHUNK_RELOAD_WINDOW_MS;
    expect(reloadOnceForStaleChunk(env)).toBe(true);
    expect(env.reloads).toBe(2);
  });

  it('treats a clock that moved backwards as inside the window', () => {
    const env = memoryEnv();
    reloadOnceForStaleChunk(env);
    env.clock.now -= 1_000;
    expect(reloadOnceForStaleChunk(env)).toBe(false);
    expect(env.reloads).toBe(1);
  });

  it('ignores a garbage value in storage', () => {
    const env = memoryEnv();
    env.store.set(CHUNK_RELOAD_KEY, 'not-a-number');
    expect(reloadOnceForStaleChunk(env)).toBe(true);
  });

  it('never reloads without storage to guard with', () => {
    const env = memoryEnv();
    expect(reloadOnceForStaleChunk({ ...env, storage: null })).toBe(false);
    expect(env.reloads).toBe(0);

    const throwing: ChunkReloadEnv = {
      ...env,
      storage: {
        getItem: () => {
          throw new Error('SecurityError');
        },
        setItem: () => {
          throw new Error('SecurityError');
        },
      },
    };
    expect(reloadOnceForStaleChunk(throwing)).toBe(false);
    expect(env.reloads).toBe(0);
  });
});

describe('loadWithChunkRecovery', () => {
  const settle = <T,>(promise: Promise<T>) =>
    Promise.race([
      promise.then(
        () => 'resolved',
        () => 'rejected',
      ),
      new Promise<string>((done) => setTimeout(() => done('pending'), 20)),
    ]);

  it('passes a successful load through', async () => {
    const env = memoryEnv();
    await expect(loadWithChunkRecovery(() => Promise.resolve('page'), env)).resolves.toBe('page');
    expect(env.reloads).toBe(0);
  });

  it('reloads once on a missing chunk and keeps the loading state up meanwhile', async () => {
    const env = memoryEnv();
    expect(await settle(loadWithChunkRecovery(() => Promise.reject(CHROME), env))).toBe('pending');
    expect(env.reloads).toBe(1);
  });

  it('rejects with the original error when the chunk is still missing after the reload', async () => {
    const env = memoryEnv();
    env.store.set(CHUNK_RELOAD_KEY, String(env.clock.now - 1_000));
    await expect(loadWithChunkRecovery(() => Promise.reject(SAFARI), env)).rejects.toBe(SAFARI);
    expect(env.reloads).toBe(0);
  });

  it('never reloads for an error that is not a missing chunk', async () => {
    const env = memoryEnv();
    const confirm = vi.fn(async () => true);
    const boom = new Error('boom');
    await expect(loadWithChunkRecovery(() => Promise.reject(boom), { ...env, confirm })).rejects.toBe(boom);
    expect(env.reloads).toBe(0);
    expect(env.store.has(CHUNK_RELOAD_KEY)).toBe(false);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('reloads only when the reload is confirmed', async () => {
    const env = memoryEnv();
    expect(await settle(loadWithChunkRecovery(() => Promise.reject(CHROME), { ...env, confirm: async () => true }))).toBe('pending');
    expect(env.reloads).toBe(1);
  });

  it('shows "try again" instead when the reload is not confirmed (offline, a live call, no new deploy)', async () => {
    const env = memoryEnv();
    await expect(loadWithChunkRecovery(() => Promise.reject(CHROME), { ...env, confirm: async () => false })).rejects.toBe(CHROME);
    expect(env.reloads).toBe(0);
    // The window is not used up: a later, confirmed failure may still reload.
    expect(env.store.has(CHUNK_RELOAD_KEY)).toBe(false);
  });

  it('treats a confirmation that fails as "no"', async () => {
    const env = memoryEnv();
    const confirm = async (): Promise<boolean> => {
      throw new Error('network');
    };
    await expect(loadWithChunkRecovery(() => Promise.reject(SAFARI), { ...env, confirm })).rejects.toBe(SAFARI);
    expect(env.reloads).toBe(0);
  });
});

// ─── Is a reload safe and useful? ─────────────────────────────────────────

describe('confirmStaleBuild', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('allows the reload when online with no live call, without asking the server', async () => {
    // A failed module stays failed in the browser until the page reloads,
    // whether a deploy removed it or the network dropped it.
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    expect(await confirmStaleBuild()).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('live media capture', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('notes the streams a call opens and hands the browser\'s own promise back', async () => {
    const track = { readyState: 'live' as MediaStreamTrackState };
    const stream = { getTracks: () => [track] } as unknown as MediaStream;
    const pending = Promise.resolve(stream);
    const original = vi.fn(() => pending);
    const media = { getUserMedia: original } as unknown as MediaDevices;

    trackMediaCapture(media);
    expect(hasLiveMediaCapture()).toBe(false);

    const constraints = { audio: true };
    const result = media.getUserMedia(constraints);
    expect(result).toBe(pending);
    expect(original).toHaveBeenCalledWith(constraints);
    await result;
    expect(hasLiveMediaCapture()).toBe(true);
    // A live call: no automatic reload.
    expect(await confirmStaleBuild()).toBe(false);

    // The call ends: its tracks stop.
    track.readyState = 'ended';
    expect(hasLiveMediaCapture()).toBe(false);
  });

  it('never reloads while the browser is offline', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    expect(await confirmStaleBuild()).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
