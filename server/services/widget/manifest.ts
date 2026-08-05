/**
 * Widget Manifest Reader
 *
 * Resolves the widget asset manifest produced by `scripts/widget-hash.js`.
 *
 * Strategy (in order):
 *   1. Local filesystem search — works for single-container / dev setups where
 *      the backend can see the build output directly.
 *   2. HTTP fetch from a configured asset base URL — required for split
 *      frontend/backend deployments (e.g. Coolify multi-domain) where the
 *      Express backend cannot read the nginx container's filesystem.
 *
 * Both results are cached for CACHE_TTL_MS. HTTP fetch results refresh
 * lazily; if the fetch fails we keep serving the previous good manifest
 * instead of regressing to fallback values.
 *
 * In production, if no valid (hashed) manifest can be resolved we DO NOT
 * fall back to unhashed asset names — that used to silently serve broken/
 * uncacheable assets and mask real deployment misconfiguration. Instead,
 * `getWidgetAssetName()` / `getLoaderVersion()` throw a
 * `WidgetManifestUnavailableError` so callers can return a controlled 503.
 *
 * In development (NODE_ENV !== 'production') we keep serving unhashed
 * fallback names so a local checkout without a widget build still works,
 * accompanied by a loud console warning.
 */
import { createHash } from 'crypto';
import { readFileSync, existsSync } from 'fs';
import { resolve, join } from 'path';

interface WidgetManifest {
  'runtime.js'?: string;
  'runtime.css'?: string;
  'runtime-chat.js'?: string;
  'runtime-kb.js'?: string;
  'runtime-call.js'?: string;
  'runtime-rt-centrifugo.js'?: string;
  'runtime-rt-supabase.js'?: string;
  'runtime-rt-resolver.js'?: string;
  // Self-hosted vendor assets (Pass 1: LiveKit JS SDK).
  'vendor/livekit-client.umd.min.js'?: string;
  'loader.js'?: string;
  loaderVersion?: string;
}

type WidgetAssetKey =
  | 'runtime.js'
  | 'runtime.css'
  | 'runtime-chat.js'
  | 'runtime-kb.js'
  | 'runtime-call.js'
  | 'runtime-rt-centrifugo.js'
  | 'runtime-rt-supabase.js'
  | 'runtime-rt-resolver.js'
  | 'vendor/livekit-client.umd.min.js';

/**
 * Thrown by getWidgetAssetName()/getLoaderVersion() in production when no
 * valid hashed manifest could be resolved from local FS or remote HTTP.
 * Callers (route handlers) must catch this and return a controlled 503 —
 * never let it bubble up as an unhandled 500 with a stack trace.
 */
export class WidgetManifestUnavailableError extends Error {
  public readonly diagnostics: ReturnType<typeof buildDiagnostics>;

  constructor(diagnostics: ReturnType<typeof buildDiagnostics>) {
    super('Widget asset manifest is unavailable: no valid hashed manifest could be resolved.');
    this.name = 'WidgetManifestUnavailableError';
    this.diagnostics = diagnostics;
  }
}

// Development-only fallback gate. Production deployments must never serve
// unhashed asset names — see module doc above. Evaluated per call (not
// captured at import time) so tests can exercise both modes.
function unhashedFallbackAllowed(): boolean {
  return process.env.NODE_ENV !== 'production';
}

let cachedManifest: WidgetManifest | null = null;
let lastReadTime = 0;
let lastSource: string = 'unresolved';
// Task 5 — very short TTL so a fresh deploy converges within a couple of
// seconds even if the deploy hook (manifest-invalidate) didn't fire. The
// remote fetch is conditional (If-None-Match) so a 304 response is cheap
// — we trade a few extra HEAD-equivalent round trips for near-zero
// staleness after Cloudflare cache purges.
const CACHE_TTL_MS = 2_000;

// ETag bookkeeping for remote manifest revalidation. Persists across
// fetches so we can short-circuit with `If-None-Match`.
let lastRemoteEtag: string | null = null;
let lastRemoteUrl: string | null = null;
let lastRemoteFetchAt = 0;
let lastRemoteStatus: 'ok' | 'not_modified' | 'failed' | 'unset' = 'unset';

