/**
 * Where the call widget runs (owner, 2026-11-28).
 *
 * The call widget runs ONLY on the workspace's registered website and on the
 * call center's own list (Call Center → Install → Allowed domains,
 * `call_center_settings.allowed_domains`). It no longer falls back to the chat
 * widget's rule, under which an empty chat list let any site run it.
 *
 * How many there may be is the plan's `max_call_widget_domains` (registry
 * default 1, -1 = unlimited): the registered website counts as one, so a
 * plan of 1 means the registered website alone, and the list may hold the
 * rest. The number is checked when the list is saved, and only against
 * growth: a list that is resent or shortened is accepted as it is, so an old
 * dashboard's save or a downgrade never cuts a site that works today.
 *
 * The registered website is the workspace's verified domains
 * (`workspace_domains.verified`, written only by the signup website trigger,
 * register_workspace_domain). A verified row naming a platform host counts
 * only for the platform's own workspace, as in the chat widget's resolver
 * (services/widget/public.ts). A workspace without one (a later workspace
 * of the same account, migration 288, or no website given) has no
 * registered website, and the list then holds every slot.
 *
 * Matching: the registered website and a plain list entry match their host
 * and its `www.` twin, never another subdomain; `*.example.com` matches
 * example.com and every subdomain (utils/domain.ts isOriginAllowed). A list
 * entry spelled with its port keeps matching that host and port, as before.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { onInvalidate } from '../../lib/cacheBus.js';
import { canonicalWorkspaceId } from '../../lib/workspaceId.js';
import { checkEntitlementFromDB } from '../../middleware/featureGating.js';
import { CAPABILITY_REGISTRY } from '../billing/capabilityRegistry.js';
import { getPlatformHosts, isPlatformHostIn } from '../platformHosts.js';
import { isOriginAllowed, normalizeDomain } from '../../utils/domain.js';
import { originAllowed, type WorkspaceCallCenterSettings } from './settings.js';
import {
  CALL_WIDGET_DOMAINS_LIMIT_KEY,
  cleanDomainList,
  domainSlotsUsed,
  isValidDomainEntry,
} from '../../../shared/callCenter/callWidgetDomains.js';

export {
  CALL_WIDGET_DOMAINS_LIMIT_KEY,
  cleanDomainList,
  domainSlotsUsed,
  isValidDomainEntry,
} from '../../../shared/callCenter/callWidgetDomains.js';


// ── The registered website, per workspace, kept a minute ────────────────────

const TTL_MS = 60_000;
const MAX_ENTRIES = 5_000;
type Entry = { at: number; value: Promise<string[]> };
const registeredCache = new Map<string, Entry>();

function keyOf(workspaceId: string): string {
  return canonicalWorkspaceId(workspaceId) ?? workspaceId.toLowerCase();
}

export function invalidateRegisteredWebsiteCache(workspaceId?: string | null): void {
  if (!workspaceId) { registeredCache.clear(); return; }
  registeredCache.delete(keyOf(workspaceId));
}

// A domain change (Settings → Domains, Super Admin), a plan or entitlement
// change and a workspace deletion publish `origin:<workspace>`; a call center
// settings save publishes `widget:<workspace>`. A resync (nothing known
// changed) is skipped: entries live a minute, which bounds a missed one.
for (const scope of ['origin', 'widget']) {
  onInvalidate(scope, (workspaceId, { resync }) => {
    if (!resync) invalidateRegisteredWebsiteCache(workspaceId);
  });
}

async function loadRegisteredWebsite(config: ServerConfig, workspaceId: string): Promise<string[]> {
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('workspace_domains')
    .select('domain, verified')
    .eq('workspace_id', workspaceId)
    .eq('verified', true);
  if (error) throw error;
  const domains = ((data || []) as Array<{ domain: string | null }>)
    .map((row) => normalizeDomain(String(row.domain || '')))
    .filter(Boolean);
  if (!domains.length) return [];
  const platform = await getPlatformHosts(config);
  const own = !platform.workspaceId || keyOf(platform.workspaceId) === keyOf(workspaceId);
  return [...new Set(own ? domains : domains.filter((d) => !isPlatformHostIn(platform, d)))];
}

/** The workspace's registered website (its verified domains), normalized; [] when it has none. */
export function registeredWebsiteDomains(config: ServerConfig, workspaceId: string): Promise<string[]> {
  const key = keyOf(workspaceId);
  const hit = registeredCache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const value = loadRegisteredWebsite(config, workspaceId);
  registeredCache.set(key, { at: Date.now(), value });
  // A failed read is not kept: the next request asks again.
  value.catch(() => { if (registeredCache.get(key)?.value === value) registeredCache.delete(key); });
  while (registeredCache.size > MAX_ENTRIES) {
    const oldest = registeredCache.keys().next().value;
    if (oldest === undefined) break;
    registeredCache.delete(oldest);
  }
  return value;
}

