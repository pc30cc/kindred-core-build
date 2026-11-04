/**
 * CDN Provider implementations — all vendors, backend-only
 * Supports: Cloudflare, Bunny, Fastly, CloudFront, KeyCDN,
 *           ArvanCloud, IranServer, ParsPacke, DerakCloud,
 *           Medianova, Turkcell
 */

import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import * as crypto from 'crypto';
import { checkOutboundUrl } from '../../../shared/net/hostGuard.js';

export interface CDNConfig {
  provider: string;
  // Common
  apiKey?: string;
  apiToken?: string;
  apiSecret?: string;
  domain?: string;
  // Cloudflare
  zoneId?: string;
  // Bunny
  pullZoneId?: string;
  hostname?: string;
  // Fastly
  serviceId?: string;
  // CloudFront
  accessKeyId?: string;
  secretAccessKey?: string;
  distributionId?: string;
  // KeyCDN
  zoneUrl?: string;
  // ArvanCloud / DerakCloud
  // (use apiKey + domain)
  // ParsPacke
  zoneName?: string;
}

export interface CDNPurgeResult {
  success: boolean;
  purgedPaths?: string[];
  error?: string;
  /** The request itself was refused (bad paths), not the provider: answer 400. */
  invalidRequest?: boolean;
}

export interface CDNTestResult {
  success: boolean;
  latencyMs: number;
  provider: string;
  error?: string;
  details?: string;
}

/** The fields this module reads from the vendors' JSON answers. */
interface VendorBody {
  success?: boolean;
  errors?: Array<{ message?: string }>;
  result?: { name?: string };
  message?: string;
  data?: { domain?: string };
  Name?: string;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ─── Safe URL building ───────────────────────────────────────────

/** `https://cdn.example.com/` or `cdn.example.com` → `cdn.example.com`; the forms type the host as a URL. */
export function cdnHostOf(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const host = value.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  return host || undefined;
}

export class CDNPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CDNPathError';
  }
}

/**
 * The absolute URL of `path` on the CDN host `host`, or a CDNPathError when
 * the result would not be on that host. Building it as `https://${host}${path}`
 * let a path like `@evil.example/x` or `//evil.example/x` move the request (and,
 * on Fastly, its `Fastly-Key` header) to another host.
 */
export function cdnUrlFor(host: string | undefined, path: string): string {
  const cleanHost = cdnHostOf(host);
  if (!cleanHost) throw new CDNPathError('CDN host is not configured');
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) {
    throw new CDNPathError('CDN path must start with a single /');
  }
  let base: URL;
  try {
    base = new URL(`https://${cleanHost}`);
  } catch {
    throw new CDNPathError('CDN host is not a valid host name');
  }
  const url = new URL(path, base);
  if (url.protocol !== 'https:' || url.host !== base.host || url.username || url.password) {
    throw new CDNPathError('CDN path leaves the CDN host');
  }
  return url.toString();
}

/**
 * The "Test" button's HEAD to a CDN domain the Super Admin typed: a public
 * https host only (no internal service, no metadata address), and no
 * redirect followed, so the probe can never be pointed inside the network.
 */
async function probeCdnDomain(domain: string | undefined): Promise<Response> {
  const url = cdnUrlFor(domain, '/');
  const check = await checkOutboundUrl(url);
  if (!check.ok) throw new CDNPathError(`CDN domain refused (${(check as { reason?: string }).reason})`);
  return fetch(url, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(10_000) });
}

async function failureOf(res: Response, label: string): Promise<string> {
  const body = await res.text().catch(() => '');
  return `${label} failed: HTTP ${res.status}${body ? ` ${body.slice(0, 200)}` : ''}`;
}

// ─── Cloudflare ──────────────────────────────────────────────────

