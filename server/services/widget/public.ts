import type { Request } from 'express';
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { extractHostname, isOriginAllowed, normalizeDomain } from '../../utils/domain.js';

const CACHE_TTL = 60_000;

/**
 * These two caches are keyed by request-derived values (hostname / origin),
 * so without a bound they grow with the number of DISTINCT hosts a caller
 * sends — including hosts an attacker can invent. Entries were only ever
 * checked for freshness on read, never evicted, which made this a steady
 * heap-growth source. Both are now hard-capped with a TTL sweep, then
 * oldest-first eviction (Map preserves insertion order).
 */
const CACHE_MAX_ENTRIES = 1000;

const workspaceByHostCache = new Map<string, { workspaceId: string | null; ts: number }>();
const originRulesCache = new Map<string, { domains: string[]; allowSubdomains: boolean; ts: number }>();

function boundCache(cache: Map<string, { ts: number }>): void {
  if (cache.size <= CACHE_MAX_ENTRIES) return;
  const now = Date.now();
  for (const [key, value] of cache) {
    if (now - value.ts >= CACHE_TTL) cache.delete(key);
  }
  let excess = cache.size - CACHE_MAX_ENTRIES;
  if (excess <= 0) return;
  for (const key of cache.keys()) {
    if (excess-- <= 0) break;
    cache.delete(key);
  }
}

function isFresh(ts: number) {
  return Date.now() - ts < CACHE_TTL;
}


function uniqueStrings(values: Array<string | null | undefined>) {
  return Array.from(new Set(values.filter((value): value is string => !!value && value.trim().length > 0)));
}

export function getRequestOrigin(req: Request): string | null {
  const origin = req.headers.origin;
  return typeof origin === 'string' && origin.length > 0 ? origin : null;
}

export function getBootstrapOrigin(req: Request): string | null {
  const queryOrigin = typeof req.query.origin === 'string' ? req.query.origin : null;
  if (queryOrigin) return queryOrigin;

  const requestOrigin = getRequestOrigin(req);
  if (requestOrigin) return requestOrigin;

  const referer = req.headers.referer;
  return typeof referer === 'string' && referer.length > 0 ? referer : null;
}

export function getLoaderAssetBase(req: Request): string | null {
  if (typeof req.query.loader_origin === 'string') {
    return normalizeBaseUrl(req.query.loader_origin);
  }

  if (typeof req.query.asset_base === 'string') {
    return normalizeBaseUrl(req.query.asset_base);
  }

  return null;
}

/**
 * Is the immediate peer a proxy Express is configured to trust?
 * Mirrors Express' own `trust proxy fn` so we never honour
 * `X-Forwarded-Proto` / `X-Forwarded-Host` sent by a direct client.
 */
function isTrustedProxyHop(req: Request): boolean {
  try {
    const trust = req.app?.get('trust proxy fn');
    if (typeof trust !== 'function') return false;
    return !!trust(req.socket?.remoteAddress, 0);
  } catch {
    return false;
  }
}

export function getRequestBaseUrl(req: Request): string {
  const trusted = isTrustedProxyHop(req);

  const forwardedProto = trusted ? req.headers['x-forwarded-proto'] : undefined;
  const forwardedHost = trusted ? req.headers['x-forwarded-host'] : undefined;

  const proto =
    (Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto?.split(',')[0])?.trim() ||
    req.protocol;
  const host =
    (Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost?.split(',')[0])?.trim() ||
    req.get('host') ||
    'localhost';

  return `${proto}://${host}`.replace(/\/$/, '');
}

export function normalizeBaseUrl(input: string | null | undefined): string | null {
  if (!input) return null;

  try {
    const url = new URL(input.trim());
    return `${url.protocol}//${url.host}${url.pathname}`.replace(/\/$/, '');
  } catch {
    return null;
  }
}

export function resolveWidgetAssetBase(options: {
  widgetBaseUrl?: string | null;
  widgetLoaderBaseUrl?: string | null;
  widgetPublicBaseUrl?: string | null;
  assetBaseUrl?: string | null;
  loaderAssetBase?: string | null;
}) {
  return normalizeBaseUrl(options.widgetBaseUrl)
    || normalizeBaseUrl(options.widgetLoaderBaseUrl)
    || normalizeBaseUrl(options.widgetPublicBaseUrl)
    || normalizeBaseUrl(options.loaderAssetBase)
    || normalizeBaseUrl(options.assetBaseUrl)
    || null;
}

