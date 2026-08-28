/**
 * SSRF-safe outbound transport, used ONLY by the AI provider connection test
 * (`POST /api/ai/test`). It closes the validate-then-fetch gap: validation, DNS
 * resolution and the actual socket connection all happen inside one boundary,
 * so a hostname cannot resolve to a public IP during the check and to a private
 * IP at connect time (DNS rebinding), and redirects cannot escape the policy.
 *
 * Production/runtime AI completion traffic is deliberately untouched.
 */

import https from 'node:https';
import type { IncomingMessage } from 'node:http';
import { lookup as dnsLookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { isBlockedHostname, isBlockedIpAddress, normalizeHostname } from '../../../shared/net/hostGuard.js';

export type SafeTransportReason =
  | 'unsafe_scheme'
  | 'credentials_not_allowed'
  | 'host_not_allowed'
  | 'dns_failure'
  | 'blocked_ip'
  | 'redirect_blocked'
  | 'too_many_redirects'
  | 'timeout'
  | 'unsupported_request'
  | 'network_error';

export class SafeTransportError extends Error {
  readonly reason: SafeTransportReason;
  constructor(reason: SafeTransportReason) {
    super(reason);
    this.name = 'SafeTransportError';
    this.reason = reason;
  }
}

export type SafeTestFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

type LookupAll = (hostname: string) => Promise<LookupAddress[]>;
type RequestImpl = typeof https.request;

export interface SafeTransportOptions {
  /** Extra per-provider host policy applied to the initial URL and to every redirect. */
  isHostAllowed?: (hostname: string) => boolean;
  /** Shared deadline for the whole redirect chain. */
  timeoutMs?: number;
  maxRedirects?: number;
  /** Test seams — never used in production callers. */
  lookupImpl?: LookupAll;
  requestImpl?: RequestImpl;
}

export const DEFAULT_TEST_TIMEOUT_MS = 10_000;
export const MAX_TEST_REDIRECTS = 3;
/** Connection tests never need large payloads; cap what we buffer. */
const MAX_TEST_RESPONSE_BYTES = 64 * 1024;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Origin = protocol + hostname + effective port (443 when omitted for https). */
function originOf(url: URL): string {
  return `${url.protocol}//${normalizeHostname(url.hostname)}:${url.port || '443'}`;
}

function sameOrigin(a: URL, b: URL): boolean {
  return originOf(a) === originOf(b);
}

/** Validates one URL and pins exactly one verified public address for it. */
async function resolvePinnedTarget(
  url: URL,
  opts: { lookupImpl: LookupAll; isHostAllowed?: (hostname: string) => boolean },
): Promise<{ hostname: string; address: string; family: number }> {
  if (url.protocol !== 'https:') throw new SafeTransportError('unsafe_scheme');
  if (url.username || url.password) throw new SafeTransportError('credentials_not_allowed');

  const hostname = normalizeHostname(url.hostname);
  if (!hostname) throw new SafeTransportError('host_not_allowed');
  if (isBlockedHostname(hostname)) throw new SafeTransportError('host_not_allowed');
  if (opts.isHostAllowed && !opts.isHostAllowed(hostname)) {
    throw new SafeTransportError('host_not_allowed');
  }

  const isIpv4Literal = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
  const isIpv6Literal = hostname.includes(':');
  if (isIpv4Literal || isIpv6Literal) {
    if (isBlockedIpAddress(hostname, isIpv6Literal ? 6 : 4)) {
      throw new SafeTransportError('blocked_ip');
    }
    return { hostname, address: hostname, family: isIpv6Literal ? 6 : 4 };
  }

  let answers: LookupAddress[];
  try {
    answers = await opts.lookupImpl(hostname);
  } catch {
    throw new SafeTransportError('dns_failure');
  }
  if (!answers || answers.length === 0) throw new SafeTransportError('dns_failure');
  for (const a of answers) {
    if (isBlockedIpAddress(a.address, a.family)) throw new SafeTransportError('blocked_ip');
  }
  const chosen = answers[0];
  return { hostname, address: chosen.address, family: chosen.family };
}

function headersToObject(init?: RequestInit): Record<string, string> {
  const out: Record<string, string> = {};
  const h = init?.headers;
  if (!h) return out;
  if (Array.isArray(h)) {
    for (const entry of h) out[String(entry[0])] = String(entry[1]);
  } else if (h instanceof Headers) {
    h.forEach((v, k) => {
      out[k] = v;
    });
  } else {
    for (const [k, v] of Object.entries(h)) out[k] = Array.isArray(v) ? v.join(', ') : String(v);
  }
  return out;
}

function bodyToString(body: RequestInit['body']): string | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return body;
  // Only simple string bodies are supported by the test transport.
  throw new SafeTransportError('unsupported_request');
}

interface RawResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
}

