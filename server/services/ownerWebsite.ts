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
 * one of the platform's own hosts (services/platformHosts.ts) or already
 * verified by any workspace.
 *
 * Once a profile holds a website, no route writes another one: PATCH
 * /api/account/me and Super Admin's profile edit accept only the same
 * website again (forms send the whole row), and a profile without one yet
 * (an older account) may set one, once. Removal by the system is not a
 * change and stays: the privacy anonymizer and dropPlatformWebsite clear it.
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

/**
 * The host the trigger would verify for `raw`, or the parser's refusal code.
 * Every leading `www.` goes, as SQL strips one per normalize step.
 */
function parseWebsite(raw: unknown): { ok: true; domain: string } | { ok: false; code: string } {
  let result = parseWorkspaceDomainInput(raw);
  while (result.ok && result.domain.startsWith('www.')) result = parseWorkspaceDomainInput(result.domain);
  return result.ok === false ? { ok: false, code: result.code } : result;
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

/** A website someone is about to store: its canonical host, or why not. */
export async function checkNewWebsite(
  config: ServerConfig,
  raw: unknown,
): Promise<{ ok: true; domain: string } | WebsiteRefusal> {
  const parsed = parseWebsite(raw);
  if (parsed.ok === false) return { ok: false, status: 400, code: parsed.code };
  if (await isPlatformHost(config, parsed.domain)) return { ok: false, status: 409, code: 'PLATFORM_DOMAIN' };
  if (await isVerifiedDomain(config, parsed.domain)) return { ok: false, status: 409, code: 'DOMAIN_TAKEN' };
  return { ok: true, domain: parsed.domain };
}

/** The same website: the same text, or the same host once read. */
function sameWebsite(stored: string, sent: string): boolean {
  if (stored.trim() === sent) return true;
  const a = parseWebsite(stored);
  const b = parseWebsite(sent);
  return a.ok && b.ok && a.domain === b.domain;
}

/**
 * What a profile edit may do with `website_domain` (undefined: not sent).
 * `write` is set only for the first website of a profile that has none;
 * an unchanged one writes nothing, so the stored text stays as it is.
 */
export async function websiteEdit(
  config: ServerConfig,
  userId: string,
  next: string | null | undefined,
): Promise<{ ok: true; write?: { domain: string; stored: string | null } } | WebsiteRefusal> {
  if (next === undefined) return { ok: true };
  const { data, error } = await getServiceClient(config)
    .from('profiles')
    .select('website_domain')
    .eq('id', userId)
    .maybeSingle();
  if (error) throw error;
  const stored = (data as { website_domain?: string | null } | null)?.website_domain ?? null;
  const sent = (next ?? '').trim();
  if (stored?.trim()) {
    return sent && sameWebsite(stored, sent) ? { ok: true } : { ok: false, status: 403, code: 'WEBSITE_FIXED' };
  }
  if (!sent) return { ok: true };
  const checked = await checkNewWebsite(config, sent);
  if (checked.ok === false) return checked;
  return { ok: true, write: { domain: checked.domain, stored } };
}

/**
 * Stores a profile's first website, only while it still holds what
 * `websiteEdit` read (none), so two first writes cannot both land.
 */
export async function storeFirstWebsite(
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
