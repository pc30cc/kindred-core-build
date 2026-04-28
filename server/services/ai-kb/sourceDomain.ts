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
  const sb = getServiceClient(config);

  const { data: domains } = await sb
    .from('workspace_domains')
    .select('id, domain, verified, is_primary')
    .eq('workspace_id', workspaceId);

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
      return {
        domain: picked.domain,
        kind: 'workspace_domain',
        workspace_domain_id: picked.id,
        verified: true,
        is_primary: picked.is_primary,
        can_scan: true,
        reason_if_blocked: null,
        available_domains: available,
      };
    }
    // Fall through to default resolution; never honour an arbitrary id.
  }

  // 2. Primary verified.
  const primary = verified.find((d) => d.is_primary);
  if (primary) {
    return {
      domain: primary.domain,
      kind: 'workspace_domain',
      workspace_domain_id: primary.id,
      verified: true,
      is_primary: true,
      can_scan: true,
      reason_if_blocked: null,
      available_domains: available,
    };
  }

  // 3. Any verified.
  if (verified.length) {
    const v = verified[0];
    return {
      domain: v.domain,
      kind: 'workspace_domain',
      workspace_domain_id: v.id,
      verified: true,
      is_primary: false,
      can_scan: true,
      reason_if_blocked: null,
      available_domains: available,
    };
  }

  // 4. Owner profile.website_domain (pending/unverified fallback).
  // Find the owner of this workspace.
  const { data: owner } = await sb
    .from('workspace_members')
    .select('user_id')
    .eq('workspace_id', workspaceId)
    .eq('role', 'owner')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (owner?.user_id) {
    const { data: profile } = await sb
      .from('profiles')
      .select('website_domain')
      .eq('id', owner.user_id)
      .maybeSingle();

    const raw = (profile?.website_domain || '').trim();
    if (raw) {
      const normalized = normalizeDomain(raw);
      if (normalized) {
        return {
          domain: normalized,
          kind: 'profile_domain',
          workspace_domain_id: null,
          verified: false,
          is_primary: false,
          can_scan: true, // pending/unverified — backend will mark snapshot accordingly
          reason_if_blocked: null,
          available_domains: available,
        };
      }
    }
  }

  return {
    domain: null,
    kind: null,
    workspace_domain_id: null,
    verified: false,
    is_primary: false,
    can_scan: false,
    reason_if_blocked: 'missing_domain',
    available_domains: [],
  };
}
