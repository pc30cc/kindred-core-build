/**
 * SSRF-hardened page fetch for the Data Hub website crawler.
 *
 * The previous implementation used `redirect: 'follow'`, so a same-domain page
 * could redirect the crawler to `http://169.254.169.254/…` (cloud metadata) or
 * any internal host, and the body was buffered with only a post-hoc size check.
 * This module closes both holes:
 *
 *   - Redirects are handled MANUALLY, one hop at a time (max 3).
 *   - Every hop (initial URL included) is re-validated: scheme, blocked
 *     hostname, DNS answers (all resolved addresses must be public) and the
 *     caller's same-domain policy.
 *   - The body is read as a stream and aborted the moment it exceeds the byte
 *     cap, so a hostile endpoint cannot exhaust memory.
 *   - The single request deadline stays armed for DNS validation, connection,
 *     headers, redirect handling AND body streaming, so a drip-feeding server
 *     cannot hold a crawl worker open indefinitely.
 *   - DNS-rebinding: the outbound connection is made through node:http(s) with
 *     a custom `lookup` (see `createPinnedLookup`) that re-resolves and
 *     re-validates at CONNECT time and fails closed if any returned address is
 *     private/loopback/link-local. Because the socket can only ever be opened
 *     against an address this lookup returned, the connection cannot silently
 *     switch to a private address after the pre-flight check. TLS/SNI/Host are
 *     untouched (we never swap the hostname for a raw IP), so certificate
 *     verification is unaffected.
 *
 *     Limitation: when a caller injects `fetchImpl` (tests, or any future
 *     caller that supplies its own transport) the pinned lookup does not
 *     apply — the pre-flight DNS validation is then the only protection.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import { lookup as dnsLookupCb } from 'node:dns';
import type { LookupAddress } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';
import { isBlockedHostname, isBlockedIpAddress, normalizeHostname } from '../../../lib/workspaceAuth.js';

export type CrawlFetchFailure =
  | 'invalid_url'
  | 'unsupported_protocol'
  | 'blocked_host'
  | 'dns_failure'
  | 'redirect_blocked'
  | 'too_many_redirects'
  | 'unsupported_content_type'
  | 'page_too_large'
  | 'timeout'
  | 'fetch_error';

export interface SafeCrawlFetchResult {
  ok: boolean;
  html?: string;
  status?: number;
  error?: CrawlFetchFailure | string;
  finalUrl?: string;
}

export interface SafeCrawlFetchOptions {
  userAgent: string;
  timeoutMs: number;
  maxBytes: number;
  /** Same-domain (or otherwise policy) gate applied to EVERY hop. */
  isUrlAllowed: (url: string) => boolean;
  maxRedirects?: number;
  /** Accept header sent upstream. Defaults to HTML. */
  accept?: string;
  /** Content-type gate. Defaults to HTML/XHTML only. */
  isContentTypeAllowed?: (contentType: string) => boolean;
  /** Test seams. */
  lookupImpl?: (hostname: string) => Promise<LookupAddress[]>;
  fetchImpl?: typeof fetch;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const DEFAULT_MAX_REDIRECTS = 3;

function allowLocal(): boolean {
  return process.env.NODE_ENV === 'development' && process.env.AI_KB_ALLOW_LOCAL === '1';
}

/**
 * Connect-time DNS guard. Resolves the hostname and fails closed when ANY
 * returned address is non-public, so the socket can only ever be established
 * against an address that passed validation (anti DNS-rebinding).
 */
export function createPinnedLookup(): any {
  return (hostname: string, options: any, callback: any) => {
    const cb = typeof options === 'function' ? options : callback;
    const wantAll = typeof options === 'object' && options !== null && options.all === true;
    dnsLookupCb(hostname, { all: true, verbatim: true }, (err, addresses: any) => {
      if (err) return cb(err);
      const list: LookupAddress[] = Array.isArray(addresses) ? addresses : [addresses];
      if (!list.length) return cb(new Error('dns_no_answer'));
      if (!allowLocal()) {
        for (const a of list) {
          if (isBlockedIpAddress(a.address, a.family)) return cb(new Error('blocked_private_address'));
        }
      }
      if (wantAll) return cb(null, list);
      return cb(null, list[0].address, list[0].family);
    });
  };
}

/**
 * Minimal fetch-compatible transport built on node:http(s) so we can install
 * the pinned lookup. Returns a real `Response` backed by the socket stream.
 */
export function pinnedFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  const url = new URL(String(input));
  const mod = url.protocol === 'https:' ? https : http;
  const lookup = createPinnedLookup();
  return new Promise<Response>((resolve, reject) => {
    const signal = init.signal as AbortSignal | undefined;
    if (signal?.aborted) {
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      return;
    }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init.headers || {}) as Record<string, string>)) headers[k] = v;
    const req = mod.request(
      url,
      { method: init.method || 'GET', headers, lookup, agent: new mod.Agent({ keepAlive: false, lookup } as any) },
      (res) => {
        const outHeaders = new Headers();
        for (const [k, v] of Object.entries(res.headers)) {
          if (typeof v === 'string') outHeaders.set(k, v);
          else if (Array.isArray(v)) outHeaders.set(k, v.join(', '));
        }
        const status = res.statusCode || 502;
        const noBody = status === 204 || status === 304 || init.method === 'HEAD';
        const body = noBody ? null : (Readable.toWeb(res) as unknown as ReadableStream);
        resolve(new Response(body, { status, headers: outHeaders }));
      },
    );
    const onAbort = () => req.destroy(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    signal?.addEventListener('abort', onAbort, { once: true });
    req.on('error', (err: any) => {
      signal?.removeEventListener('abort', onAbort);
      reject(signal?.aborted ? Object.assign(new Error('aborted'), { name: 'AbortError' }) : err);
    });
    req.end();
  });
}

