/**
 * The website of an account owner (`profiles.website_domain`).
 *
 * The owner's rule (2026-10-28): required at signup, registered once, fixed
 * for good, with no ownership proof. It becomes the verified primary domain
 * of the account's first workspace (trg_workspaces_auto_register_owner_domain,
 * migrations 239 and 288), and a verified domain belongs to one workspace on
 * the platform. So a NEW website is read exactly as Settings → Domains reads
 * a domain (utils/workspaceDomainInput.ts), stored in that canonical form,
 * so the trigger registers exactly what was checked (never a public suffix
 * such as com.tr), and refused when it is one of the platform's own hosts
 * (services/platformHosts.ts), or the origin resolver hands it to a
 * workspace outside the owner's own accounts (verified there, or under a
 * domain verified there with subdomains allowed, within its registrable
 * domain), or another profile's website (a signup whose workspace is not
 * created yet).
 *
 * Once registered (an account of the owner has a workspace: the first
 * workspace's creation verifies it), no route writes another one: PATCH
 * /api/account/me, Super Admin's profile edit and first-run provisioning
 * accept only the same website again (forms send the whole row), and its row
 * in the workspace's domains is never removed or edited, nor loses the
 * primary flag (fixedDomainIds; a row naming a platform host only in the
 * platform's own workspace). Until then (the account has no workspace, or
 * only a workspace of another account holds it verified: provisioning found
 * it taken meanwhile, or it was stored before) it may be replaced, checked
 * as at signup, never cleared. A profile without one (an older account) may
 * set one, once, the domain its own workspace verified included. Removal by
 * the system is not a change and stays: the privacy anonymizer and
 * dropPlatformWebsite clear it.
 */

import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';
import { parseWorkspaceDomainInput, registrableDomain } from '../utils/workspaceDomainInput.js';
import { getPlatformHosts, isPlatformHost, isPlatformHostIn } from './platformHosts.js';
import { hostSuffixCandidates } from './widget/public.js';

/** A refused website: the HTTP status and the code the panel maps (src/lib/settingsErrors.ts). */
export interface WebsiteRefusal {
  ok: false;
  status: number;
  code: string;
}

/** The fields of a workspace_domains row the fixed-row check reads. */
export interface DomainRowKey {
  id: string;
  workspace_id: string;
  verified: boolean | null;
  normalized_domain: string | null;
}

/**
 * The host the trigger would verify for `raw`, or the parser's refusal code.
 * Every leading `www.` goes, as SQL strips one per normalize step.
 */
function parseWebsite(raw: unknown): { ok: true; domain: string } | { ok: false; code: string } {
  let result = parseWorkspaceDomainInput(raw);
  while (result.ok && result.domain.startsWith('www.')) result = parseWorkspaceDomainInput(result.domain);
  return result.ok === false ? { ok: false, code: result.code } : result;
}

/**
 * The `normalized_domain` a stored website has once the trigger registered
 * it: its canonical host, and the text read as SQL reads it (an older value
 * stored unchecked, an IDN in its Unicode spelling).
 */
