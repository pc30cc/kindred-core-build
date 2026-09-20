/**
 * CDN Provider implementations — all vendors, backend-only
 * Supports: Cloudflare, Bunny, Fastly, CloudFront, KeyCDN,
 *           ArvanCloud, IranServer, ParsPacke, DerakCloud,
 *           Medianova, Turkcell
 */

import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import * as crypto from 'crypto';

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
}

export interface CDNTestResult {
  success: boolean;
  latencyMs: number;
  provider: string;
  error?: string;
  details?: string;
}

// ─── Cloudflare ──────────────────────────────────────────────────

async function cloudflarePurge(config: CDNConfig, paths: string[]): Promise<CDNPurgeResult> {
  const url = `https://api.cloudflare.com/client/v4/zones/${config.zoneId}/purge_cache`;
  const body = paths.length === 0
    ? { purge_everything: true }
    : { files: paths.map(p => `https://${config.domain}${p}`) };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.apiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const data = await res.json() as any;
  if (!data.success) return { success: false, error: data.errors?.[0]?.message || 'Purge failed' };
  return { success: true, purgedPaths: paths.length ? paths : ['*'] };
}

async function cloudflareTest(config: CDNConfig): Promise<CDNTestResult> {
  const start = Date.now();
  try {
    const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${config.zoneId}`, {
      headers: { 'Authorization': `Bearer ${config.apiToken}` },
    });
    const data = await res.json() as any;
    return {
      success: data.success === true,
      latencyMs: Date.now() - start,
      provider: 'cloudflare',
      details: data.success ? `Zone: ${data.result?.name}` : data.errors?.[0]?.message,
      error: data.success ? undefined : 'Auth failed',
    };
  } catch (e: any) {
    return { success: false, latencyMs: Date.now() - start, provider: 'cloudflare', error: e.message };
  }
}

function cloudflareGetUrl(config: CDNConfig, path: string): string {
  return `https://${config.domain}${path}`;
}

// ─── Bunny CDN ───────────────────────────────────────────────────

async function bunnyPurge(config: CDNConfig, paths: string[]): Promise<CDNPurgeResult> {
  // Bunny purge by URL
  for (const p of paths) {
    await fetch('https://api.bunny.net/purge?' + new URLSearchParams({ url: `https://${config.hostname}${p}` }), {
      method: 'POST',
      headers: { 'AccessKey': config.apiKey! },
    });
  }
  if (paths.length === 0) {
    // Purge all — purge pull zone
    await fetch(`https://api.bunny.net/pullzone/${config.pullZoneId}/purgeCache`, {
      method: 'POST',
      headers: { 'AccessKey': config.apiKey! },
    });
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
    const data = await res.json() as any;
    return { success: true, latencyMs: Date.now() - start, provider: 'bunny', details: `Zone: ${data.Name}` };
  } catch (e: any) {
    return { success: false, latencyMs: Date.now() - start, provider: 'bunny', error: e.message };
  }
}

function bunnyGetUrl(config: CDNConfig, path: string): string {
  return `https://${config.hostname}${path}`;
}

// ─── Fastly ──────────────────────────────────────────────────────

async function fastlyPurge(config: CDNConfig, paths: string[]): Promise<CDNPurgeResult> {
  if (paths.length === 0) {
    await fetch(`https://api.fastly.com/service/${config.serviceId}/purge_all`, {
      method: 'POST',
      headers: { 'Fastly-Key': config.apiToken! },
    });
  } else {
    for (const p of paths) {
      await fetch(`https://${config.domain}${p}`, {
        method: 'PURGE',
        headers: { 'Fastly-Key': config.apiToken! },
      });
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
  } catch (e: any) {
    return { success: false, latencyMs: Date.now() - start, provider: 'fastly', error: e.message };
  }
}

function fastlyGetUrl(config: CDNConfig, path: string): string {
  return `https://${config.domain}${path}`;
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
    const res = await fetch(`https://${config.domain}/`, { method: 'HEAD' });
    return { success: true, latencyMs: Date.now() - start, provider: 'aws_cloudfront', details: `Status: ${res.status}` };
  } catch (e: any) {
    return { success: false, latencyMs: Date.now() - start, provider: 'aws_cloudfront', error: e.message };
  }
}

function cloudfrontGetUrl(config: CDNConfig, path: string): string {
  return `https://${config.domain}${path}`;
}

// ─── KeyCDN ──────────────────────────────────────────────────────

async function keycdnPurge(config: CDNConfig, paths: string[]): Promise<CDNPurgeResult> {
  const url = paths.length === 0
    ? `https://api.keycdn.com/zones/purge/${config.zoneId}.json`
    : `https://api.keycdn.com/zones/purgeurl/${config.zoneId}.json`;

  const body = paths.length ? { urls: paths.map(p => `${config.zoneUrl}${p}`) } : undefined;

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
  } catch (e: any) {
    return { success: false, latencyMs: Date.now() - start, provider: 'keycdn', error: e.message };
  }
}

function keycdnGetUrl(config: CDNConfig, path: string): string {
  return `${config.zoneUrl}${path}`;
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

  const data = await res.json().catch(() => ({})) as any;
  return { success: res.ok, purgedPaths: paths.length ? paths : ['*'], error: res.ok ? undefined : data.message };
}

async function arvanTest(config: CDNConfig): Promise<CDNTestResult> {
  const start = Date.now();
  try {
    const res = await fetch(`https://napi.arvancloud.ir/cdn/4.0/domains/${config.domain}`, {
      headers: { 'Authorization': `Apikey ${config.apiKey}` },
    });
    const data = await res.json().catch(() => ({})) as any;
    return {
      success: res.ok,
      latencyMs: Date.now() - start,
      provider: 'arvancloud',
      details: data.data?.domain ? `Domain: ${data.data.domain}` : undefined,
      error: res.ok ? undefined : data.message || `HTTP ${res.status}`,
    };
  } catch (e: any) {
    return { success: false, latencyMs: Date.now() - start, provider: 'arvancloud', error: e.message };
  }
}

