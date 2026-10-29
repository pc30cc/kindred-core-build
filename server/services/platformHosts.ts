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
 *   - the apex: of the hosts of `platform_domains` primary, canonical,
 *     public, app and API, the one the most of them are at or under (the
 *     earliest field on a tie). So an empty primary with the canonical URL on
 *     `app.<brand>` and the public one on `<brand>`, or a primary of
 *     `app.<brand>`, still gives `<brand>`, and an API on another domain
 *     does not move it. The apex and every subdomain of it are platform
 *     hosts.
 *   - exact hosts, for a service that lives off the apex: every URL of
 *     `platform_domains` and `widget_platform_settings`, `CORS_ORIGINS`,
 *     `PUBLIC_CHANNELS_BASE_URL` and `AI_RUNTIME_URL`, but never a single
 *     label or loopback (`localhost`, a docker service name such as
 *     `ai-runtime`): no customer site is one, and a dev workspace's verified
 *     `localhost` stays its own.
 *   - the platform's own workspace, the one allowed to hold platform hosts:
 *     the holder of the verified apex row (WebYar's "وب یار" for webyar.ai,
 *     RESPOK's for respok.app), else of the verified row on the shortest
 *     configured host. Found once per read, not from a request's probe.
 *
 * A deployment whose platform_domains names no apex protects nothing: no
 * host is refused and no row ignored, even those of the environment, since
 * the platform's own workspace cannot be told from a customer's there (a
 * self-host whose only workspace verified its site, named in CORS_ORIGINS,
 * keeps it). While the platform's workspace is unknown, the resolver ignores
 * nothing either; the writers still refuse the apex and the exact hosts.
 *
 * Read like platformOrigins.ts: cached in-process for a minute, served stale
 * while one refresh runs. The first call waits for the first read, so the
 * guard is never open just because the process is new: if that read fails,
 * the environment's hosts are refused on write until a read succeeds (retried
 * after 5 s), while the resolver, knowing no platform workspace, ignores
 * nothing.
 */

import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';
import { canonicalWorkspaceId } from '../lib/workspaceId.js';
import { toStrictOrigin } from '../utils/domain.js';
import { isWebsiteHeldBy } from './ownerWebsite.js';

const TTL_MS = 60_000;
const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;

