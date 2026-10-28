/**
 * Which hostnames belong to the platform itself, never to a customer.
 *
 * A verified `workspace_domains` row maps a host to a workspace
 * (`resolveWorkspaceIdFromOrigin`: the help center by Host, origin-only widget
 * bootstrap, widget CORS), and an exact row beats the platform workspace's
 * suffix match on its apex. A row for `api.<brand>` or `app.<brand>` in a
 * customer's workspace would therefore take over the platform's own help
 * center on its API host. Such a row can come from a customer's free-text
 * website: `trg_workspaces_auto_register_owner_domain` verifies the account
 * owner's `profiles.website_domain` on every workspace INSERT, with no check
 * of what it names.
 *
 * The answer is per deployment, read from the brand's own configuration, so
 * no brand literal lives in code (WebYar and RESPOK each read their own
 * database):
 *   - the apex: `platform_domains.primary_domain`, else the host of
 *     `canonical_base_url` or `public_base_url`. The apex and every subdomain
 *     of it are platform hosts.
 *   - exact hosts, for a service that lives off the apex: every URL of
 *     `platform_domains` and `widget_platform_settings`, `CORS_ORIGINS`,
 *     `PUBLIC_CHANNELS_BASE_URL` and `AI_RUNTIME_URL`.
 *
 * The one workspace allowed to hold platform hosts is the platform's own: the
 * workspace that holds the verified apex row (WebYar's "وب یار" for
 * webyar.ai, RESPOK's for respok.app). There is no other notion of it.
 *
 * Read like platformOrigins.ts: cached in-process for a minute, served stale
 * while one refresh runs. The first call waits for the first read, so the
 * guard is never open just because the process is new.
 */

import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';

const TTL_MS = 60_000;
const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;

export interface PlatformHosts {
  /** The brand's root domain, `webyar.ai`; null while nothing names it. */
  apex: string | null;
  /** Exact platform hosts, the apex's subdomains not listed one by one. */
  hosts: ReadonlySet<string>;
}

/** Strips outer dots and every leading `www.` (`www.www.x` is `x` in SQL too). */
function bareHost(host: string): string {
  let value = host;
  for (;;) {
    const next = value.replace(/^\.+|\.+$/g, '').replace(/^www\./, '');
    if (next === value) return value;
    value = next;
  }
}

/** IDN to punycode, fullwidth and ideographic dots to `.`, `%xx` decoded. */
function urlHost(host: string): string | null {
  if (!host) return null;
  try {
    return new URL(`http://${host}`).hostname;
  } catch {
    return null;
  }
}

