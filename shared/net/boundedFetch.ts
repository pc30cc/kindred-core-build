/**
 * Bounded, redirect-aware byte download for URLs that did not originate from
 * a fully trusted source (provider webhooks, queued job payloads).
 *
 * What it guarantees, on top of plain `fetch`:
 *   - every URL in the chain (the initial one AND each redirect hop) is run
 *     through a caller-supplied policy before a request is made — redirects
 *     are never followed blindly (`redirect: 'manual'`);
 *   - request headers can be scoped per hop, so a credential meant for one
 *     host is never replayed to a redirect target on another;
 *   - the body is streamed and the download aborted as soon as it exceeds
 *     `maxBytes` (a declared Content-Length above the cap is refused before
 *     a single body byte is read), so a hostile endpoint cannot make us
 *     buffer an unbounded response.
 *
 * `assertPublicHttpUrl` is the standard policy building block: it resolves
 * the host and rejects loopback / private / link-local / metadata targets
 * using the shared SSRF rules in `hostGuard.ts`. It closes the obvious SSRF
 * cases; it does not pin the resolved address into the socket, so it is not
 * a defence against a DNS-rebinding attacker who controls the domain.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import { isBlockedHostname, isBlockedIpAddress, normalizeHostname } from './hostGuard.js';

export type BoundedFetchReason =
  | 'invalid_url'
  | 'unsafe_scheme'
  | 'credentials_not_allowed'
  | 'host_not_allowed'
  | 'dns_failure'
  | 'blocked_ip'
  | 'redirect_blocked'
  | 'too_many_redirects'
  | 'too_large'
  | 'empty_body'
  | 'http_status'
  | 'timeout';

export class BoundedFetchError extends Error {
  readonly reason: BoundedFetchReason;
  /** HTTP status for `http_status` failures. */
  readonly status: number | null;
  constructor(reason: BoundedFetchReason, status: number | null = null, detail?: string) {
    super(detail ? `${reason}: ${detail}` : status != null ? `${reason}_${status}` : reason);
    this.name = 'BoundedFetchError';
    this.reason = reason;
    this.status = status;
  }
}

export type LookupAll = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

const defaultLookup: LookupAll = (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

/**
 * Rejects anything that is not a plain http(s) URL to a PUBLIC address.
 * Fail-closed: DNS errors and any blocked answer reject the URL.
 */
export async function assertPublicHttpUrl(
  url: URL,
  opts: { allowHttp?: boolean; lookupImpl?: LookupAll } = {},
): Promise<void> {
  if (url.protocol !== 'https:' && !(opts.allowHttp && url.protocol === 'http:')) {
    throw new BoundedFetchError('unsafe_scheme');
  }
  if (url.username || url.password) throw new BoundedFetchError('credentials_not_allowed');
  const host = normalizeHostname(url.hostname);
  if (!host || isBlockedHostname(host)) throw new BoundedFetchError('host_not_allowed');

  const isV4Literal = /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
  const isV6Literal = host.includes(':');
  if (isV4Literal || isV6Literal) {
    if (isBlockedIpAddress(host, isV6Literal ? 6 : 4)) throw new BoundedFetchError('blocked_ip');
    return;
  }

  let answers: Array<{ address: string; family: number }>;
  try {
    answers = await (opts.lookupImpl ?? defaultLookup)(host);
  } catch {
    throw new BoundedFetchError('dns_failure');
  }
  if (!answers || answers.length === 0) throw new BoundedFetchError('dns_failure');
  for (const answer of answers) {
    if (isBlockedIpAddress(answer.address, answer.family)) throw new BoundedFetchError('blocked_ip');
  }
}

/** Case-insensitive host allow-list match: exact names and `*.suffix` patterns. */
export function hostMatches(hostname: string, patterns: readonly string[]): boolean {
  const host = normalizeHostname(hostname);
  return patterns.some((pattern) => {
    const p = pattern.toLowerCase();
    if (p.startsWith('*.')) {
      const suffix = p.slice(1); // ".example.com"
      return host.endsWith(suffix) && host.length > suffix.length;
    }
    return host === p;
  });
}

export interface BoundedFetchOptions {
  maxBytes: number;
  /** Throws (ideally a BoundedFetchError) to refuse a URL; runs for every hop. */
  validate: (url: URL, hop: number) => Promise<void> | void;
  /** Headers for a given hop. Called per hop so credentials can be host-scoped. */
  headers?: (url: URL, hop: number) => Record<string, string> | undefined;
  /** 0 (default) refuses every redirect. */
  maxRedirects?: number;
  timeoutMs?: number;
  /** Test seam. */
  fetchImpl?: typeof fetch;
}

export interface BoundedFetchResult {
  bytes: Uint8Array;
  contentType: string | null;
  finalUrl: string;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const DEFAULT_TIMEOUT_MS = 120_000;

async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    throw new BoundedFetchError('too_large');
  }
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new BoundedFetchError('too_large');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * GETs `rawUrl` under the given policy and returns the (size-capped) body.
 * Non-2xx final responses throw `BoundedFetchError('http_status', status)`.
 */
export async function fetchBytesBounded(rawUrl: string, opts: BoundedFetchOptions): Promise<BoundedFetchResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const maxRedirects = Math.max(0, opts.maxRedirects ?? 0);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  let current: URL;
  try {
    current = new URL(rawUrl);
  } catch {
    clearTimeout(timer);
    throw new BoundedFetchError('invalid_url');
  }

  try {
    for (let hop = 0; ; hop++) {
      await opts.validate(current, hop);
      const res = await fetchImpl(current.toString(), {
        method: 'GET',
        headers: opts.headers?.(current, hop) ?? {},
        redirect: 'manual',
        signal: controller.signal,
      });

      if (REDIRECT_STATUSES.has(res.status)) {
        await res.body?.cancel().catch(() => undefined);
        const location = res.headers.get('location');
        if (!location) throw new BoundedFetchError('redirect_blocked', res.status, 'redirect without location');
        if (hop >= maxRedirects) throw new BoundedFetchError(maxRedirects === 0 ? 'redirect_blocked' : 'too_many_redirects');
        try {
          current = new URL(location, current);
        } catch {
          throw new BoundedFetchError('redirect_blocked', res.status, 'invalid location');
        }
        continue;
      }

      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        throw new BoundedFetchError('http_status', res.status);
      }

      const bytes = await readCapped(res, opts.maxBytes);
      return { bytes, contentType: res.headers.get('content-type'), finalUrl: current.toString() };
    }
  } catch (err) {
    if ((err as { name?: string })?.name === 'AbortError') throw new BoundedFetchError('timeout');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
