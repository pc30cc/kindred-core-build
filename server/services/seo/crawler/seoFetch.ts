/**
 * SEO crawler fetch transport — reuses the SAME SSRF-hardened primitives as
 * the Data Hub crawler (`assertHopAllowed`, `pinnedFetch`, `readCapped` from
 * server/services/ai-agent/crawler/safeCrawlFetch.ts) instead of
 * reimplementing redirect validation / DNS-rebinding protection / streaming
 * byte caps. The only reason this file exists (rather than calling
 * `safeCrawlFetch` directly) is that the SEO feature needs richer metadata
 * per fetch than that function returns: the full redirect chain, response
 * timing, and a bounded set of response headers.
 *
 * SSRF guarantees preserved from the underlying transport:
 *   - Every hop (initial URL included) is re-validated: scheme, blocked
 *     hostname/IP, DNS answers — so a same-domain page cannot redirect the
 *     crawler to a private/internal address.
 *   - `isUrlAllowed` (always `isSameDomain(url, canonicalHost)` for page
 *     fetches) additionally re-runs on every hop, so a redirect to a
 *     different domain — internal or public — is rejected before the
 *     second request is ever made.
 *   - Connect-time DNS pinning (`pinnedFetch`) defeats DNS rebinding: the
 *     socket can only open against an address that itself passed the
 *     pre-flight guard.
 *   - The body is read through `readCapped`, which aborts the stream the
 *     moment it exceeds the byte cap.
 *   - A single deadline spans DNS validation, connect, headers AND body
 *     streaming for the whole hop chain.
 */
import type { LookupAddress } from 'node:dns';
import { assertHopAllowed, pinnedFetch, readCapped, type CrawlFetchFailure } from '../../ai-agent/crawler/safeCrawlFetch.js';

export interface SeoFetchOptions {
  userAgent: string;
  timeoutMs: number;
  maxBytes: number;
  isUrlAllowed: (url: string) => boolean;
  maxRedirects?: number;
  accept?: string;
  isContentTypeAllowed?: (contentType: string) => boolean;
  lookupImpl?: (hostname: string) => Promise<LookupAddress[]>;
  fetchImpl?: typeof fetch;
}

export interface RedirectHop {
  url: string;
  status: number;
}

export interface SeoFetchResult {
  ok: boolean;
  html?: string;
  status?: number;
  error?: CrawlFetchFailure | string;
  finalUrl: string;
  redirectChain: RedirectHop[];
  responseTimeMs: number;
  contentType?: string;
  contentLength?: number;
  headers?: Record<string, string>;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const DEFAULT_MAX_REDIRECTS = 5;
const CAPTURED_HEADERS = ['content-type', 'content-length', 'last-modified', 'cache-control', 'x-robots-tag', 'server'];

export async function seoFetch(startUrl: string, opts: SeoFetchOptions): Promise<SeoFetchResult> {
  const doFetch = opts.fetchImpl || (pinnedFetch as unknown as typeof fetch);
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const contentTypeAllowed = opts.isContentTypeAllowed
    || ((ct: string) => ct.includes('text/html') || ct.includes('application/xhtml'));
  const deadline = Date.now() + opts.timeoutMs;
  const startedAt = Date.now();
  const redirectChain: RedirectHop[] = [];
  let url = startUrl;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const violation = await assertHopAllowed(url, opts);
    if (violation) {
      return {
        ok: false,
        error: hop === 0 ? violation : 'redirect_blocked',
        finalUrl: url,
        redirectChain,
        responseTimeMs: Date.now() - startedAt,
      };
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return { ok: false, error: 'timeout', finalUrl: url, redirectChain, responseTimeMs: Date.now() - startedAt };
    }

    const ctrl = new AbortController();
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
          redirectChain,
          responseTimeMs: Date.now() - startedAt,
          error: err?.name === 'AbortError' ? 'timeout' : (err?.message?.slice(0, 120) || 'fetch_error'),
        };
      }

      if (REDIRECT_STATUSES.has(res.status)) {
        const location = res.headers.get('location');
        try { await res.body?.cancel(); } catch { /* ignore */ }
        redirectChain.push({ url, status: res.status });
        if (redirectChain.length > maxRedirects) {
          return { ok: false, error: 'too_many_redirects', finalUrl: url, redirectChain, responseTimeMs: Date.now() - startedAt };
        }
        if (!location) {
          return { ok: false, status: res.status, error: 'redirect_blocked', finalUrl: url, redirectChain, responseTimeMs: Date.now() - startedAt };
        }
        try { url = new URL(location, url).toString(); }
        catch { return { ok: false, error: 'redirect_blocked', finalUrl: url, redirectChain, responseTimeMs: Date.now() - startedAt }; }
        continue;
      }

      const headers: Record<string, string> = {};
      for (const h of CAPTURED_HEADERS) {
        const v = res.headers.get(h);
        if (v) headers[h] = v.slice(0, 500);
      }
      const contentType = (res.headers.get('content-type') || '').toLowerCase() || undefined;
      const declaredLength = parseInt(res.headers.get('content-length') || '', 10);

      if (!res.ok) {
        try { await res.body?.cancel(); } catch { /* ignore */ }
        return {
          ok: false, status: res.status, error: `http_${res.status}`, finalUrl: url, redirectChain,
          responseTimeMs: Date.now() - startedAt, contentType, headers,
        };
      }

      if (contentType && !contentTypeAllowed(contentType)) {
        try { await res.body?.cancel(); } catch { /* ignore */ }
        return {
          ok: false, status: res.status, error: 'unsupported_content_type', finalUrl: url, redirectChain,
          responseTimeMs: Date.now() - startedAt, contentType, headers,
        };
      }
      if (Number.isFinite(declaredLength) && declaredLength > opts.maxBytes) {
        try { await res.body?.cancel(); } catch { /* ignore */ }
        return {
          ok: false, status: res.status, error: 'page_too_large', finalUrl: url, redirectChain,
          responseTimeMs: Date.now() - startedAt, contentType, headers,
        };
      }

      let html: string | null;
      try {
        html = await readCapped(res, opts.maxBytes);
      } catch (err: any) {
        const aborted = err?.name === 'AbortError' || ctrl.signal.aborted;
        return {
          ok: false, status: res.status, finalUrl: url, redirectChain, contentType, headers,
          responseTimeMs: Date.now() - startedAt, error: aborted ? 'timeout' : 'fetch_error',
        };
      }
      if (html === null) {
        return {
          ok: false, status: res.status, error: 'page_too_large', finalUrl: url, redirectChain, contentType, headers,
          responseTimeMs: Date.now() - startedAt,
        };
      }
      return {
        ok: true, html, status: res.status, finalUrl: url, redirectChain,
        responseTimeMs: Date.now() - startedAt, contentType, contentLength: Buffer.byteLength(html, 'utf8'), headers,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  return { ok: false, error: 'too_many_redirects', finalUrl: url, redirectChain, responseTimeMs: Date.now() - startedAt };
}