/** The authority of a host-ish input: whitespace, scheme, path, query, fragment gone. */
function authorityOf(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  let value = raw.replace(/\s+/g, '').toLowerCase();
  for (;;) {
    const next = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/^\/+/, '');
    if (next === value) break;
    value = next;
  }
  return value.split(/[/?#\\]/, 1)[0];
}

/**
 * Every host a free-text domain may come to mean, for the platform check.
 *
 * A superset on purpose: the stored value goes through SQL `normalize_domain`
 * (cuts at `/` and `:`, strips one `www.`) and then the generated
 * `normalized_domain` (cuts at `?` and `#` too, strips another `www.`), while
 * a request host goes through `URL`. So both readings count: the part before
 * the first `:` (what SQL keeps: `api.x:1@shop.com` is `api.x`), and the part
 * after any userinfo (what a URL reads), each raw and through `URL`. Over-
 * matching an odd spelling only refuses something no customer owns.
 */
export function hostCandidates(raw: unknown): string[] {
  const authority = authorityOf(raw);
  if (!authority) return [];
  const sqlPart = authority.split(':', 1)[0];
  const urlPart = authority.slice(authority.lastIndexOf('@') + 1).split(':', 1)[0];
  const out = new Set<string>();
  for (const part of [sqlPart, urlPart]) {
    for (const form of [part, urlHost(part)]) {
      const host = form ? bareHost(form) : '';
      if (host) out.add(host);
    }
  }
  return Array.from(out);
}

/** One configured URL or domain as a bare ASCII host, or null. */
export function canonicalHost(raw: unknown): string | null {
  const authority = authorityOf(raw);
  const part = authority.slice(authority.lastIndexOf('@') + 1).split(':', 1)[0];
  if (!part || part === '*') return null;
  return bareHost(urlHost(part) ?? part) || null;
}

/** An apex must be a registrable-looking name: `ai` or an IP would cover customers. */
function asApex(raw: unknown): string | null {
  const host = canonicalHost(raw);
  if (!host || !host.includes('.') || IPV4_RE.test(host) || host.startsWith('[')) return null;
  return host;
}

/** Pure check against a loaded set (the resolver and the tests use it directly). */
export function isPlatformHostIn(platform: PlatformHosts, raw: unknown): boolean {
  const { apex, hosts } = platform;
  return hostCandidates(raw).some(
    (host) => hosts.has(host) || (!!apex && (host === apex || host.endsWith(`.${apex}`))),
  );
}

type Row = Record<string, unknown> | null | undefined;

function build(config: ServerConfig, domains: Row, widget: Row): PlatformHosts {
  const apex = asApex(domains?.primary_domain)
    ?? asApex(domains?.canonical_base_url)
    ?? asApex(domains?.public_base_url);
  const sources: unknown[] = [
    domains?.primary_domain,
    domains?.canonical_base_url,
    domains?.public_base_url,
    domains?.app_base_url,
    domains?.api_base_url,
    domains?.help_center_base_url,
    domains?.email_base_url,
    widget?.widget_loader_base_url,
    widget?.widget_asset_base_url,
    widget?.widget_public_base_url,
    widget?.widget_api_base_url,
    ...(config.corsOrigins || []),
    config.publicChannelsBaseUrl,
    config.aiRuntimeBaseUrl,
  ];
  const hosts = new Set<string>();
  for (const source of sources) {
    const host = canonicalHost(source);
    if (host) hosts.add(host);
  }
  return { apex, hosts };
}

let cache: PlatformHosts | null = null;
let cachedAt = 0;
let inFlight: Promise<void> | null = null;
let warnedEmpty = false;

async function refresh(config: ServerConfig): Promise<void> {
  try {
    const sb = getServiceClient(config);
    const [domains, widget] = await Promise.all([
      sb.from('platform_domains')
        .select('primary_domain, canonical_base_url, public_base_url, app_base_url, api_base_url, help_center_base_url, email_base_url')
        .limit(1)
        .maybeSingle(),
      sb.from('widget_platform_settings')
        .select('widget_loader_base_url, widget_asset_base_url, widget_public_base_url, widget_api_base_url')
        .limit(1)
        .maybeSingle(),
    ]);
    if (domains.error) throw domains.error;
    if (widget.error) throw widget.error;
    cache = build(config, domains.data as Row, widget.data as Row);
    cachedAt = Date.now();
    if (!cache.apex && !warnedEmpty) {
      warnedEmpty = true;
      console.warn(
        '[platformHosts] platform_domains names no platform domain (primary, canonical or public URL): '
        + 'subdomains of the platform are not protected from customer domain claims until Super Admin → Domains sets one.',
      );
    }
  } catch (err: unknown) {
    // Keep what we had; with nothing yet, the environment's hosts still count.
    // Retry soon, not per request.
    if (!cache) cache = build(config, null, null);
    cachedAt = Date.now() - TTL_MS + 5_000;
    console.warn('[platformHosts] refresh failed:', err instanceof Error ? err.message : err);
  } finally {
    inFlight = null;
  }
}

/** The platform's hosts for this deployment (cached; see the header). */
export async function getPlatformHosts(config: ServerConfig): Promise<PlatformHosts> {
  if (!cache) {
    if (!inFlight) inFlight = refresh(config);
    await inFlight;
    return cache ?? build(config, null, null);
  }
  if (Date.now() - cachedAt > TTL_MS && !inFlight) inFlight = refresh(config);
  return cache;
}

/** Is `raw` (a domain, URL or host in any spelling) one of the platform's own hosts? */
export async function isPlatformHost(config: ServerConfig, raw: unknown): Promise<boolean> {
  if (typeof raw !== 'string' || !raw.trim()) return false;
  return isPlatformHostIn(await getPlatformHosts(config), raw);
}

/** Is this the platform's own workspace, the one holding the verified apex row? */
export async function isPlatformWorkspace(config: ServerConfig, workspaceId: string): Promise<boolean> {
  const { apex } = await getPlatformHosts(config);
  if (!apex) return false;
  const { data, error } = await getServiceClient(config)
    .from('workspace_domains')
    .select('id')
    .eq('workspace_id', workspaceId)
    .eq('verified', true)
    .eq('normalized_domain', apex)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return !!data;
}

/**
 * A profile website (`profiles.website_domain`) becomes a VERIFIED domain of
 * the account's next workspace (the trigger in the header). True when `next`
 * names a platform host and is not the value already stored, so a form that
 * sends the stored value back unchanged (Super Admin → Users saves the whole
 * row) still saves; a stored one is dropped before a workspace is created
 * (`dropPlatformWebsite`).
 */
export async function isNewPlatformWebsite(
  config: ServerConfig,
  userId: string,
  next: string | null | undefined,
): Promise<boolean> {
  if (!next || !(await isPlatformHost(config, next))) return false;
  const { data } = await getServiceClient(config)
    .from('profiles')
    .select('website_domain')
    .eq('id', userId)
    .maybeSingle();
  return (data as { website_domain?: string | null } | null)?.website_domain !== next;
}

/**
 * Clears the owner's website when it names a platform host, right before a
 * workspace INSERT that would have the trigger verify it for that workspace.
 * Covers values stored before the profile writers refused them, or written
 * outside the app. Conditional on the value read, so a concurrent edit wins.
 */
export async function dropPlatformWebsite(config: ServerConfig, ownerId: string): Promise<void> {
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('profiles')
    .select('website_domain')
    .eq('id', ownerId)
    .maybeSingle();
  if (error) throw error;
  const website = (data as { website_domain?: string | null } | null)?.website_domain;
  if (!website || !(await isPlatformHost(config, website))) return;
  const { error: clearError } = await sb
    .from('profiles')
    .update({ website_domain: null, updated_at: new Date().toISOString() })
    .eq('id', ownerId)
    .eq('website_domain', website);
  if (clearError) throw clearError;
  console.warn(`[platformHosts] cleared a platform host from the website of ${ownerId} before creating a workspace`);
}

/** Super Admin → Domains saved: read the platform's hosts again on next use. */
export function invalidatePlatformHosts(): void {
  cachedAt = 0;
}

/** Test-only. */
export function __resetPlatformHostsCache(): void {
  cache = null;
  cachedAt = 0;
  inFlight = null;
  warnedEmpty = false;
}