export interface PlatformHosts {
  /** The brand's root domain, `webyar.ai`; null while nothing names it. */
  apex: string | null;
  /** Exact platform hosts, the apex's subdomains not listed one by one. */
  hosts: ReadonlySet<string>;
  /** The platform's own workspace (see the header); null while none is known. */
  workspaceId: string | null;
  /**
   * The platform's own sites as browser origins: the app, public, help
   * center and canonical URLs, and CORS_ORIGINS. Only they read the platform
   * workspace's help center across origins (isPlatformSiteOrigin).
   */
  origins: ReadonlySet<string>;
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

/**
 * The authority of a host-ish input: whitespace, scheme, path, query, fragment
 * gone. Lower-cased the way the database does it: Postgres `lower()` (libc,
 * the image's en_US/C.UTF-8 default, and PGlite) folds U+0130 `İ` to a plain
 * `i`, where JavaScript gives `i` + U+0307, so `app.webyar.aİ` is stored as
 * `app.webyar.ai`. It is the only letter the two fold apart into ASCII (the
 * Kelvin sign U+212A is `k` in both).
 */
function authorityOf(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  let value = raw.replace(/\s+/g, '').replace(/\u0130/g, 'i').toLowerCase();
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

/** A configured exact host, but never a single label or loopback (`localhost`, `ai-runtime`). */
function asExactHost(raw: unknown): string | null {
  const host = canonicalHost(raw);
  if (!host || !host.includes('.') || /^127\./.test(host)) return null;
  return host;
}

const isAtOrUnder = (host: string, parent: string) => host === parent || host.endsWith(`.${parent}`);

/** Pure check against a loaded set (the resolver and the tests use it directly). */
export function isPlatformHostIn(platform: Pick<PlatformHosts, 'apex' | 'hosts'>, raw: unknown): boolean {
  const { apex, hosts } = platform;
  return hostCandidates(raw).some((host) => hosts.has(host) || (!!apex && isAtOrUnder(host, apex)));
}

type Row = Record<string, unknown> | null | undefined;

/**
 * The apex (see the header): the site host the most site fields are at or
 * under, the earliest on a tie. Only a configured host can be it, so no
 * common parent is invented (`co.uk` is nobody's brand).
 */
function apexOf(domains: Row): string | null {
  const sites = [
    domains?.primary_domain,
    domains?.canonical_base_url,
    domains?.public_base_url,
    domains?.app_base_url,
    domains?.api_base_url,
  ].map(asApex).filter((host): host is string => !!host);
  let apex: string | null = null;
  let covered = 0;
  for (const candidate of sites) {
    const count = sites.filter((host) => isAtOrUnder(host, candidate)).length;
    if (count > covered) {
      apex = candidate;
      covered = count;
    }
  }
  return apex;
}

/** The environment's own hosts: what is refused while nothing could be read. */
function environmentHosts(config: ServerConfig): Set<string> {
  const hosts = new Set<string>();
  for (const source of [...(config.corsOrigins || []), config.publicChannelsBaseUrl, config.aiRuntimeBaseUrl]) {
    const host = asExactHost(source);
    if (host) hosts.add(host);
  }
  return hosts;
}

/** The platform's own site origins (PlatformHosts.origins), exact, never `*`. */
function siteOrigins(config: ServerConfig, domains: Row): Set<string> {
  const origins = new Set<string>();
  for (const source of [
    domains?.app_base_url,
    domains?.public_base_url,
    domains?.help_center_base_url,
    domains?.canonical_base_url,
    ...(config.corsOrigins || []),
  ]) {
    const origin = typeof source === 'string' ? toStrictOrigin(source) : null;
    if (origin) origins.add(origin);
  }
  return origins;
}

function build(config: ServerConfig, domains: Row, widget: Row): PlatformHosts {
  const apex = apexOf(domains);
  // Nothing names the platform: nothing is protected (the header says why).
  if (!apex) return { apex: null, hosts: new Set(), workspaceId: null, origins: new Set() };
  const hosts = environmentHosts(config);
  for (const source of [
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
  ]) {
    const host = asExactHost(source);
    if (host) hosts.add(host);
  }
  return { apex, hosts, workspaceId: null, origins: siteOrigins(config, domains) };
}

const labelCount = (host: string) => host.split('.').length;

/**
 * The platform's own workspace: the holder of the verified apex row, else of
 * the verified row on the shortest configured host (fewest labels, then
 * characters). A customer cannot hold either once the apex is known, since
 * every writer refuses them.
 */
async function platformWorkspaceOf(
  sb: ReturnType<typeof getServiceClient>,
  { apex, hosts }: PlatformHosts,
): Promise<string | null> {
  if (!apex) return null;
  const order = [apex, ...Array.from(hosts).filter((host) => host !== apex).sort(
    (a, b) => labelCount(a) - labelCount(b) || a.length - b.length || (a < b ? -1 : 1),
  )];
  const { data, error } = await sb
    .from('workspace_domains')
    .select('workspace_id, normalized_domain')
    .eq('verified', true)
    .in('normalized_domain', order);
  if (error) throw error;
  const holders = new Map(
    ((data || []) as Array<{ workspace_id: string; normalized_domain: string | null }>)
      .map((row) => [String(row.normalized_domain || '').toLowerCase(), row.workspace_id]),
  );
  for (const host of order) {
    const holder = holders.get(host);
    if (holder) return holder;
  }
  return null;
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
    const next = build(config, domains.data as Row, widget.data as Row);
    next.workspaceId = await platformWorkspaceOf(sb, next);
    cache = next;
    cachedAt = Date.now();
    if (!cache.apex && !warnedEmpty) {
      warnedEmpty = true;
      console.warn(
        '[platformHosts] platform_domains names no platform domain (primary, canonical, public, app or API URL): '
        + 'no platform host is protected from customer domain claims until Super Admin → Domains sets one.',
      );
    }
  } catch (err: unknown) {
    // Keep what we had; with nothing yet, refuse the environment's hosts on
    // write, but know no platform workspace, so the resolver ignores nothing.
    // Retry soon, not per request.
    if (!cache) cache = { apex: null, hosts: environmentHosts(config), workspaceId: null, origins: new Set() };
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
    return cache ?? { apex: null, hosts: environmentHosts(config), workspaceId: null, origins: new Set() };
  }
  if (Date.now() - cachedAt > TTL_MS && !inFlight) inFlight = refresh(config);
  return cache;
}

/** Is `raw` (a domain, URL or host in any spelling) one of the platform's own hosts? */
export async function isPlatformHost(config: ServerConfig, raw: unknown): Promise<boolean> {
  if (typeof raw !== 'string' || !raw.trim()) return false;
  return isPlatformHostIn(await getPlatformHosts(config), raw);
}

/** One spelling of a uuid (lib/workspaceId.ts), or the value itself. */
const sameId = (a: string, b: string) => (canonicalWorkspaceId(a) ?? a) === (canonicalWorkspaceId(b) ?? b);

/** Is this the platform's own workspace (see the header)? */
export async function isPlatformWorkspace(config: ServerConfig, workspaceId: string): Promise<boolean> {
  const { workspaceId: own } = await getPlatformHosts(config);
  if (!own) return false;
  return sameId(own, workspaceId);
}

/**
 * Is `origin` one of the platform's own sites (PlatformHosts.origins) and
 * `workspaceId` the platform's own workspace? Then that origin may read the
 * workspace's help center (middleware/widgetCors.ts): app.<brand>/help calls
 * api.<brand>, and the platform widget's allow-list (empty: any site) says
 * nothing about it. No other origin and no other workspace gains anything.
 */
export async function isPlatformSiteOrigin(config: ServerConfig, workspaceId: string, origin: string): Promise<boolean> {
  const { origins } = await getPlatformHosts(config);
  const strict = toStrictOrigin(origin);
  return !!strict && origins.has(strict) && (await isPlatformWorkspace(config, workspaceId));
}

/** Does `accountId` hold the platform's own workspace? */
async function isPlatformAccount(config: ServerConfig, accountId: string): Promise<boolean> {
  const { workspaceId } = await getPlatformHosts(config);
  if (!workspaceId) return false;
  const { data, error } = await getServiceClient(config)
    .from('workspaces')
    .select('account_id')
    .eq('id', workspaceId)
    .maybeSingle();
  if (error) throw error;
  const holder = (data as { account_id?: string | null } | null)?.account_id;
  return !!holder && sameId(holder, accountId);
}

/**
 * Clears the owner's website when it names a platform host, right before a
 * workspace INSERT (into `accountId`, when it exists) that would have the
 * trigger verify it for that workspace. Covers values stored before the
 * profile writers refused them (a new website is checked in
 * services/ownerWebsite.ts), or written outside the app. Conditional on the
 * value read, so a concurrent edit wins. Kept only in the platform's own
 * account while a workspace of it already holds the website verified (its
 * owner's website names the platform; clearing it would unfix the platform
 * workspace's own row): the INSERT does not claim it again (migration 288).
 * A customer account is cleared even when its workspace holds such a row:
 * an old claim, which is never fixed (ownerWebsite.ts fixedDomainIds).
 */
export async function dropPlatformWebsite(config: ServerConfig, ownerId: string, accountId?: string | null): Promise<void> {
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('profiles')
    .select('website_domain')
    .eq('id', ownerId)
    .maybeSingle();
  if (error) throw error;
  const website = (data as { website_domain?: string | null } | null)?.website_domain;
  if (!website || !(await isPlatformHost(config, website))) return;
  if (accountId && (await isPlatformAccount(config, accountId)) && (await isWebsiteHeldBy(config, [accountId], website))) return;
  const { error: clearError } = await sb
    .from('profiles')
    .update({ website_domain: null, updated_at: new Date().toISOString() })
    .eq('id', ownerId)
    .eq('website_domain', website);
  if (clearError) throw clearError;
  console.warn(`[platformHosts] cleared a platform host from the website of ${ownerId} before creating a workspace`);
}

/** Super Admin → Domains or a workspace's domains changed: read the platform's hosts again on next use. */
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