/** Validates one hop: scheme, hostname, DNS answers, caller policy. */
export async function assertHopAllowed(
  rawUrl: string,
  opts: Pick<SafeCrawlFetchOptions, 'isUrlAllowed' | 'lookupImpl'>,
): Promise<CrawlFetchFailure | null> {
  let u: URL;
  try { u = new URL(rawUrl); } catch { return 'invalid_url'; }
  const proto = u.protocol.toLowerCase();
  if (proto !== 'http:' && proto !== 'https:') return 'unsupported_protocol';
  if (u.username || u.password) return 'blocked_host';

  const host = normalizeHostname(u.hostname);
  if (!host) return 'blocked_host';
  if (!opts.isUrlAllowed(u.toString())) return 'blocked_host';
  if (allowLocal()) return null;
  if (isBlockedHostname(host)) return 'blocked_host';

  const isIpv6Literal = host.includes(':');
  const isIpv4Literal = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
  if (isIpv4Literal || isIpv6Literal) {
    return isBlockedIpAddress(host, isIpv6Literal ? 6 : 4) ? 'blocked_host' : null;
  }

  const lookupAll = opts.lookupImpl || ((h: string) => dnsLookup(h, { all: true }));
  let answers: LookupAddress[];
  try { answers = await lookupAll(host); } catch { return 'dns_failure'; }
  if (!answers?.length) return 'dns_failure';
  for (const a of answers) {
    if (isBlockedIpAddress(a.address, a.family)) return 'blocked_host';
  }
  return null;
}

/** Reads a response body with a hard streaming byte cap. Exported for other hardened-transport callers (e.g. the SEO crawler). */
export async function readCapped(res: Response, maxBytes: number): Promise<string | null> {
  const body = res.body as any;
  if (!body || typeof body.getReader !== 'function') {
    const buf = await res.arrayBuffer();
    if (buf.byteLength > maxBytes) return null;
    return new TextDecoder('utf-8', { fatal: false }).decode(buf);
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch { /* ignore */ }
      return null;
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { merged.set(c, offset); offset += c.byteLength; }
  return new TextDecoder('utf-8', { fatal: false }).decode(merged);
}

export async function safeCrawlFetch(
  startUrl: string,
  opts: SafeCrawlFetchOptions,
): Promise<SafeCrawlFetchResult> {
  const doFetch = opts.fetchImpl || (pinnedFetch as unknown as typeof fetch);
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const contentTypeAllowed = opts.isContentTypeAllowed
    || ((ct: string) => ct.includes('text/html') || ct.includes('application/xhtml'));
  const deadline = Date.now() + opts.timeoutMs;
  let url = startUrl;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const violation = await assertHopAllowed(url, opts);
    if (violation) {
      return { ok: false, error: hop === 0 ? violation : 'redirect_blocked', finalUrl: url };
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) return { ok: false, error: 'timeout', finalUrl: url };

    const ctrl = new AbortController();
    // The timer stays armed for the whole hop — headers AND body streaming.
    const timer = setTimeout(() => ctrl.abort(), remaining);
    try {
      let res: Response;
      try {
        res = await doFetch(url, {
          signal: ctrl.signal,
          redirect: 'manual',
          headers: {
            'user-agent': opts.userAgent,
            accept: opts.accept || 'text/html,application/xhtml+xml',
          },
        });
      } catch (err: any) {
        return {
          ok: false,
          finalUrl: url,
          error: err?.name === 'AbortError' ? 'timeout' : (err?.message?.slice(0, 120) || 'fetch_error'),
        };
      }

      if (REDIRECT_STATUSES.has(res.status)) {
        const location = res.headers.get('location');
        try { await res.body?.cancel(); } catch { /* ignore */ }
        if (!location) return { ok: false, status: res.status, error: 'redirect_blocked', finalUrl: url };
        try { url = new URL(location, url).toString(); }
        catch { return { ok: false, error: 'redirect_blocked', finalUrl: url }; }
        continue;
      }

      if (!res.ok) return { ok: false, status: res.status, error: `http_${res.status}`, finalUrl: url };

      const ct = (res.headers.get('content-type') || '').toLowerCase();
      if (!contentTypeAllowed(ct)) {
        return { ok: false, status: res.status, error: 'unsupported_content_type', finalUrl: url };
      }
      const declared = parseInt(res.headers.get('content-length') || '', 10);
      if (Number.isFinite(declared) && declared > opts.maxBytes) {
        return { ok: false, status: res.status, error: 'page_too_large', finalUrl: url };
      }

      let html: string | null;
      try {
        html = await readCapped(res, opts.maxBytes);
      } catch (err: any) {
        const aborted = err?.name === 'AbortError' || ctrl.signal.aborted;
        return {
          ok: false,
          status: res.status,
          finalUrl: url,
          error: aborted ? 'timeout' : 'fetch_error',
        };
      }
      if (html === null) return { ok: false, status: res.status, error: 'page_too_large', finalUrl: url };
      return { ok: true, html, status: res.status, finalUrl: url };
    } finally {
      clearTimeout(timer);
    }
  }

  return { ok: false, error: 'too_many_redirects', finalUrl: url };
}