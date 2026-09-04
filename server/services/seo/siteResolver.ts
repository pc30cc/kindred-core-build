/**
 * SEO — workspace-site resolution.
 *
 * The ONLY authorization-relevant lookup in the whole SEO feature: given a
 * `workspaceId` (already proven to be one the caller belongs to, by
 * `authorizeWorkspaceAccess`) and a `siteId`, resolve the row in
 * `workspace_domains` — scoped by BOTH `id` AND `workspace_id` in the same
 * query, exactly like `loadDomainForWorkspace` in server/routes/workspaces.ts
 * — and build the canonical URL from the DB, never from client input.
 *
 * No domain-ownership verification is performed here (explicit V1 scope
 * decision): a site simply existing in the workspace is sufficient
 * authorization to crawl it. `verified`/`is_primary` are informational only.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { normalizeHost } from '../ai-agent/crawler/urlRules.js';

export type SiteResolutionErrorCode = 'site_not_found' | 'invalid_site_domain';

export class SiteResolutionError extends Error {
  code: SiteResolutionErrorCode;
  constructor(code: SiteResolutionErrorCode, message?: string) {
    super(message || code);
    this.code = code;
  }
}

export interface ResolvedSite {
  id: string;
  workspaceId: string;
  /** Raw value as stored in workspace_domains.domain — never used to build the crawl URL directly. */
  domain: string;
  /** Lowercased, www-stripped host — the crawl's authorization boundary (see isSameDomain). */
  canonicalHost: string;
  /** The ONLY URL the crawler is ever given. Always https, always server-derived. */
  canonicalUrl: string;
  verified: boolean;
  isPrimary: boolean;
}

/** Parses a free-text `workspace_domains.domain` value (may or may not carry a scheme/path) into a bare hostname. */
function extractHostname(input: string): string | null {
  const trimmed = (input || '').trim();
  if (!trimmed) return null;
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const hostname = new URL(withScheme).hostname.toLowerCase();
    return hostname || null;
  } catch {
    return null;
  }
}

/**
 * Resolves and validates that `siteId` belongs to `workspaceId`, then derives
 * the canonical crawl URL. Throws `SiteResolutionError('site_not_found')` for
 * both "doesn't exist" and "belongs to a different workspace" — the caller
 * must never be able to distinguish the two.
 */
export async function resolveWorkspaceSite(
  config: ServerConfig,
  workspaceId: string,
  siteId: string,
): Promise<ResolvedSite> {
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('workspace_domains')
    .select('id, workspace_id, domain, verified, is_primary')
    .eq('id', siteId)
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  if (error) throw new Error(`site_lookup_failed: ${error.message}`);
  if (!data) throw new SiteResolutionError('site_not_found');

  const row = data as { id: string; workspace_id: string; domain: string; verified: boolean; is_primary: boolean };
  const hostname = extractHostname(row.domain);
  if (!hostname) throw new SiteResolutionError('invalid_site_domain');
  const canonicalHost = normalizeHost(hostname);

  return {
    id: row.id,
    workspaceId: row.workspace_id,
    domain: row.domain,
    canonicalHost,
    canonicalUrl: `https://${canonicalHost}`,
    verified: !!row.verified,
    isPrimary: !!row.is_primary,
  };
}

export interface WorkspaceSiteSummary {
  id: string;
  domain: string;
  verified: boolean;
  is_primary: boolean;
  created_at: string;
}

export async function listWorkspaceSites(config: ServerConfig, workspaceId: string): Promise<WorkspaceSiteSummary[]> {
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('workspace_domains')
    .select('id, domain, verified, is_primary, created_at')
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: true });
  if (error) throw new Error(`list_sites_failed: ${error.message}`);
  return (data || []) as WorkspaceSiteSummary[];
}
