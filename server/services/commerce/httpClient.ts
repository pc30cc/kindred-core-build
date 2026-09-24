/**
 * SSRF-guarded, bounded HTTP client for the Commerce Gateway's calls to a
 * merchant's WooCommerce plugin origin. Reuses shared/net/hostGuard.ts
 * unmodified — the Commerce Gateway is exactly the kind of "customer-
 * controlled store URL" boundary that module was built for.
 */
import { checkOutboundUrl } from '../../../shared/net/hostGuard.js';
import { CommerceError } from '../../../shared/commerce/types.js';

const CONNECT_TIMEOUT_MS = 4_000;
const TOTAL_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_RETRIES = 1; // idempotent GET-shaped reads only

export interface CommerceHttpRequest {
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
  /** Only GET-shaped reads may be retried — never a mutating call. */
  retryable?: boolean;
  /**
   * Per-request wall-clock cap, clamped to TOTAL_TIMEOUT_MS. Callers that run
   * under a per-turn deadline pass what is LEFT of it, so one slow store can
   * never overrun the turn.
   */
  timeoutMs?: number;
  /** Response size cap, clamped to MAX_RESPONSE_BYTES. */
  maxBytes?: number;
}

export interface CommerceHttpResponse {
  status: number;
  json: unknown;
  /** Bytes actually received — measured, for the resource report. */
  bytes?: number;
}

async function fetchOnce(req: CommerceHttpRequest): Promise<CommerceHttpResponse> {
  const check = await checkOutboundUrl(req.url);
  // `=== false` (not `!check.ok`) — with this repo's strictNullChecks:false,
  // negating a boolean discriminant does not narrow the union and `.reason`
  // would fail to type-check on the `{ ok: false; reason }` branch.
  if (check.ok === false) throw new CommerceError('commerce_invalid_response', `blocked outbound url: ${check.reason}`);

  const controller = new AbortController();
  const timeoutMs = Math.max(1, Math.min(req.timeoutMs ?? TOTAL_TIMEOUT_MS, TOTAL_TIMEOUT_MS));
  const maxBytes = Math.max(1, Math.min(req.maxBytes ?? MAX_RESPONSE_BYTES, MAX_RESPONSE_BYTES));
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      redirect: 'manual', // a redirect is never followed — see SECURITY.md
      signal: controller.signal,
    });

    if (res.status >= 300 && res.status < 400) {
      throw new CommerceError('commerce_invalid_response', 'unexpected redirect from plugin origin');
    }

    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      throw new CommerceError('commerce_invalid_response', `unexpected content-type: ${contentType}`);
    }

    const reader = res.body?.getReader();
    let received = 0;
    const chunks: Uint8Array[] = [];
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > maxBytes) {
          await reader.cancel().catch(() => {});
          throw new CommerceError('commerce_invalid_response', 'response exceeded size limit');
        }
        chunks.push(value);
      }
    }
    const text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');

    let json: unknown;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      throw new CommerceError('commerce_invalid_response', 'invalid JSON from plugin origin');
    }

    return { status: res.status, json, bytes: received };
  } catch (err) {
    if (err instanceof CommerceError) throw err;
    if ((err as any)?.name === 'AbortError') throw new CommerceError('commerce_timeout', 'plugin request timed out');
    throw new CommerceError('commerce_live_unavailable', err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(timer);
  }
}

export async function commerceHttpRequest(req: CommerceHttpRequest): Promise<CommerceHttpResponse> {
  const attempts = req.retryable && req.method === 'GET' ? MAX_RETRIES + 1 : 1;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetchOnce(req);
    } catch (err) {
      lastErr = err;
      // Only retry a genuinely retryable transport failure, never a 4xx-shaped
      // application error (those already threw as commerce_invalid_response).
      if (i < attempts - 1 && err instanceof CommerceError && err.code === 'commerce_live_unavailable') {
        await new Promise((r) => setTimeout(r, 250));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

export { CONNECT_TIMEOUT_MS };