async function cloudflarePurge(config: CDNConfig, paths: string[]): Promise<CDNPurgeResult> {
  const url = `https://api.cloudflare.com/client/v4/zones/${config.zoneId}/purge_cache`;
  const body = paths.length === 0
    ? { purge_everything: true }
    : { files: paths.map(p => cdnUrlFor(config.domain, p)) };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.apiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const data = await res.json().catch(() => ({})) as VendorBody;
  if (!res.ok || !data.success) return { success: false, error: data.errors?.[0]?.message || `Purge failed: HTTP ${res.status}` };
  return { success: true, purgedPaths: paths.length ? paths : ['*'] };
}

async function cloudflareTest(config: CDNConfig): Promise<CDNTestResult> {
  const start = Date.now();
  try {
    const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${config.zoneId}`, {
      headers: { 'Authorization': `Bearer ${config.apiToken}` },
    });
    const data = await res.json().catch(() => ({})) as VendorBody;
    return {
      success: data.success === true,
      latencyMs: Date.now() - start,
      provider: 'cloudflare',
      details: data.success ? `Zone: ${data.result?.name}` : data.errors?.[0]?.message,
      error: data.success ? undefined : 'Auth failed',
    };
  } catch (e: unknown) {
    return { success: false, latencyMs: Date.now() - start, provider: 'cloudflare', error: errorMessage(e) };
  }
}

function cloudflareGetUrl(config: CDNConfig, path: string): string {
  return cdnUrlFor(config.domain, path);
}

// ─── Bunny CDN ───────────────────────────────────────────────────

async function bunnyPurge(config: CDNConfig, paths: string[]): Promise<CDNPurgeResult> {
  // Bunny purge by URL. Every answer is checked: a 401 (wrong key) used to
  // be reported as a successful purge.
  const urls = paths.map((p) => cdnUrlFor(config.hostname || config.domain, p));
  for (const url of urls) {
    const res = await fetch('https://api.bunny.net/purge?' + new URLSearchParams({ url }), {
      method: 'POST',
      headers: { 'AccessKey': config.apiKey! },
    });
    if (!res.ok) return { success: false, error: await failureOf(res, 'Bunny purge') };
  }
  if (paths.length === 0) {
    // Purge all — purge pull zone
    const res = await fetch(`https://api.bunny.net/pullzone/${encodeURIComponent(String(config.pullZoneId ?? ''))}/purgeCache`, {
      method: 'POST',
      headers: { 'AccessKey': config.apiKey! },
    });
    if (!res.ok) return { success: false, error: await failureOf(res, 'Bunny purge') };
  }
  return { success: true, purgedPaths: paths.length ? paths : ['*'] };
}

async function bunnyTest(config: CDNConfig): Promise<CDNTestResult> {
  const start = Date.now();
  try {
    const res = await fetch(`https://api.bunny.net/pullzone/${config.pullZoneId}`, {
      headers: { 'AccessKey': config.apiKey! },
    });
    if (!res.ok) return { success: false, latencyMs: Date.now() - start, provider: 'bunny', error: `HTTP ${res.status}` };
    const data = await res.json().catch(() => ({})) as VendorBody;
    return { success: true, latencyMs: Date.now() - start, provider: 'bunny', details: `Zone: ${data.Name}` };
  } catch (e: unknown) {
    return { success: false, latencyMs: Date.now() - start, provider: 'bunny', error: errorMessage(e) };
  }
}

function bunnyGetUrl(config: CDNConfig, path: string): string {
  return cdnUrlFor(config.hostname || config.domain, path);
}

// ─── Fastly ──────────────────────────────────────────────────────

