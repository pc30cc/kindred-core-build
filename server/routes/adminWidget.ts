/**
 * Admin Widget Diagnostics
 *
 * POST /api/admin/widget/test-url
 *   Server-side fetch of widget assets so the platform admin can verify
 *   loader/manifest/runtime URLs without browser CORS surprises.
 *
 * Mounted under /api/admin (admin-only auth handled by the parent router).
 */

import { Router } from 'express';
import { z } from 'zod';

export const adminWidgetRouter = Router();

const TEST_KINDS = ['loader', 'manifest', 'runtime', 'stylesheet', 'api_bootstrap', 'realtime'] as const;
type TestKind = typeof TEST_KINDS[number];

const testSchema = z.object({
  kind: z.enum(TEST_KINDS),
  url: z.string().url(),
  asset_base: z.string().url().optional(),
  api_base: z.string().url().optional(),
});

interface TestResult {
  kind: TestKind;
  url: string;
  status: 'success' | 'warning' | 'failed';
  http_status: number | null;
  content_type: string | null;
  response_kind: 'js' | 'json' | 'css' | 'html' | 'other' | null;
  duration_ms: number | null;
  message: string;
  details?: Record<string, any>;
}

const TIMEOUT_MS = 8000;

function classifyContentType(ct: string | null, body: string): TestResult['response_kind'] {
  if (!ct && !body) return 'other';
  const lower = (ct || '').toLowerCase();
  if (lower.includes('javascript') || lower.includes('ecmascript')) return 'js';
  if (lower.includes('json')) return 'json';
  if (lower.includes('css')) return 'css';
  if (lower.includes('html')) return 'html';
  // Sniff the body if content-type was missing or generic
  const head = body.trim().slice(0, 200).toLowerCase();
  if (head.startsWith('{') || head.startsWith('[')) return 'json';
  if (head.startsWith('<!doctype html') || head.startsWith('<html')) return 'html';
  if (head.includes('function') || head.includes('var ') || head.includes('=>')) return 'js';
  return 'other';
}

async function fetchWithTimeout(url: string, init?: RequestInit) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const start = Date.now();
  try {
    // `cache` is honoured by the runtime fetch implementation but is absent
    // from the Node RequestInit typing, so widen the local literal only.
    const requestInit: RequestInit & { cache?: 'no-store' } = {
      ...init,
      signal: ctrl.signal,
      // Disable any caching so admins always see live results
      cache: 'no-store',
      redirect: 'follow',
    };
    const res = await fetch(url, requestInit);
    const duration = Date.now() - start;
    const text = await res.text();
    return { res, text, duration };
  } finally {
    clearTimeout(timer);
  }
}

function failResult(kind: TestKind, url: string, message: string, details?: any): TestResult {
  return {
    kind,
    url,
    status: 'failed',
    http_status: null,
    content_type: null,
    response_kind: null,
    duration_ms: null,
    message,
    details,
  };
}

async function testLoader(url: string): Promise<TestResult> {
  try {
    const { res, text, duration } = await fetchWithTimeout(url);
    const ct = res.headers.get('content-type');
    const kind = classifyContentType(ct, text);
    if (!res.ok) {
      return {
        kind: 'loader', url, status: 'failed', http_status: res.status, content_type: ct,
        response_kind: kind, duration_ms: duration,
        message: `Loader returned HTTP ${res.status}. Make sure /widget/loader.js is publicly served.`,
      };
    }
    if (kind === 'html') {
      return {
        kind: 'loader', url, status: 'failed', http_status: res.status, content_type: ct,
        response_kind: kind, duration_ms: duration,
        message: 'Loader URL returns HTML instead of JavaScript. The web server is falling back to index.html — fix nginx so /widget/* never falls back.',
      };
    }
    if (kind !== 'js') {
      return {
        kind: 'loader', url, status: 'warning', http_status: res.status, content_type: ct,
        response_kind: kind, duration_ms: duration,
        message: `Unexpected content-type for loader (${ct || 'unknown'}). Expected JavaScript.`,
      };
    }
    return {
      kind: 'loader', url, status: 'success', http_status: res.status, content_type: ct,
      response_kind: kind, duration_ms: duration,
      message: 'Loader script reachable and served as JavaScript.',
    };
  } catch (err: any) {
    return failResult('loader', url, `Loader fetch failed: ${err?.message || err}`);
  }
}