export function resolveWidgetApiBase(options: {
  widgetApiBaseUrl?: string | null;
  platformApiBaseUrl?: string | null;
  requestBaseUrl?: string | null;
  allowRequestFallback?: boolean;
}) {
  return normalizeBaseUrl(options.widgetApiBaseUrl)
    || normalizeBaseUrl(options.platformApiBaseUrl)
    || (options.allowRequestFallback ? normalizeBaseUrl(options.requestBaseUrl) : null)
    || null;
}

export async function resolveWorkspaceIdFromOrigin(config: ServerConfig, origin: string | null): Promise<string | null> {
  if (!origin) return null;

  const originHost = extractHostname(origin);
  if (!originHost) return null;

  const normalizedHost = normalizeDomain(originHost);
  const cached = workspaceByHostCache.get(normalizedHost);
  if (cached && isFresh(cached.ts)) {
    return cached.workspaceId;
  }

  const supabase = getServiceClient(config);
  const { data: domainRows, error } = await supabase
    .from('workspace_domains')
    .select('workspace_id, domain, verified')
    .eq('verified', true);

  if (error) throw error;

  const rows = (domainRows || []).map((row: any) => ({
    workspace_id: row.workspace_id as string,
    domain: normalizeDomain(row.domain),
  }));

  const exactMatch = rows.find((row) => row.domain === normalizedHost);
  if (exactMatch) {
    workspaceByHostCache.set(normalizedHost, { workspaceId: exactMatch.workspace_id, ts: Date.now() });
  boundCache(workspaceByHostCache);
    return exactMatch.workspace_id;
  }

  const candidates = rows.filter((row) => normalizedHost.endsWith(`.${row.domain}`));
  if (!candidates.length) {
    workspaceByHostCache.set(normalizedHost, { workspaceId: null, ts: Date.now() });
  boundCache(workspaceByHostCache);
    return null;
  }

  const workspaceIds = Array.from(new Set(candidates.map((row) => row.workspace_id)));
  const { data: widgetRows, error: widgetError } = await supabase
    .from('widget_settings')
    .select('workspace_id, allow_subdomains')
    .in('workspace_id', workspaceIds);

  if (widgetError) throw widgetError;

  const allowSubdomainMap = new Map((widgetRows || []).map((row: any) => [row.workspace_id as string, !!row.allow_subdomains]));
  const matched = candidates
    .filter((row) => allowSubdomainMap.get(row.workspace_id))
    .sort((a, b) => b.domain.length - a.domain.length)[0];

  const workspaceId = matched?.workspace_id || null;
  workspaceByHostCache.set(normalizedHost, { workspaceId, ts: Date.now() });
  boundCache(workspaceByHostCache);
  return workspaceId;
}

export async function getWorkspaceOriginRules(config: ServerConfig, workspaceId: string) {
  const cached = originRulesCache.get(workspaceId);
  if (cached && isFresh(cached.ts)) {
    return { domains: cached.domains, allowSubdomains: cached.allowSubdomains };
  }

  const supabase = getServiceClient(config);
  const [{ data: widgetData, error: widgetError }, { data: domainData, error: domainError }] = await Promise.all([
    supabase
      .from('widget_settings')
      .select('allowed_domains, allow_subdomains')
      .eq('workspace_id', workspaceId)
      .maybeSingle(),
    supabase
      .from('workspace_domains')
      .select('domain, verified')
      .eq('workspace_id', workspaceId)
      .eq('verified', true),
  ]);

  if (widgetError) throw widgetError;
  if (domainError) throw domainError;

  // Plan gate: when the plan does not include the embed domain allowlist the
  // workspace list is ignored entirely (the feature is off, not enforced).
  let allowlistGranted = true;
  try {
    const { resolveWidgetEntitlements } = await import('./entitlements.js');
    const ent = await resolveWidgetEntitlements(config, workspaceId);
    allowlistGranted = ent.features.widget_domain_allowlist !== false;
  } catch {
    /* best-effort: keep the stored rules on resolution failure */
  }

  const domains = uniqueStrings([
    ...(allowlistGranted ? ((widgetData?.allowed_domains as string[] | null) || []) : []),
    ...((domainData || []).map((row: any) => row.domain)),
  ]);


  const result = {
    domains,
    allowSubdomains: allowlistGranted ? (widgetData?.allow_subdomains ?? false) : false,
  };


  originRulesCache.set(workspaceId, { ...result, ts: Date.now() });
  boundCache(originRulesCache);
  return result;
}

export async function isWorkspaceOriginAllowed(config: ServerConfig, workspaceId: string, origin: string | null) {
  if (!origin) return true;

  const { domains, allowSubdomains } = await getWorkspaceOriginRules(config, workspaceId);
  return !domains.length || isOriginAllowed(origin, domains, allowSubdomains);
}