async function fastlyPurge(config: CDNConfig, paths: string[]): Promise<CDNPurgeResult> {
  if (paths.length === 0) {
    const res = await fetch(`https://api.fastly.com/service/${encodeURIComponent(String(config.serviceId ?? ''))}/purge_all`, {
      method: 'POST',
      headers: { 'Fastly-Key': config.apiToken! },
    });
    if (!res.ok) return { success: false, error: await failureOf(res, 'Fastly purge') };
  } else {
    // Every URL is built and checked before the key is sent anywhere.
    const urls = paths.map((p) => cdnUrlFor(config.domain, p));
    for (const url of urls) {
      const res = await fetch(url, {
        method: 'PURGE',
        headers: { 'Fastly-Key': config.apiToken! },
        redirect: 'manual',
      });
      if (!res.ok) return { success: false, error: await failureOf(res, 'Fastly purge') };
    }
  }
  return { success: true, purgedPaths: paths.length ? paths : ['*'] };
}

async function fastlyTest(config: CDNConfig): Promise<CDNTestResult> {
  const start = Date.now();
  try {
    const res = await fetch(`https://api.fastly.com/service/${config.serviceId}/details`, {
      headers: { 'Fastly-Key': config.apiToken! },
    });
    if (!res.ok) return { success: false, latencyMs: Date.now() - start, provider: 'fastly', error: `HTTP ${res.status}` };
    return { success: true, latencyMs: Date.now() - start, provider: 'fastly' };
  } catch (e: unknown) {
    return { success: false, latencyMs: Date.now() - start, provider: 'fastly', error: errorMessage(e) };
  }
}

function fastlyGetUrl(config: CDNConfig, path: string): string {
  return cdnUrlFor(config.domain, path);
}

// ─── AWS CloudFront ──────────────────────────────────────────────

async function cloudfrontPurge(config: CDNConfig, paths: string[]): Promise<CDNPurgeResult> {
  // CloudFront invalidation requires SigV4 — simplified version
  const invalidationPaths = paths.length ? paths : ['/*'];
  const callerRef = `purge-${Date.now()}`;
  const xmlBody = `<?xml version="1.0" encoding="UTF-8"?>
<InvalidationBatch xmlns="http://cloudfront.amazonaws.com/doc/2020-05-31/">
  <CallerReference>${callerRef}</CallerReference>
  <Paths>
    <Quantity>${invalidationPaths.length}</Quantity>
    <Items>${invalidationPaths.map(p => `<Path>${p}</Path>`).join('')}</Items>
  </Paths>
</InvalidationBatch>`;

  const now = new Date();
  const dateStr = now.toISOString().replace(/[:-]|\.\d{3}/g, '').slice(0, 8);
  const timeStr = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const region = 'us-east-1'; // CloudFront is global but uses us-east-1
  const host = 'cloudfront.amazonaws.com';
  const urlPath = `/2020-05-31/distribution/${config.distributionId}/invalidation`;

  const payloadHash = crypto.createHash('sha256').update(xmlBody).digest('hex');
  const canonicalHeaders = `content-type:application/xml\nhost:${host}\nx-amz-date:${timeStr}\n`;
  const signedHeaders = 'content-type;host;x-amz-date';
  const canonicalRequest = `POST\n${urlPath}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  const credScope = `${dateStr}/${region}/cloudfront/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${timeStr}\n${credScope}\n${crypto.createHash('sha256').update(canonicalRequest).digest('hex')}`;

  const kDate = crypto.createHmac('sha256', `AWS4${config.secretAccessKey}`).update(dateStr).digest();
  const kRegion = crypto.createHmac('sha256', kDate).update(region).digest();
  const kService = crypto.createHmac('sha256', kRegion).update('cloudfront').digest();
  const kSigning = crypto.createHmac('sha256', kService).update('aws4_request').digest();
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  const res = await fetch(`https://${host}${urlPath}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/xml',
      'Host': host,
      'X-Amz-Date': timeStr,
      'Authorization': `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${credScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    body: xmlBody,
  });

  return { success: res.ok, purgedPaths: invalidationPaths, error: res.ok ? undefined : `HTTP ${res.status}` };
}

async function cloudfrontTest(config: CDNConfig): Promise<CDNTestResult> {
  const start = Date.now();
  // Simple check: try to get distribution info
  try {
    const res = await probeCdnDomain(config.domain);
    return { success: true, latencyMs: Date.now() - start, provider: 'aws_cloudfront', details: `Status: ${res.status}` };
  } catch (e: unknown) {
    return { success: false, latencyMs: Date.now() - start, provider: 'aws_cloudfront', error: errorMessage(e) };
  }
}

function cloudfrontGetUrl(config: CDNConfig, path: string): string {
  return cdnUrlFor(config.domain, path);
}

// ─── KeyCDN ──────────────────────────────────────────────────────

async function keycdnPurge(config: CDNConfig, paths: string[]): Promise<CDNPurgeResult> {
  const url = paths.length === 0
    ? `https://api.keycdn.com/zones/purge/${config.zoneId}.json`
    : `https://api.keycdn.com/zones/purgeurl/${config.zoneId}.json`;

  const body = paths.length ? { urls: paths.map(p => cdnUrlFor(config.zoneUrl, p)) } : undefined;

  const res = await fetch(url, {
    method: paths.length ? 'DELETE' : 'GET',
    headers: {
      'Authorization': `Basic ${Buffer.from(config.apiKey + ':').toString('base64')}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  return { success: res.ok, purgedPaths: paths.length ? paths : ['*'] };
}

async function keycdnTest(config: CDNConfig): Promise<CDNTestResult> {
  const start = Date.now();
  try {
    const res = await fetch(`https://api.keycdn.com/zones/${config.zoneId}.json`, {
      headers: { 'Authorization': `Basic ${Buffer.from(config.apiKey + ':').toString('base64')}` },
    });
    return { success: res.ok, latencyMs: Date.now() - start, provider: 'keycdn', error: res.ok ? undefined : `HTTP ${res.status}` };
  } catch (e: unknown) {
    return { success: false, latencyMs: Date.now() - start, provider: 'keycdn', error: errorMessage(e) };
  }
}