async function testManifest(url: string): Promise<TestResult> {
  try {
    const { res, text, duration } = await fetchWithTimeout(url);
    const ct = res.headers.get('content-type');
    const kind = classifyContentType(ct, text);
    if (!res.ok) {
      return {
        kind: 'manifest', url, status: 'failed', http_status: res.status, content_type: ct,
        response_kind: kind, duration_ms: duration,
        message: `Manifest returned HTTP ${res.status}.`,
      };
    }
    if (kind === 'html') {
      return {
        kind: 'manifest', url, status: 'failed', http_status: res.status, content_type: ct,
        response_kind: kind, duration_ms: duration,
        message: 'Manifest URL returns HTML instead of JSON. Web server is falling back to index.html.',
      };
    }
    let parsed: any = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      return {
        kind: 'manifest', url, status: 'failed', http_status: res.status, content_type: ct,
        response_kind: kind, duration_ms: duration,
        message: 'Manifest body is not valid JSON.',
        details: { preview: text.slice(0, 200) },
      };
    }
    const requiredKeys = ['runtime.js', 'runtime-rt-resolver.js', 'runtime-rt-centrifugo.js', 'runtime-rt-supabase.js', 'loader.js'];
    const missing = requiredKeys.filter((k) => !parsed[k]);
    if (missing.length) {
      return {
        kind: 'manifest', url, status: 'warning', http_status: res.status, content_type: ct,
        response_kind: 'json', duration_ms: duration,
        message: `Manifest is JSON but missing required entries: ${missing.join(', ')}.`,
        details: { manifest: parsed },
      };
    }
    return {
      kind: 'manifest', url, status: 'success', http_status: res.status, content_type: ct,
      response_kind: 'json', duration_ms: duration,
      message: `Manifest valid. loaderVersion=${parsed.loaderVersion || 'n/a'}.`,
      details: { manifest: parsed },
    };
  } catch (err: any) {
    return failResult('manifest', url, `Manifest fetch failed: ${err?.message || err}`);
  }
}

async function testRuntime(url: string, assetBase?: string): Promise<TestResult> {
  try {
    // Resolve the actual hashed runtime.js via the manifest first
    let runtimeUrl = url;
    if (assetBase) {
      try {
        const manifestUrl = `${assetBase.replace(/\/$/, '')}/widget/widget-manifest.json`;
        const { res, text } = await fetchWithTimeout(manifestUrl);
        if (res.ok) {
          const manifest = JSON.parse(text);
          if (manifest['runtime.js']) {
            runtimeUrl = `${assetBase.replace(/\/$/, '')}/widget/${manifest['runtime.js']}`;
          }
        }
      } catch { /* fall through with the raw URL */ }
    }

    const { res, text, duration } = await fetchWithTimeout(runtimeUrl);
    const ct = res.headers.get('content-type');
    const kind = classifyContentType(ct, text);
    if (!res.ok) {
      return {
        kind: 'runtime', url: runtimeUrl, status: 'failed', http_status: res.status, content_type: ct,
        response_kind: kind, duration_ms: duration,
        message: `Runtime returned HTTP ${res.status}.`,
      };
    }
    if (kind !== 'js') {
      return {
        kind: 'runtime', url: runtimeUrl, status: 'failed', http_status: res.status, content_type: ct,
        response_kind: kind, duration_ms: duration,
        message: `Runtime URL is not JavaScript (got ${kind}).`,
      };
    }
    return {
      kind: 'runtime', url: runtimeUrl, status: 'success', http_status: res.status, content_type: ct,
      response_kind: kind, duration_ms: duration,
      message: 'Runtime asset reachable.',
    };
  } catch (err: any) {
    return failResult('runtime', url, `Runtime fetch failed: ${err?.message || err}`);
  }
}

