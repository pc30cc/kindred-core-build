/**
 * AI KB Builder — source domain resolver.
 *
 * The user must NOT enter arbitrary URLs. The scan source is always derived
 * server-side from the workspace's own domains:
 *
 *   1. Primary verified workspace_domains row.
 *   2. Any verified workspace_domains row.
 *   3. Owner profile.website_domain as a "pending/unverified" fallback.
 *   4. Otherwise: missing_domain.
 *
 * If the operator has multiple verified workspace domains they may pick by
 * `domain_id`, but only from that workspace's verified set. Free-form input
 * is rejected.
 */

import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { normalizeDomain } from '../../utils/domain.js';
import { readOk, readFailed, type ReadResult } from './readResult.js';

export type SourceKind = 'workspace_domain' | 'profile_domain';

export interface ResolvedSource {
  domain: string;                       // normalized canonical host
  kind: SourceKind;
  workspace_domain_id: string | null;
  verified: boolean;
  is_primary: boolean;
  can_scan: boolean;
  reason_if_blocked: string | null;
  available_domains: Array<{
    id: string;
    domain: string;
    verified: boolean;
    is_primary: boolean;
  }>;
}

export interface MissingSource {
  domain: null;
  kind: null;
  workspace_domain_id: null;
  verified: false;
  is_primary: false;
  can_scan: false;
  reason_if_blocked: 'missing_domain';
  available_domains: [];
}

/**
 * Resolve the scan source for a workspace. Optional `requestedDomainId` lets
 * the operator pick among that workspace's verified domains, but never
 * accepts an arbitrary URL.
 */
export async function resolveSourceDomain(
  config: ServerConfig,
  workspaceId: string,
  requestedDomainId?: string | null,
): Promise<ResolvedSource | MissingSource> {
  const detailed = await resolveSourceDomainDetailed(config, workspaceId, requestedDomainId);
  if (detailed.ok) return detailed.value;
  // Legacy callers keep the old fail-open shape; fail-closed callers must use
  // `resolveSourceDomainDetailed` so an outage cannot read as "no domain".
  return MISSING_SOURCE;
}

const MISSING_SOURCE: MissingSource = {
  domain: null,
  kind: null,
  workspace_domain_id: null,
  verified: false,
  is_primary: false,
  can_scan: false,
  reason_if_blocked: 'missing_domain',
  available_domains: [],
};

/**
 * Phase 6-S5-R7.3 §3 — fail-closed source resolution.
 *
 * "This workspace has no domain" and "we could not read the domain table" are
 * different answers: the first tells the customer to add a domain, the second
 * is an outage they must retry. Query failures therefore surface as
 * `source_domain_status_unavailable` instead of an empty domain list.
 */
export async function resolveSourceDomainDetailed(
  config: ServerConfig,
  workspaceId: string,
  requestedDomainId?: string | null,
): Promise<ReadResult<ResolvedSource | MissingSource>> {
  const sb = getServiceClient(config);

  const { data: domains, error: domainsError } = await sb
    .from('workspace_domains')
    .select('id, domain, verified, is_primary')
    .eq('workspace_id', workspaceId);
  if (domainsError) {
    console.error('[AiKb] workspace_domains read failed:', domainsError.message);
    return readFailed('source_domain_status_unavailable');
  }

  const list = (domains || []).map((d: any) => ({
    id: d.id as string,
    domain: normalizeDomain(d.domain),
    verified: !!d.verified,
    is_primary: !!d.is_primary,
  }));

  const verified = list.filter((d) => d.verified);
  const available = list;

  // 1. Explicit pick — must be one of the workspace's own verified rows.
  if (requestedDomainId) {
    const picked = verified.find((d) => d.id === requestedDomainId);
    if (picked) {
      return readOk({
        domain: picked.domain,
        kind: 'workspace_domain',
        workspace_domain_id: picked.id,
        verified: true,
        is_primary: picked.is_primary,
        can_scan: true,
        reason_if_blocked: null,
        available_domains: available,
      });
    }
    // Fall through to default resolution; never honour an arbitrary id.
  }

  // 2. Primary verified.
  const primary = verified.find((d) => d.is_primary);
  if (primary) {
    return readOk({
      domain: primary.domain,
      kind: 'workspace_domain',
      workspace_domain_id: primary.id,
      verified: true,
      is_primary: true,
      can_scan: true,
      reason_if_blocked: null,
      available_domains: available,
    });
  }

  // 3. Any verified.
  if (verified.length) {
    const v = verified[0];
    return readOk({
      domain: v.domain,
      kind: 'workspace_domain',
      workspace_domain_id: v.id,
      verified: true,
      is_primary: false,
      can_scan: true,
      reason_if_blocked: null,
      available_domains: available,
    });
  }

  // 4. Owner profile.website_domain (pending/unverified fallback).
  // Find the owner of this workspace.
  const { data: owner, error: ownerError } = await sb
    .from('workspace_members')
    .select('user_id')
    .eq('workspace_id', workspaceId)
    .eq('role', 'owner')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (ownerError) {
    console.error('[AiKb] workspace owner read failed:', ownerError.message);
    return readFailed('source_domain_status_unavailable');
  }

  if (owner?.user_id) {
    const { data: profile, error: profileError } = await sb
      .from('profiles')
      .select('website_domain')
      .eq('id', owner.user_id)
      .maybeSingle();
    if (profileError) {
      console.error('[AiKb] owner profile read failed:', profileError.message);
      return readFailed('source_domain_status_unavailable');
    }

    const raw = (profile?.website_domain || '').trim();
    if (raw) {
      const normalized = normalizeDomain(raw);
      if (normalized) {
        return readOk({
          domain: normalized,
          kind: 'profile_domain',
          workspace_domain_id: null,
          verified: false,
          is_primary: false,
          can_scan: true, // pending/unverified — backend will mark snapshot accordingly
          reason_if_blocked: null,
          available_domains: available,
        });
      }
    }
  }

  return readOk({ ...MISSING_SOURCE, available_domains: [] });
}