function websiteKeys(stored: string | null | undefined): string[] {
  const text = (stored ?? '').trim();
  if (!text) return [];
  const parsed = parseWebsite(text);
  let sqlKey = text.toLowerCase().replace(/^https?:\/\//, '').replace(/[:/?#].*$/, '');
  while (sqlKey.startsWith('www.')) sqlKey = sqlKey.slice(4);
  return [...new Set([parsed.ok ? parsed.domain : '', sqlKey].filter(Boolean))];
}

/** The accounts `userId` owns. */
async function ownedAccountIds(config: ServerConfig, userId: string): Promise<string[]> {
  const { data, error } = await getServiceClient(config).from('accounts').select('id').eq('owner_id', userId);
  if (error) throw error;
  return ((data ?? []) as Array<{ id: string }>).map((a) => a.id);
}

/** The workspaces of `accountIds`. */
async function workspaceIdsOf(config: ServerConfig, accountIds: string[]): Promise<string[]> {
  if (!accountIds.length) return [];
  const { data, error } = await getServiceClient(config).from('workspaces').select('id').in('account_id', accountIds);
  if (error) throw error;
  return ((data ?? []) as Array<{ id: string }>).map((w) => w.id);
}

/**
 * Is `domain` (canonical) taken by a workspace outside the accounts `userId`
 * owns: does the origin resolver (services/widget/public.ts) hand it to such
 * a workspace today, before this website's exact row would take it over? As
 * the resolver decides, over every verified row, the owner's own included
 * (their own verified domain is theirs to record): the exact row first, else
 * the longest parent whose widget allows subdomains (ties included). Only a
 * parent at or under the website's registrable domain counts: a public
 * suffix (com.tr, vercel.app) is nobody's site, so a row holding one (stored
 * before the domain checks refused it) keeps no one out.
 */
async function isTakenDomain(config: ServerConfig, domain: string, userId?: string): Promise<boolean> {
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('workspace_domains')
    .select('workspace_id, normalized_domain')
    .eq('verified', true)
    .in('normalized_domain', hostSuffixCandidates(domain));
  if (error) throw error;
  const registrable = registrableDomain(domain) ?? domain;
  const rows = ((data ?? []) as Array<{ workspace_id: string; normalized_domain: string | null }>)
    .map((r) => ({ workspace_id: r.workspace_id, domain: String(r.normalized_domain ?? '').toLowerCase() }))
    .filter((r) => r.domain === registrable || r.domain.endsWith(`.${registrable}`));
  if (!rows.length) return false;
  const own = new Set(userId ? await workspaceIdsOf(config, await ownedAccountIds(config, userId)) : []);
  const foreign = (r: { workspace_id: string }) => !own.has(r.workspace_id);
  const exact = rows.filter((r) => r.domain === domain);
  if (exact.length) return exact.some(foreign);
  // The rest are parent domains of it.
  const { data: widgets, error: widgetError } = await sb
    .from('widget_settings')
    .select('workspace_id, allow_subdomains')
    .in('workspace_id', [...new Set(rows.map((r) => r.workspace_id))]);
  if (widgetError) throw widgetError;
  const subdomains = new Set(((widgets ?? []) as Array<{ workspace_id: string; allow_subdomains: boolean | null }>)
    .filter((w) => !!w.allow_subdomains)
    .map((w) => w.workspace_id));
  const eligible = rows.filter((r) => subdomains.has(r.workspace_id));
  if (!eligible.length) return false;
  const longest = Math.max(...eligible.map((r) => r.domain.length));
  return eligible.some((r) => r.domain.length === longest && foreign(r));
}

/** Is `domain` (canonical) the website another profile stores (since signup stores it canonical)? */
async function isOtherProfileWebsite(config: ServerConfig, domain: string, userId?: string): Promise<boolean> {
  let query = getServiceClient(config).from('profiles').select('id').eq('website_domain', domain);
  if (userId) query = query.neq('id', userId);
  const { data, error } = await query.limit(1).maybeSingle();
  if (error) throw error;
  return !!data;
}

/** A website someone is about to store (for `userId`, when they have a profile): its canonical host, or why not. */
export async function checkNewWebsite(
  config: ServerConfig,
  raw: unknown,
  userId?: string,
): Promise<{ ok: true; domain: string } | WebsiteRefusal> {
  const parsed = parseWebsite(raw);
  if (parsed.ok === false) return { ok: false, status: 400, code: parsed.code };
  // The raw text too, as defence in depth: what is stored is the parsed
  // form, in which a dotted capital I (U+0130) is punycode, never the plain i
  // Postgres' lower() would make of the raw text.
  if ((await isPlatformHost(config, raw)) || (await isPlatformHost(config, parsed.domain))) {
    return { ok: false, status: 409, code: 'PLATFORM_DOMAIN' };
  }
  if ((await isTakenDomain(config, parsed.domain, userId)) || (await isOtherProfileWebsite(config, parsed.domain, userId))) {
    return { ok: false, status: 409, code: 'DOMAIN_TAKEN' };
  }
  return { ok: true, domain: parsed.domain };
}

/** The same website: the same text, or the same host once read. */
function sameWebsite(stored: string, sent: string): boolean {
  if (stored.trim() === sent) return true;
  const a = parseWebsite(stored);
  const b = parseWebsite(sent);
  return a.ok && b.ok && a.domain === b.domain;
}

/** The website a profile stores, as stored (null when it has none). */
export async function storedWebsite(config: ServerConfig, userId: string): Promise<string | null> {
  const { data, error } = await getServiceClient(config)
    .from('profiles')
    .select('website_domain')
    .eq('id', userId)
    .maybeSingle();
  if (error) throw error;
  return (data as { website_domain?: string | null } | null)?.website_domain ?? null;
}

/**
 * Does a workspace of `accountIds` hold the website `stored` (as a profile
 * stores it) verified: the row the trigger registered for it, read as
 * fixedDomainIds reads it?
 */
export async function isWebsiteHeldBy(config: ServerConfig, accountIds: string[], stored: string | null | undefined): Promise<boolean> {
  const keys = websiteKeys(stored);
  if (!keys.length) return false;
  const workspaceIds = await workspaceIdsOf(config, accountIds);
  if (!workspaceIds.length) return false;
  const { data, error } = await getServiceClient(config)
    .from('workspace_domains')
    .select('id')
    .eq('verified', true)
    .in('workspace_id', workspaceIds)
    .in('normalized_domain', keys)
    .limit(1);
  if (error) throw error;
  return !!data?.length;
}

/**
 * Is the website `userId` stores (`stored`) registered, so fixed: an account
 * they own has a workspace (the first one's creation verified it; for an
 * older account, the next workspace's creation will), so it was set once and
 * stays, even when the workspace that held it is deleted and another
 * remains. Not while no account of theirs has a workspace (before the first,
 * or once none is left), nor while a workspace outside their accounts holds
 * it verified and none of theirs does (stored before, or taken meanwhile):
 * no workspace can register it for them, so it may be replaced.
 */
export async function isWebsiteRegistered(config: ServerConfig, userId: string, stored: string | null | undefined): Promise<boolean> {
  const keys = websiteKeys(stored);
  if (!keys.length) return false;
  const own = new Set(await workspaceIdsOf(config, await ownedAccountIds(config, userId)));
  if (!own.size) return false;
  const { data, error } = await getServiceClient(config)
    .from('workspace_domains')
    .select('workspace_id')
    .eq('verified', true)
    .in('normalized_domain', keys);
  if (error) throw error;
  const holders = ((data ?? []) as Array<{ workspace_id: string }>).map((r) => r.workspace_id);
  return !holders.length || holders.some((id) => own.has(id));
}

/**
 * What a profile edit may do with `website_domain` (undefined: not sent).
 * `write` is set for a website to store; an unchanged one writes nothing, so
 * the stored text stays as it is.
 */
export async function websiteEdit(
  config: ServerConfig,
  userId: string,
  next: string | null | undefined,
): Promise<{ ok: true; write?: { domain: string; stored: string | null } } | WebsiteRefusal> {
  if (next === undefined) return { ok: true };
  const stored = await storedWebsite(config, userId);
  const sent = (next ?? '').trim();
  if (stored?.trim()) {
    if (sent && sameWebsite(stored, sent)) return { ok: true };
    if (await isWebsiteRegistered(config, userId, stored)) return { ok: false, status: 403, code: 'WEBSITE_FIXED' };
  } else if (!sent) {
    return { ok: true };
  }
  const checked = await checkNewWebsite(config, sent, userId);
  if (checked.ok === false) return checked;
  return { ok: true, write: { domain: checked.domain, stored } };
}

/**
 * Stores a profile's website, only while it still holds what `websiteEdit`
 * read, so two writes cannot both land.
 */
export async function storeWebsite(
  config: ServerConfig,
  userId: string,
  write: { domain: string; stored: string | null },
): Promise<void> {
  const query = getServiceClient(config)
    .from('profiles')
    .update({ website_domain: write.domain, updated_at: new Date().toISOString() })
    .eq('id', userId);
  const { error } = await (write.stored === null ? query.is('website_domain', null) : query.eq('website_domain', write.stored));
  if (error) throw error;
}

/**
 * The rows of `rows` that hold their account owner's registered website:
 * verified, and that owner's website. Such a row is never removed or edited
 * and keeps the primary flag; every other row is managed as before. A row
 * naming a platform host (services/platformHosts.ts) is fixed only in the
 * platform's own workspace: a customer's (an old website the trigger
 * verified before the guards) stays removable, as the resolver ignores it.
 */
export async function fixedDomainIds(config: ServerConfig, rows: DomainRowKey[]): Promise<Set<string>> {
  let verified = rows.filter((r) => r.verified && r.normalized_domain);
  if (!verified.length) return new Set();
  const platform = await getPlatformHosts(config);
  if (platform.workspaceId) {
    verified = verified.filter((r) => r.workspace_id === platform.workspaceId || !isPlatformHostIn(platform, r.normalized_domain));
    if (!verified.length) return new Set();
  }
  const sb = getServiceClient(config);
  const { data: workspaces, error } = await sb
    .from('workspaces')
    .select('id, account_id')
    .in('id', [...new Set(verified.map((r) => r.workspace_id))]);
  if (error) throw error;
  const accountOf = new Map(((workspaces ?? []) as Array<{ id: string; account_id: string | null }>).map((w) => [w.id, w.account_id]));
  const accountIds = [...new Set([...accountOf.values()].filter((id): id is string => !!id))];
  if (!accountIds.length) return new Set();
  const { data: accounts, error: accError } = await sb.from('accounts').select('id, owner_id').in('id', accountIds);
  if (accError) throw accError;
  const ownerOf = new Map(((accounts ?? []) as Array<{ id: string; owner_id: string | null }>).map((a) => [a.id, a.owner_id]));
  const ownerIds = [...new Set([...ownerOf.values()].filter((id): id is string => !!id))];
  if (!ownerIds.length) return new Set();
  const { data: profiles, error: profileError } = await sb.from('profiles').select('id, website_domain').in('id', ownerIds);
  if (profileError) throw profileError;
  const keysOf = new Map(((profiles ?? []) as Array<{ id: string; website_domain: string | null }>).map((p) => [p.id, websiteKeys(p.website_domain)]));
  return new Set(verified
    .filter((r) => {
      const owner = ownerOf.get(accountOf.get(r.workspace_id) ?? '');
      return !!owner && (keysOf.get(owner) ?? []).includes(r.normalized_domain as string);
    })
    .map((r) => r.id));
}