async function testStylesheet(url: string): Promise<TestResult> {
  try {
    const { res, text, duration } = await fetchWithTimeout(url);
    const ct = res.headers.get('content-type');
    const kind = classifyContentType(ct, text);
    if (!res.ok) {
      return {
        kind: 'stylesheet', url, status: 'failed', http_status: res.status, content_type: ct,
        response_kind: kind, duration_ms: duration,
        message: `Stylesheet returned HTTP ${res.status}.`,
      };
    }
    if (kind !== 'css') {
      return {
        kind: 'stylesheet', url, status: 'warning', http_status: res.status, content_type: ct,
        response_kind: kind, duration_ms: duration,
        message: `Stylesheet content-type is ${ct || 'unknown'}, expected text/css.`,
      };
    }
    return {
      kind: 'stylesheet', url, status: 'success', http_status: res.status, content_type: ct,
      response_kind: 'css', duration_ms: duration,
      message: 'Stylesheet reachable.',
    };
  } catch (err: any) {
    return failResult('stylesheet', url, `Stylesheet fetch failed: ${err?.message || err}`);
  }
}

async function testApiBootstrap(url: string): Promise<TestResult> {
  try {
    const { res, text, duration } = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspace_id: '00000000-0000-0000-0000-000000000000' }),
    });
    const ct = res.headers.get('content-type');
    const kind = classifyContentType(ct, text);
    // We expect either 200 (succeeded against a real workspace), 400/404 (validation),
    // or 403 (origin denied). HTML or 5xx means the URL is wrong.
    if (kind === 'html') {
      return {
        kind: 'api_bootstrap', url, status: 'failed', http_status: res.status, content_type: ct,
        response_kind: kind, duration_ms: duration,
        message: 'API bootstrap returned HTML — the URL is pointing at the SPA, not the backend API.',
      };
    }
    if (res.status >= 500) {
      return {
        kind: 'api_bootstrap', url, status: 'failed', http_status: res.status, content_type: ct,
        response_kind: kind, duration_ms: duration,
        message: `API bootstrap returned ${res.status}. Backend is unreachable or crashed.`,
      };
    }
    if (kind !== 'json') {
      return {
        kind: 'api_bootstrap', url, status: 'warning', http_status: res.status, content_type: ct,
        response_kind: kind, duration_ms: duration,
        message: `API bootstrap returned non-JSON (${ct || 'unknown'}).`,
      };
    }
    return {
      kind: 'api_bootstrap', url, status: 'success', http_status: res.status, content_type: ct,
      response_kind: 'json', duration_ms: duration,
      message: `API bootstrap reachable (HTTP ${res.status}).`,
    };
  } catch (err: any) {
    return failResult('api_bootstrap', url, `API bootstrap fetch failed: ${err?.message || err}`);
  }
}

async function testRealtime(url: string): Promise<TestResult> {
  // Realtime is a WS endpoint — we just probe the HTTP side (Centrifugo answers
  // 200 on its base path, 426 on /connection/websocket without a real handshake).
  try {
    const { res, text, duration } = await fetchWithTimeout(url, { method: 'GET' });
    const ct = res.headers.get('content-type');
    const kind = classifyContentType(ct, text);
    if (res.status === 426 || res.status === 400 || res.status === 200 || res.status === 404) {
      return {
        kind: 'realtime', url, status: 'success', http_status: res.status, content_type: ct,
        response_kind: kind, duration_ms: duration,
        message: `Realtime endpoint reachable (HTTP ${res.status}).`,
      };
    }
    return {
      kind: 'realtime', url, status: 'warning', http_status: res.status, content_type: ct,
      response_kind: kind, duration_ms: duration,
      message: `Unexpected status ${res.status} from realtime endpoint.`,
    };
  } catch (err: any) {
    return failResult('realtime', url, `Realtime probe failed: ${err?.message || err}`);
  }
}

adminWidgetRouter.post('/test-url', async (req, res) => {
  const parsed = testSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request', issues: parsed.error.format() });
  }
  const { kind, url, asset_base } = parsed.data;

  let result: TestResult;
  switch (kind) {
    case 'loader':         result = await testLoader(url); break;
    case 'manifest':       result = await testManifest(url); break;
    case 'runtime':        result = await testRuntime(url, asset_base); break;
    case 'stylesheet':     result = await testStylesheet(url); break;
    case 'api_bootstrap':  result = await testApiBootstrap(url); break;
    case 'realtime':       result = await testRealtime(url); break;
  }
  res.json(result);
});