const MANIFEST_PATHS = [
  resolve(process.cwd(), 'dist', 'widget', 'widget-manifest.json'),
  resolve(process.cwd(), '..', 'dist', 'widget', 'widget-manifest.json'),
  '/usr/share/nginx/html/widget/widget-manifest.json',
  '/app/dist/widget/widget-manifest.json',
];

const WIDGET_DIR_PATHS = [
  resolve(process.cwd(), 'public', 'widget'),
  resolve(process.cwd(), '..', 'public', 'widget'),
  resolve(process.cwd(), 'dist', 'widget'),
  resolve(process.cwd(), '..', 'dist', 'widget'),
  '/usr/share/nginx/html/widget',
  '/app/public/widget',
  '/app/dist/widget',
];

const VERSION_FILES = ['loader.js', 'runtime.js', 'runtime.css', 'runtime-chat.js', 'runtime-kb.js'] as const;
const FALLBACK_VERSION = 'unresolved';

function computeFallbackVersion(): string {
  for (const dir of WIDGET_DIR_PATHS) {
    try {
      const availableFiles = VERSION_FILES.filter((file) => existsSync(join(dir, file)));
      if (!availableFiles.length) continue;

      const hash = createHash('md5');
      for (const file of availableFiles) {
        hash.update(file);
        hash.update(readFileSync(join(dir, file)));
      }

      return hash.digest('hex').slice(0, 12);
    } catch {
      // ignore
    }
  }

  return FALLBACK_VERSION;
}

function readLocalManifest(): { manifest: WidgetManifest; source: string } | null {
  for (const p of MANIFEST_PATHS) {
    if (!existsSync(p)) continue;
    try {
      const raw = readFileSync(p, 'utf-8');
      const parsed = JSON.parse(raw) as WidgetManifest;
      parsed.loaderVersion ||= computeFallbackVersion();
      return { manifest: parsed, source: `fs:${p}` };
    } catch (err) {
      console.warn(`[widget-manifest] Failed to parse ${p}:`, err);
    }
  }
  return null;
}

function getRemoteManifestUrl(): string | null {
  const explicit = process.env.WIDGET_MANIFEST_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, '');

  const assetBase = process.env.WIDGET_ASSET_BASE_URL?.trim()
    || process.env.PUBLIC_WIDGET_BASE_URL?.trim()
    || process.env.PUBLIC_BASE_URL?.trim();

  if (!assetBase) return null;
  return `${assetBase.replace(/\/$/, '')}/widget/widget-manifest.json`;
}

let inflightRemoteFetch: Promise<WidgetManifest | null> | null = null;

async function fetchRemoteManifest(): Promise<WidgetManifest | null> {
  const url = getRemoteManifestUrl();
  if (!url) return null;

  if (inflightRemoteFetch) return inflightRemoteFetch;

  inflightRemoteFetch = (async () => {
    try {
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 4000);
      // Conditional GET when we already have an ETag — saves bandwidth and
      // proves freshness without re-parsing JSON. URL changes invalidate
      // the prior etag (different deployments may live behind different
      // hosts).
      const headers: Record<string, string> = {};
      if (lastRemoteEtag && lastRemoteUrl === url) {
        headers['If-None-Match'] = lastRemoteEtag;
      }
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: { ...headers, 'Cache-Control': 'no-cache' },
      });
      clearTimeout(timeout);
      lastRemoteUrl = url;
      lastRemoteFetchAt = Date.now();

      // 304 — manifest unchanged. Keep the existing cachedManifest as-is.
      if (res.status === 304 && cachedManifest) {
        lastRemoteStatus = 'not_modified';
        return cachedManifest;
      }
      if (!res.ok) {
        lastRemoteStatus = 'failed';
        console.warn(`[widget-manifest] Remote fetch ${url} returned ${res.status}`);
        return null;
      }
      const etag = res.headers.get('etag');
      if (etag) lastRemoteEtag = etag;
      const body = (await res.json()) as WidgetManifest;
      if (!body || typeof body !== 'object') {
        lastRemoteStatus = 'failed';
        return null;
      }
      body.loaderVersion ||= FALLBACK_VERSION;
      lastRemoteStatus = 'ok';
      console.log(
        `[widget-manifest] Loaded from remote ${url}` +
          ` (loaderVersion=${body.loaderVersion}, etag=${etag || 'none'})`,
      );
      return body;
    } catch (err: any) {
      lastRemoteStatus = 'failed';
      console.warn(`[widget-manifest] Remote fetch failed: ${err?.message || err}`);
      return null;
    } finally {
      inflightRemoteFetch = null;
    }
  })();

  return inflightRemoteFetch;
}