function performRequest(
  requestImpl: RequestImpl,
  target: { hostname: string; address: string; family: number },
  url: URL,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
  remainingMs: number,
): Promise<RawResponse> {
  return new Promise<RawResponse>((resolve, reject) => {
    let settled = false;
    const fail = (err: SafeTransportError) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    const req = requestImpl(
      {
        protocol: 'https:',
        // No connection pooling: a reused keep-alive socket would skip our
        // pinned `lookup` and could target an address we never validated.
        agent: false,
        // `host` keeps the real hostname for the Host header, `servername`
        // keeps TLS SNI + certificate verification on the real hostname.
        host: target.hostname,
        servername: target.hostname,
        port: url.port ? Number(url.port) : 443,
        path: `${url.pathname}${url.search}`,
        method,
        headers,
        timeout: remainingMs,
        // Pin the socket to the exact address we validated: the system resolver
        // is never consulted again for this connection.
        lookup: (_hostname: string, _options: unknown, callback: unknown) => {
          const cb = callback as (
            err: NodeJS.ErrnoException | null,
            address: string,
            family: number,
          ) => void;
          cb(null, target.address, target.family);
        },
      },
      (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        let total = 0;
        res.on('data', (chunk: Buffer) => {
          total += chunk.length;
          if (total <= MAX_TEST_RESPONSE_BYTES) chunks.push(chunk);
          else res.destroy();
        });
        res.on('end', () => {
          if (settled) return;
          settled = true;
          const outHeaders: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            if (typeof v === 'string') outHeaders[k] = v;
            else if (Array.isArray(v)) outHeaders[k] = v.join(', ');
          }
          resolve({
            status: res.statusCode ?? 0,
            statusText: res.statusMessage ?? '',
            headers: outHeaders,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
        res.on('error', () => fail(new SafeTransportError('network_error')));
      },
    );

    req.on('timeout', () => {
      req.destroy();
      fail(new SafeTransportError('timeout'));
    });
    req.on('error', () => fail(new SafeTransportError('network_error')));
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/**
 * Builds a `fetch`-shaped function that validates, DNS-pins and manually
 * follows redirects under one shared deadline.
 */
export function createSafeTestFetch(options: SafeTransportOptions = {}): SafeTestFetch {
  const lookupImpl: LookupAll =
    options.lookupImpl ?? ((hostname: string) => dnsLookup(hostname, { all: true }));
  const requestImpl: RequestImpl = options.requestImpl ?? https.request;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TEST_TIMEOUT_MS;
  const maxRedirects = options.maxRedirects ?? MAX_TEST_REDIRECTS;

  return async (input, init) => {
    const deadline = Date.now() + timeoutMs;
    let url = new URL(typeof input === 'string' ? input : input.toString());
    let method = (init?.method || 'GET').toUpperCase();
    let body = bodyToString(init?.body);
    let headers = headersToObject(init);

    for (let hop = 0; ; hop++) {
      if (hop > maxRedirects) throw new SafeTransportError('too_many_redirects');

      const target = await resolvePinnedTarget(url, { lookupImpl, isHostAllowed: options.isHostAllowed });
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new SafeTransportError('timeout');

      const hopHeaders: Record<string, string> = { ...headers };
      if (body !== undefined) {
        hopHeaders['content-length'] = String(Buffer.byteLength(body));
      }
      const raw = await performRequest(requestImpl, target, url, method, hopHeaders, body, remaining);

      if (!REDIRECT_STATUSES.has(raw.status)) {
        return new Response(raw.body, {
          status: raw.status,
          statusText: raw.statusText,
          headers: raw.headers,
        });
      }

      const location = raw.headers['location'];
      if (!location) throw new SafeTransportError('redirect_blocked');
      let next: URL;
      try {
        next = new URL(location, url);
      } catch {
        throw new SafeTransportError('redirect_blocked');
      }
      if (next.protocol !== 'https:') throw new SafeTransportError('unsafe_scheme');
      if (next.username || next.password) throw new SafeTransportError('credentials_not_allowed');
      // Same-origin only (protocol + hostname + effective port). A connection
      // test never needs to hop between hosts, and refusing outright is safer
      // than trying to strip individual credential-bearing headers.
      if (!sameOrigin(url, next)) throw new SafeTransportError('redirect_blocked');
      // Standard fetch method semantics: 307/308 preserve method+body,
      // 301/302/303 downgrade a non-GET/HEAD request to GET without a body.
      if (raw.status !== 307 && raw.status !== 308 && method !== 'GET' && method !== 'HEAD') {
        method = 'GET';
        body = undefined;
        const stripped: Record<string, string> = {};
        for (const [k, v] of Object.entries(headers)) {
          const lower = k.toLowerCase();
          if (lower !== 'content-type' && lower !== 'content-length') stripped[k] = v;
        }
        headers = stripped;
      }
      url = next;
    }
  };
}

/**
 * Official provider endpoints. Hostnames must match EXACTLY — no suffix
 * matching, so `evil-openai.com` / `api.openai.com.attacker.tld` are rejected.
 */
export const OFFICIAL_AI_PROVIDER_HOSTS: Record<string, readonly string[]> = {
  openai: ['api.openai.com'],
  anthropic: ['api.anthropic.com'],
  gemini: ['generativelanguage.googleapis.com'],
  groq: ['api.groq.com'],
  together: ['api.together.xyz'],
  mistral: ['api.mistral.ai'],
  deepseek: ['api.deepseek.com'],
  perplexity: ['api.perplexity.ai'],
  openrouter: ['openrouter.ai'],
};

/**
 * Host policy for a provider connection test.
 * Group A (official host) → exact allow-list.
 * Group B (custom/self-hosted: azure_openai, ollama, cohere, …) → any public
 * https host that survives DNS validation and pinning.
 */
export function providerHostPolicy(provider: string): ((hostname: string) => boolean) | undefined {
  const allowed = OFFICIAL_AI_PROVIDER_HOSTS[provider];
  if (!allowed) return undefined;
  return (hostname: string) => allowed.includes(normalizeHostname(hostname));
}