/**
 * May this page origin use the workspace's call widget? No Origin never may
 * (a server, curl, a same-origin page that sends none); a failed read of the
 * registered website denies, as the old fallback's failure did.
 */
export async function callWidgetOriginAllowed(
  config: ServerConfig,
  ws: WorkspaceCallCenterSettings,
  origin: string | null,
): Promise<boolean> {
  if (!origin) return false;
  // The list as matched before (exact host and port, `*.x` subdomains).
  if (originAllowed(ws, origin)) return true;
  let registered: string[];
  try {
    registered = await registeredWebsiteDomains(config, ws.workspace_id);
  } catch {
    return false;
  }
  return isOriginAllowed(origin, [...registered, ...cleanDomainList(ws.allowed_domains)], false);
}

// ── The plan's number ───────────────────────────────────────────────────────

function registryDefault(): number {
  const def = CAPABILITY_REGISTRY.find((c) => c.key === CALL_WIDGET_DOMAINS_LIMIT_KEY);
  return typeof def?.defaultValue === 'number' ? def.defaultValue : 1;
}

/**
 * The plan's `max_call_widget_domains` (-1 = unlimited), read as the chat
 * widget reads `max_widget_domains` (services/widget/entitlements.ts): a
 * self-host in unlimited billing answers -1, a key the plan never names the
 * registry default, a denial 0.
 */
export async function callWidgetDomainLimit(config: ServerConfig, workspaceId: string): Promise<number> {
  const res = await checkEntitlementFromDB(
    config.supabaseUrl,
    config.supabaseServiceRoleKey,
    workspaceId,
    CALL_WIDGET_DOMAINS_LIMIT_KEY,
    { numeric: true, selfHostBillingUnlimited: config.selfHostBillingUnlimited === true },
  );
  if (res.allowed && res.limitValid && typeof res.limit === 'number') return res.limit;
  if (res.reason === 'feature_not_in_plan' || res.allowed) return registryDefault();
  return 0;
}

/**
 * A save of the list: what to store, or why not. Every entry the save adds
 * must be a domain (`*.` allowed); an entry already stored is kept as it is.
 * Past the plan's number only a save that adds nothing is accepted.
 */
export function checkDomainListSave(input: {
  next: unknown;
  stored: unknown;
  registered: string[];
  max: number;
}): { kind: 'ok'; list: string[] } | { kind: 'invalid_domain'; entry: string } | { kind: 'plan_limit'; max: number } {
  const list = cleanDomainList(input.next);
  const stored = cleanDomainList(input.stored);
  const added = list.filter((entry) => !stored.includes(entry));
  const invalid = added.find((entry) => !isValidDomainEntry(entry));
  if (invalid !== undefined) return { kind: 'invalid_domain', entry: invalid };
  if (input.max >= 0 && added.length > 0 && domainSlotsUsed(input.registered, list) > input.max) {
    return { kind: 'plan_limit', max: input.max };
  }
  return { kind: 'ok', list };
}