function keycdnGetUrl(config: CDNConfig, path: string): string {
  return cdnUrlFor(config.zoneUrl, path);
}

// ─── ArvanCloud (Iran) ───────────────────────────────────────────

async function arvanPurge(config: CDNConfig, paths: string[]): Promise<CDNPurgeResult> {
  // ArvanCloud CDN cache purge API
  const url = `https://napi.arvancloud.ir/cdn/4.0/domains/${config.domain}/caching`;
  const body = paths.length === 0
    ? { purge: 'all' }
    : { purge: paths };

  const res = await fetch(url, {
    method: 'DELETE',
    headers: {
      'Authorization': `Apikey ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const data = await res.json().catch(() => ({})) as VendorBody;
  return { success: res.ok, purgedPaths: paths.length ? paths : ['*'], error: res.ok ? undefined : data.message };
}

async function arvanTest(config: CDNConfig): Promise<CDNTestResult> {
  const start = Date.now();
  try {
    const res = await fetch(`https://napi.arvancloud.ir/cdn/4.0/domains/${config.domain}`, {
      headers: { 'Authorization': `Apikey ${config.apiKey}` },
    });
    const data = await res.json().catch(() => ({})) as VendorBody;
    return {
      success: res.ok,
      latencyMs: Date.now() - start,
      provider: 'arvancloud',
      details: data.data?.domain ? `Domain: ${data.data.domain}` : undefined,
      error: res.ok ? undefined : data.message || `HTTP ${res.status}`,
    };
  } catch (e: unknown) {
    return { success: false, latencyMs: Date.now() - start, provider: 'arvancloud', error: errorMessage(e) };
  }
}

function arvanGetUrl(config: CDNConfig, path: string): string {
  return cdnUrlFor(config.domain, path);
}

// ─── IranServer CDN ──────────────────────────────────────────────