function unhashedFallbackManifest(): WidgetManifest {
  return {
    'runtime.js': 'runtime.js',
    'runtime.css': 'runtime.css',
    'runtime-chat.js': 'runtime-chat.js',
    'runtime-kb.js': 'runtime-kb.js',
    'runtime-call.js': 'runtime-call.js',
    'runtime-rt-centrifugo.js': 'runtime-rt-centrifugo.js',
    'runtime-rt-supabase.js': 'runtime-rt-supabase.js',
    'runtime-rt-resolver.js': 'runtime-rt-resolver.js',
    // Fallback (dev / pre-build) — served from public/widget/vendor/ as-is.
    'vendor/livekit-client.umd.min.js': 'vendor/livekit-client.umd.min.js',
    'loader.js': 'loader.js',
    loaderVersion: computeFallbackVersion(),
  };
}

/**
 * Content-hash filename contract produced by `scripts/widget-hash.js`:
 * `<stem>.<8 lowercase hex>.<ext>` — e.g. `runtime.341ce9bc.js`,
 * `runtime.62b620ac.css`. Anything else (bare `runtime.js`, a truncated or
 * uppercase hash, a path traversal) is rejected in production.
 */
function hashedPattern(logical: string): RegExp {
  const base = logical.split('/').pop() as string;
  const ext = base.slice(base.lastIndexOf('.') + 1);
  const stem = base.slice(0, base.lastIndexOf('.'));
  const dir = logical.includes('/') ? `${logical.slice(0, logical.lastIndexOf('/'))}/` : '';
  const esc = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${esc(dir)}${esc(stem)}\\.[a-f0-9]{8}\\.${esc(ext)}$`);
}

/** Assets that MUST exist and MUST be content-hashed in production. */
export const REQUIRED_HASHED_ASSETS: WidgetAssetKey[] = [
  'runtime.js',
  'runtime.css',
  'runtime-chat.js',
  'runtime-kb.js',
  'runtime-call.js',
];

/**
 * Explains why a manifest is unusable. Empty array = valid.
 * Exported for tests and for the /diagnostics surface.
 */
export function manifestValidationErrors(manifest: unknown): string[] {
  const errors: string[] = [];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return ['manifest_missing_or_malformed'];
  }
  const m = manifest as Record<string, unknown>;
  for (const key of REQUIRED_HASHED_ASSETS) {
    const value = m[key];
    if (typeof value !== 'string' || !value) {
      errors.push(`missing_asset:${key}`);
      continue;
    }
    if (!hashedPattern(key).test(value)) {
      errors.push(`unhashed_asset:${key}=${value}`);
    }
  }
  const version = m.loaderVersion;
  if (typeof version !== 'string' || !version || version === FALLBACK_VERSION) {
    errors.push('unresolved_loader_version');
  }
  return errors;
}

/** A manifest is only "valid" if every required asset is hashed and loaderVersion resolved. */
function isManifestValid(manifest: WidgetManifest | null): manifest is WidgetManifest {
  return manifestValidationErrors(manifest).length === 0;
}

function syncLoadManifest(): WidgetManifest | null {
  const now = Date.now();
  if (cachedManifest && now - lastReadTime < CACHE_TTL_MS) {
    return cachedManifest;
  }

  const local = readLocalManifest();
  if (local) {
    cachedManifest = local.manifest;
    lastSource = local.source;
    lastReadTime = now;
    console.log(`[widget-manifest] Loaded from ${local.source} (loaderVersion=${cachedManifest.loaderVersion})`);
    // Kick a remote refresh in the background so we converge on the canonical
    // frontend-served manifest if local FS is stale.
    void fetchRemoteManifest().then((remote) => {
      if (remote) {
        cachedManifest = remote;
        lastSource = `remote:${getRemoteManifestUrl()}`;
        lastReadTime = Date.now();
      }
    });
    return cachedManifest;
  }

  // No local manifest — kick a remote fetch and, in dev only, serve an
  // unhashed fallback for THIS request. Subsequent requests will pick up
  // the remote value once it resolves.
  void fetchRemoteManifest().then((remote) => {
    if (remote) {
      cachedManifest = remote;
      lastSource = `remote:${getRemoteManifestUrl()}`;
      lastReadTime = Date.now();
    }
  });

  if (!cachedManifest) {
    if (unhashedFallbackAllowed()) {
      cachedManifest = unhashedFallbackManifest();
      lastSource = 'fallback';
      lastReadTime = now;
      if (cachedManifest.loaderVersion === FALLBACK_VERSION) {
        console.warn(
          '[widget-manifest] DEV ONLY: No manifest reachable. Set WIDGET_MANIFEST_URL ' +
            'or WIDGET_ASSET_BASE_URL on the backend so it can fetch the ' +
            'frontend-built widget-manifest.json. Serving unhashed assets ' +
            '(this fallback is disabled in production).',
        );
      }
      return cachedManifest;
    }

    // Production, nothing resolved — do NOT cache a fallback value, keep
    // returning null so callers can retry on the next request once a
    // manifest becomes reachable.
    lastSource = 'unresolved';
    return null;
  }

  return cachedManifest;
}

function buildDiagnostics(manifest: WidgetManifest | null) {
  return {
    resolved: isManifestValid(manifest),
    validationErrors: manifestValidationErrors(manifest),
    source: lastSource,
    loaderVersion: manifest?.loaderVersion ?? null,
    runtimeJs: manifest?.['runtime.js'] ?? null,
    runtimeCss: manifest?.['runtime.css'] ?? null,
    runtimeChatJs: manifest?.['runtime-chat.js'] ?? null,
    runtimeKbJs: manifest?.['runtime-kb.js'] ?? null,
    runtimeCallJs: manifest?.['runtime-call.js'] ?? null,
    livekitSdk: manifest?.['vendor/livekit-client.umd.min.js'] ?? null,
    cachedAt: lastReadTime ? new Date(lastReadTime).toISOString() : null,
    remoteUrl: getRemoteManifestUrl(),
    remoteStatus: lastRemoteStatus,
    remoteEtag: lastRemoteEtag,
    remoteLastFetchAt: lastRemoteFetchAt ? new Date(lastRemoteFetchAt).toISOString() : null,
    cacheTtlMs: CACHE_TTL_MS,
    isFallback: lastSource === 'fallback',
    unhashedFallbackAllowed: unhashedFallbackAllowed(),
  };
}

/** Returns the resolved manifest, or null if none could be resolved (production only). */
export function getWidgetManifestOrNull(): WidgetManifest | null {
  const manifest = syncLoadManifest();
  return isManifestValid(manifest) || unhashedFallbackAllowed() ? manifest : null;
}

/** True when a usable manifest (hashed, or dev fallback) is currently resolved. */
export function isManifestResolved(): boolean {
  const manifest = syncLoadManifest();
  return isManifestValid(manifest) || (unhashedFallbackAllowed() && !!manifest);
}

function requireManifest(): WidgetManifest {
  const manifest = syncLoadManifest();
  // A manifest object is not enough — it must pass the hashed-filename
  // contract. Outside production we keep the documented dev fallback so a
  // local checkout without a widget build still boots.
  if (manifest && (isManifestValid(manifest) || unhashedFallbackAllowed())) return manifest;
  const diagnostics = buildDiagnostics(manifest);
  console.error('[widget-manifest] Unavailable in production:', diagnostics);
  throw new WidgetManifestUnavailableError(diagnostics);
}

export function getWidgetAssetName(logical: WidgetAssetKey): string {
  const manifest = requireManifest();
  return manifest[logical] || logical;
}

export function getLoaderVersion(): string {
  const manifest = requireManifest();
  return manifest.loaderVersion || FALLBACK_VERSION;
}

export function invalidateManifestCache(): void {
  cachedManifest = null;
  lastReadTime = 0;
  lastSource = 'unresolved';
  lastRemoteEtag = null;
  lastRemoteStatus = 'unset';
}

export function getManifestDiagnostics() {
  const manifest = syncLoadManifest();
  return buildDiagnostics(manifest);
}
