/**
 * The website of an account owner (`profiles.website_domain`).
 *
 * The owner's rule (2026-10-28): required at signup, registered once, fixed
 * for good, with no ownership proof. It becomes the verified primary domain
 * of the account's first workspace (trg_workspaces_auto_register_owner_domain,
 * migrations 239 and 288), and a verified domain belongs to one workspace on
 * the platform. So a NEW website is read exactly as Settings → Domains reads
 * a domain (utils/workspaceDomainInput.ts), stored in that canonical form,
 * so the trigger registers exactly what was checked, and refused when it is
 * one of the platform's own hosts (services/platformHosts.ts), already
 * verified by any workspace, or another profile's website (a signup whose
 * workspace is not created yet).
 *
 * Once registered (the owner's account has a workspace, whose creation
 * verified it), no route writes another one: PATCH /api/account/me, Super
 * Admin's profile edit and first-run provisioning accept only the same
 * website again (forms send the whole row), and its row in the workspace's
 * domains is never removed or edited, nor loses the primary flag
 * (fixedDomainIds). Until then (no workspace yet, or provisioning found it
 * taken meanwhile) it may be replaced, checked as at signup, never cleared.
 * A profile without one (an older account) may set one, once. Removal by
 * the system is not a change and stays: the privacy anonymizer and
 * dropPlatformWebsite clear it.
 */

import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';
import { parseWorkspaceDomainInput } from '../utils/workspaceDomainInput.js';
import { isPlatformHost } from './platformHosts.js';

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

/** Is `domain` (canonical) verified by any workspace already? */
async function isVerifiedDomain(config: ServerConfig, domain: string): Promise<boolean> {
  const { data, error } = await getServiceClient(config)
    .from('workspace_domains')
    .select('id')
    .eq('verified', true)
    .eq('normalized_domain', domain)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return !!data;
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
  if (await isPlatformHost(config, parsed.domain)) return { ok: false, status: 409, code: 'PLATFORM_DOMAIN' };
  if ((await isVerifiedDomain(config, parsed.domain)) || (await isOtherProfileWebsite(config, parsed.domain, userId))) {
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
 * Is a website `userId` stores registered, so fixed: an account they own has
 * a workspace, whose creation verified it (the trigger), or, for an older
 * account, it was set once afterwards. Until then (no workspace yet, or
 * provisioning found it taken meanwhile, or the account's workspaces were
 * deleted) it may be replaced.
 */
export async function isWebsiteRegistered(config: ServerConfig, userId: string): Promise<boolean> {
  const sb = getServiceClient(config);
  const { data: accounts, error } = await sb.from('accounts').select('id').eq('owner_id', userId);
  if (error) throw error;
  const accountIds = ((accounts ?? []) as Array<{ id: string }>).map((a) => a.id);
  if (!accountIds.length) return false;
  const { data: workspaces, error: wsError } = await sb.from('workspaces').select('id').in('account_id', accountIds).limit(1);
  if (wsError) throw wsError;
  return !!workspaces?.length;
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
    if (await isWebsiteRegistered(config, userId)) return { ok: false, status: 403, code: 'WEBSITE_FIXED' };
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
 * and keeps the primary flag; every other row is managed as before.
 */
export async function fixedDomainIds(config: ServerConfig, rows: DomainRowKey[]): Promise<Set<string>> {
  const verified = rows.filter((r) => r.verified && r.normalized_domain);
  if (!verified.length) return new Set();
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