async function iranserverPurge(config: CDNConfig, paths: string[]): Promise<CDNPurgeResult> {
  // IranServer CDN purge — REST API
  const url = `https://api.iranserver.com/cdn/v1/purge`;
  const body = paths.length === 0
    ? { domain: config.domain, purge_all: true }
    : { domain: config.domain, urls: paths.map(p => cdnUrlFor(config.domain, p)) };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  return { success: res.ok, purgedPaths: paths.length ? paths : ['*'] };
}

async function iranserverTest(config: CDNConfig): Promise<CDNTestResult> {
  const start = Date.now();
  try {
    // Test by hitting the CDN domain directly
    const res = await probeCdnDomain(config.domain);
    return { success: res.status < 500, latencyMs: Date.now() - start, provider: 'iranserver_cdn', details: `Status: ${res.status}` };
  } catch (e: unknown) {
    return { success: false, latencyMs: Date.now() - start, provider: 'iranserver_cdn', error: errorMessage(e) };
  }
}

// ─── ParsPacke CDN ───────────────────────────────────────────────

async function parspackPurge(config: CDNConfig, paths: string[]): Promise<CDNPurgeResult> {
  const url = `https://api.parspack.com/cdn/v1/zones/${config.zoneName}/purge`;
  const body = paths.length === 0
    ? { purge_everything: true }
    : { files: paths.map(p => cdnUrlFor(config.domain, p)) };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  return { success: res.ok, purgedPaths: paths.length ? paths : ['*'] };
}

async function parspackTest(config: CDNConfig): Promise<CDNTestResult> {
  const start = Date.now();
  try {
    const res = await probeCdnDomain(config.domain);
    return { success: res.status < 500, latencyMs: Date.now() - start, provider: 'parspack_cdn', details: `Status: ${res.status}` };
  } catch (e: unknown) {
    return { success: false, latencyMs: Date.now() - start, provider: 'parspack_cdn', error: errorMessage(e) };
  }
}

// ─── DerakCloud (Iran) ───────────────────────────────────────────

async function derakPurge(config: CDNConfig, paths: string[]): Promise<CDNPurgeResult> {
  const url = `https://api.derak.cloud/v1/domains/${config.domain}/cache/purge`;
  const body = paths.length === 0
    ? { purge_all: true }
    : { paths };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.apiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  return { success: res.ok, purgedPaths: paths.length ? paths : ['*'] };
}

async function derakTest(config: CDNConfig): Promise<CDNTestResult> {
  const start = Date.now();
  try {
    const res = await fetch(`https://api.derak.cloud/v1/domains/${config.domain}`, {
      headers: { 'Authorization': `Bearer ${config.apiToken}` },
    });
    return { success: res.ok, latencyMs: Date.now() - start, provider: 'derakcloud', error: res.ok ? undefined : `HTTP ${res.status}` };
  } catch (e: unknown) {
    return { success: false, latencyMs: Date.now() - start, provider: 'derakcloud', error: errorMessage(e) };
  }
}

// ─── Medianova (Turkey) ──────────────────────────────────────────

async function medianovaPurge(config: CDNConfig, paths: string[]): Promise<CDNPurgeResult> {
  // Medianova purge API
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = crypto.createHmac('sha256', config.apiSecret || '')
    .update(`${config.apiKey}${timestamp}`)
    .digest('hex');

  const url = `https://api.medianova.com/v1/zone/${config.zoneId}/purge`;
  const body = paths.length === 0
    ? { type: 'all' }
    : { type: 'file', urls: paths.map(p => cdnUrlFor(config.domain, p)) };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'X-MN-APIKey': config.apiKey!,
      'X-MN-Timestamp': timestamp,
      'X-MN-Signature': signature,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  return { success: res.ok, purgedPaths: paths.length ? paths : ['*'] };
}