function arvanGetUrl(config: CDNConfig, path: string): string {
  return `https://${config.domain}${path}`;
}

// ─── IranServer CDN ──────────────────────────────────────────────

async function iranserverPurge(config: CDNConfig, paths: string[]): Promise<CDNPurgeResult> {
  // IranServer CDN purge — REST API
  const url = `https://api.iranserver.com/cdn/v1/purge`;
  const body = paths.length === 0
    ? { domain: config.domain, purge_all: true }
    : { domain: config.domain, urls: paths.map(p => `https://${config.domain}${p}`) };

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
    const res = await fetch(`https://${config.domain}/`, { method: 'HEAD' });
    return { success: res.status < 500, latencyMs: Date.now() - start, provider: 'iranserver_cdn', details: `Status: ${res.status}` };
  } catch (e: any) {
    return { success: false, latencyMs: Date.now() - start, provider: 'iranserver_cdn', error: e.message };
  }
}

// ─── ParsPacke CDN ───────────────────────────────────────────────

async function parspackPurge(config: CDNConfig, paths: string[]): Promise<CDNPurgeResult> {
  const url = `https://api.parspack.com/cdn/v1/zones/${config.zoneName}/purge`;
  const body = paths.length === 0
    ? { purge_everything: true }
    : { files: paths.map(p => `https://${config.domain}${p}`) };

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
    const res = await fetch(`https://${config.domain}/`, { method: 'HEAD' });
    return { success: res.status < 500, latencyMs: Date.now() - start, provider: 'parspack_cdn', details: `Status: ${res.status}` };
  } catch (e: any) {
    return { success: false, latencyMs: Date.now() - start, provider: 'parspack_cdn', error: e.message };
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
  } catch (e: any) {
    return { success: false, latencyMs: Date.now() - start, provider: 'derakcloud', error: e.message };
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
    : { type: 'file', urls: paths.map(p => `https://${config.domain}${p}`) };

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
  } catch (e: any) {
    return { success: false, latencyMs: Date.now() - start, provider: 'medianova', error: e.message };
  }
}

// ─── Turkcell Bulut CDN ──────────────────────────────────────────

async function turkcellPurge(config: CDNConfig, paths: string[]): Promise<CDNPurgeResult> {
  const url = `https://api.bulutcdn.turkcell.com.tr/v1/purge`;
  const body = paths.length === 0
    ? { domain: config.domain, purge_all: true }
    : { domain: config.domain, urls: paths.map(p => `https://${config.domain}${p}`) };

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
    const res = await fetch(`https://${config.domain}/`, { method: 'HEAD' });
    return { success: res.status < 500, latencyMs: Date.now() - start, provider: 'turkcell_cdn', details: `Status: ${res.status}` };
  } catch (e: any) {
    return { success: false, latencyMs: Date.now() - start, provider: 'turkcell_cdn', error: e.message };
  }
}

// ─── Generic URL helper ──────────────────────────────────────────

function genericGetUrl(config: CDNConfig, path: string): string {
  return `https://${config.domain}${path}`;
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
function mapDBConfigToCDN(provider: string, c: any): CDNConfig {
  return {
    provider,
    apiKey: c.api_key || c.api_token,
    apiToken: c.api_token,
    apiSecret: c.api_secret,
    domain: c.domain || c.custom_domain || c.cdn_domain,
    zoneId: c.zone_id,
    pullZoneId: c.pull_zone_id,
    hostname: c.hostname,
    serviceId: c.service_id,
    accessKeyId: c.access_key_id,
    secretAccessKey: c.secret_access_key,
    distributionId: c.distribution_id,
    zoneUrl: c.zone_url,
    zoneName: c.zone_name,
  };
}

/**
 * Resolve CDN config for a workspace from DB.
 * Resolution: workspace override → global default → null
 */
export async function resolveCDNConfig(serverConfig: ServerConfig, workspaceId: string): Promise<CDNConfig | null> {
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
    return mapDBConfigToCDN(wsConfig.provider_name, wsConfig.config as any);
  }

  // 2. Global default
  const { data: globalConfig } = await sb
    .from('app_runtime_config')
    .select('value')
    .eq('key', 'default_cdn_provider')
    .single();

  if (globalConfig?.value) {
    const c = globalConfig.value as any;
    return mapDBConfigToCDN(c.provider || c.provider_name, c);
  }

  return null;
}

/**
 * Purge CDN cache for paths.
 */
export async function purgeCDN(
  serverConfig: ServerConfig,
  workspaceId: string,
  paths: string[]
): Promise<CDNPurgeResult> {
  const config = await resolveCDNConfig(serverConfig, workspaceId);
  if (!config) return { success: false, error: 'No CDN provider configured' };

  const handler = purgeHandlers[config.provider];
  if (!handler) return { success: false, error: `Unsupported CDN provider: ${config.provider}` };

  try {
    return await handler(config, paths);
  } catch (e: any) {
    return { success: false, error: e.message };
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
  } catch (e: any) {
    return { success: false, latencyMs: 0, provider: config.provider, error: e.message };
  }
}

/**
 * Get CDN asset URL.
 */
export function getCDNAssetUrl(config: CDNConfig, path: string): string {
  const handler = urlHandlers[config.provider];
  if (!handler) return path;
  return handler(config, path);
}