async function medianovaTest(config: CDNConfig): Promise<CDNTestResult> {
  const start = Date.now();
  try {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = crypto.createHmac('sha256', config.apiSecret || '')
      .update(`${config.apiKey}${timestamp}`)
      .digest('hex');

    const res = await fetch(`https://api.medianova.com/v1/zone/${config.zoneId}`, {
      headers: {
        'X-MN-APIKey': config.apiKey!,
        'X-MN-Timestamp': timestamp,
        'X-MN-Signature': signature,
      },
    });
    return { success: res.ok, latencyMs: Date.now() - start, provider: 'medianova', error: res.ok ? undefined : `HTTP ${res.status}` };
  } catch (e: unknown) {
    return { success: false, latencyMs: Date.now() - start, provider: 'medianova', error: errorMessage(e) };
  }
}

// ─── Turkcell Bulut CDN ──────────────────────────────────────────

async function turkcellPurge(config: CDNConfig, paths: string[]): Promise<CDNPurgeResult> {
  const url = `https://api.bulutcdn.turkcell.com.tr/v1/purge`;
  const body = paths.length === 0
    ? { domain: config.domain, purge_all: true }
    : { domain: config.domain, urls: paths.map(p => cdnUrlFor(config.domain, p)) };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  return { success: res.ok, purgedPaths: paths.length ? paths : ['*'] };
}

async function turkcellTest(config: CDNConfig): Promise<CDNTestResult> {
  const start = Date.now();
  try {
    const res = await probeCdnDomain(config.domain);
    return { success: res.status < 500, latencyMs: Date.now() - start, provider: 'turkcell_cdn', details: `Status: ${res.status}` };
  } catch (e: unknown) {
    return { success: false, latencyMs: Date.now() - start, provider: 'turkcell_cdn', error: errorMessage(e) };
  }
}

// ─── Generic URL helper ──────────────────────────────────────────

function genericGetUrl(config: CDNConfig, path: string): string {
  return cdnUrlFor(config.domain, path);
}

// ─── Provider Router ─────────────────────────────────────────────

const purgeHandlers: Record<string, (config: CDNConfig, paths: string[]) => Promise<CDNPurgeResult>> = {
  cloudflare: cloudflarePurge,
  bunny: bunnyPurge,
  fastly: fastlyPurge,
  aws_cloudfront: cloudfrontPurge,
  keycdn: keycdnPurge,
  arvancloud: arvanPurge,
  iranserver_cdn: iranserverPurge,
  parspack_cdn: parspackPurge,
  derakcloud: derakPurge,
  medianova: medianovaPurge,
  turkcell_cdn: turkcellPurge,
};

const testHandlers: Record<string, (config: CDNConfig) => Promise<CDNTestResult>> = {
  cloudflare: cloudflareTest,
  bunny: bunnyTest,
  fastly: fastlyTest,
  aws_cloudfront: cloudfrontTest,
  keycdn: keycdnTest,
  arvancloud: arvanTest,
  iranserver_cdn: iranserverTest,
  parspack_cdn: parspackTest,
  derakcloud: derakTest,
  medianova: medianovaTest,
  turkcell_cdn: turkcellTest,
};

const urlHandlers: Record<string, (config: CDNConfig, path: string) => string> = {
  cloudflare: cloudflareGetUrl,
  bunny: bunnyGetUrl,
  fastly: fastlyGetUrl,
  aws_cloudfront: cloudfrontGetUrl,
  keycdn: keycdnGetUrl,
  arvancloud: arvanGetUrl,
  iranserver_cdn: genericGetUrl,
  parspack_cdn: genericGetUrl,
  derakcloud: genericGetUrl,
  medianova: genericGetUrl,
  turkcell_cdn: genericGetUrl,
};

/**
 * Map DB config row to CDNConfig
 */
/** A stored field as text: ids may have been saved as numbers. */
function field(c: Record<string, unknown>, key: string): string | undefined {
  const v = c[key];
  if (typeof v === 'string') return v.trim() || undefined;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return undefined;
}

function mapDBConfigToCDN(provider: string, c: Record<string, unknown>): CDNConfig {
  return {
    provider,
    apiKey: field(c, 'api_key') || field(c, 'api_token'),
    apiToken: field(c, 'api_token'),
    apiSecret: field(c, 'api_secret'),
    domain: cdnHostOf(field(c, 'domain') || field(c, 'custom_domain') || field(c, 'cdn_domain')),
    zoneId: field(c, 'zone_id'),
    pullZoneId: field(c, 'pull_zone_id'),
    hostname: cdnHostOf(field(c, 'hostname')),
    serviceId: field(c, 'service_id'),
    accessKeyId: field(c, 'access_key_id'),
    secretAccessKey: field(c, 'secret_access_key'),
    distributionId: field(c, 'distribution_id'),
    zoneUrl: field(c, 'zone_url'),
    zoneName: field(c, 'zone_name'),
  };
}

/**
 * `app_runtime_config.default_cdn_provider` as Super Admin → Providers → CDN
 * saves it: `{ provider_name, config: { api_key, hostname, … } }`
 * (src/providers/sync.ts). An older flat row (`{ provider, api_key, … }`) is
 * read too. The whole value used to be mapped as if it were flat, so every
 * credential and host came out undefined: deleted owners' files stayed on
 * the CDN and asset URLs read `https://undefined/…`.
 */
export function cdnConfigFromRuntimeValue(value: unknown): CDNConfig | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const c = value as Record<string, unknown>;
  const provider = typeof c.provider_name === 'string' ? c.provider_name : typeof c.provider === 'string' ? c.provider : '';
  if (!provider) return null;
  const fields = c.config && typeof c.config === 'object' && !Array.isArray(c.config) ? (c.config as Record<string, unknown>) : c;
  return mapDBConfigToCDN(provider, fields);
}

/** Whose CDN serves a workspace: its own (provider_configs) or the platform's default. */
export type CDNConfigSource = 'workspace' | 'platform';

/**
 * Resolve CDN config for a workspace from DB, with where it came from.
 * Resolution: workspace override → global default → null
 */
export async function resolveCDNConfigWithSource(
  serverConfig: ServerConfig,
  workspaceId: string,
): Promise<{ config: CDNConfig; source: CDNConfigSource } | null> {
  const sb = getServiceClient(serverConfig);

  // 1. Workspace override
  // .maybeSingle(), not .single(): "this workspace has no override" is the
  // NORMAL case (provider_configs is empty on a fresh install), and .single()
  // answers 0 rows with PostgREST 406 — one rejected transaction per call.
  // The error was also dropped, so a genuine read failure was indistinguishable
  // from "no override" and fell through to the global default unnoticed.
  const { data: wsConfig, error: wsConfigError } = await sb
    .from('provider_configs')
    .select('*')
    .eq('workspace_id', workspaceId)
    .eq('provider_type', 'cdn')
    .eq('is_active', true)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (wsConfigError) {
    // Fall through to the global default (intended behaviour) but say so.
    console.error('[cdn] provider_configs lookup failed:', wsConfigError.message);
  }

  if (wsConfig?.config) {
    return { config: mapDBConfigToCDN(wsConfig.provider_name, wsConfig.config as Record<string, unknown>), source: 'workspace' };
  }

  // 2. Global default
  const { data: globalConfig, error: globalConfigError } = await sb
    .from('app_runtime_config')
    .select('value')
    .eq('key', 'default_cdn_provider')
    .maybeSingle();
  if (globalConfigError) {
    console.error('[cdn] default_cdn_provider lookup failed:', globalConfigError.message);
  }

  const platform = cdnConfigFromRuntimeValue(globalConfig?.value);
  return platform ? { config: platform, source: 'platform' } : null;
}

/**
 * Resolve CDN config for a workspace from DB.
 * Resolution: workspace override → global default → null
 */
export async function resolveCDNConfig(serverConfig: ServerConfig, workspaceId: string): Promise<CDNConfig | null> {
  return (await resolveCDNConfigWithSource(serverConfig, workspaceId))?.config ?? null;
}

/** At most this many paths in one purge request. */
export const MAX_PURGE_PATHS = 100;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The paths a workspace may purge, or why not.
 *
 * On its OWN CDN (a provider_configs override) a workspace may purge any
 * path, or everything (no paths). On the PLATFORM's CDN, which every
 * workspace without its own shares, it may purge only its own files: at
 * least one path, each under `/workspace/<its id>/`. Any owner of any
 * workspace could otherwise empty the whole platform cache (Cloudflare
 * purge_everything, the Bunny zone, Fastly purge_all), as often as they liked.
 */
export function purgePathsError(workspaceId: string, source: CDNConfigSource, paths: unknown): string | null {
  if (!Array.isArray(paths)) return 'paths must be an array';
  if (paths.length > MAX_PURGE_PATHS) return `at most ${MAX_PURGE_PATHS} paths per purge`;
  if (source === 'platform' && paths.length === 0) return 'paths are required on the platform CDN';
  const ownPrefix = `/workspace/${workspaceId}/`;
  for (const p of paths) {
    if (typeof p !== 'string' || p.length === 0 || p.length > 1024) return 'invalid path';
    // eslint-disable-next-line no-control-regex
    if (!p.startsWith('/') || p.startsWith('//') || p.includes('\\') || /[\u0000-\u001f\u007f]/.test(p)) return 'invalid path';
    let pathname: string;
    try {
      pathname = new URL(p, 'https://cdn.invalid').pathname;
    } catch {
      return 'invalid path';
    }
    if (source === 'platform') {
      if (!UUID_RE.test(workspaceId)) return 'invalid workspace';
      const lowered = p.toLowerCase();
      // Decoded and normalized: `..`, `%2e%2e` or `%2f` cannot walk out of the prefix.
      if (p.includes('..') || lowered.includes('%2e') || lowered.includes('%2f') || lowered.includes('%5c')) return 'invalid path';
      if (!p.startsWith(ownPrefix) || !pathname.startsWith(ownPrefix)) {
        return `on the platform CDN only paths under ${ownPrefix} may be purged`;
      }
    }
  }
  return null;
}

/**
 * Purge CDN cache for paths of one workspace. The workspace's own CDN when it
 * has one, else the platform's, within purgePathsError's limits.
 */
export async function purgeCDN(
  serverConfig: ServerConfig,
  workspaceId: string,
  paths: string[]
): Promise<CDNPurgeResult> {
  const resolved = await resolveCDNConfigWithSource(serverConfig, workspaceId);
  if (!resolved) return { success: false, error: 'No CDN provider configured' };
  const { config, source } = resolved;

  const pathError = purgePathsError(workspaceId, source, paths);
  if (pathError) return { success: false, error: pathError, invalidRequest: true };

  const handler = purgeHandlers[config.provider];
  if (!handler) return { success: false, error: `Unsupported CDN provider: ${config.provider}` };

  try {
    return await handler(config, paths);
  } catch (e: unknown) {
    return { success: false, error: errorMessage(e), invalidRequest: e instanceof CDNPathError ? true : undefined };
  }
}

/**
 * Test CDN provider connection.
 */
export async function testCDNConnection(config: CDNConfig): Promise<CDNTestResult> {
  const handler = testHandlers[config.provider];
  if (!handler) return { success: false, latencyMs: 0, provider: config.provider, error: `Unknown provider: ${config.provider}` };

  try {
    return await handler(config);
  } catch (e: unknown) {
    return { success: false, latencyMs: 0, provider: config.provider, error: errorMessage(e) };
  }
}

/**
 * Get CDN asset URL.
 */
export function getCDNAssetUrl(config: CDNConfig, path: string): string {
  const handler = urlHandlers[config.provider];
  // Throws CDNPathError for a path that would leave the CDN host.
  if (!handler) return path;
  return handler(config, path);
}
