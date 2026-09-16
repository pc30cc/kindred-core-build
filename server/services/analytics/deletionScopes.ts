/**
 * ANALYTICS DELETION SCOPES — every physical place a workspace's analytics
 * objects can be, for owner-lifecycle purge.
 *
 * Workspace deletion already walks every physical location that can hold
 * `workspace/<id>/...` (server/services/storage/workspaceScopes.ts). Analytics
 * objects are NOT under that root and NOT in that topology:
 *
 *   general:   workspace/<id>/...                  → general primary + mirrors
 *   analytics: analytics/web/workspace=<id>/...    → analytics primary + replicas
 *
 * So a workspace purge that walked only the general scopes would leave a
 * deleted workspace's entire analytics history behind, on vendors the
 * general topology may not even include. This module supplies the second
 * half: the same walker, the same drivers, a different namespace and a
 * different topology.
 *
 * ── Which vendors count ──────────────────────────────────────────
 *
 * Every CONFIGURED vendor, not merely the ones currently named as the
 * analytics primary or replicas — the same reasoning
 * server/services/storage/poolScopes.ts already applies to general storage:
 *
 *   - a replica REMOVED from the list keeps everything it was sent;
 *   - a replica switched off or marked dirty still holds what it received;
 *   - a demoted primary holds every object written while it was primary;
 *   - replication being off now says nothing about what it copied before.
 *
 * A vendor only stops being walked when its credentials are removed from
 * Providers → Storage entirely, and that removal is itself gated on the
 * vendor being verifiably free of managed data. "Cannot list it" is
 * reported as an error, never as "nothing there".
 *
 * ── Which prefixes count ─────────────────────────────────────────
 *
 * Every prefix the pool has ever written under (AnalyticsStoragePool
 * .knownPrefixes), not just the current one — changing the prefix moves
 * where NEW objects go, it does not move the old ones.
 *
 * ── Cross-workspace safety ───────────────────────────────────────
 *
 * The walked prefix always ends with `workspace=<id>/`, built here from a
 * validated UUID. There is no code path through which one workspace's purge
 * can enumerate — let alone delete — another's objects, and the prefix can
 * never widen to the whole namespace: a malformed id throws instead of
 * falling back to a broader prefix.
 */

import type { ServerConfig } from '../../config.js';
import { storageConfigFromRecord } from '../storage/index.js';
import type { CleanupScope } from '../storage/scopeCleanupEngine.js';
import { readStoragePool } from '../storage/pool.js';
import { isAnalyticsReplicaEligible, readAnalyticsPool } from './pool.js';
import { analyticsWorkspacePrefix } from './schema.js';

/**
 * Scope-name namespace.
 *
 * Carries the POOL PREFIX as well as the vendor, because the walker keys
 * its persisted progress by scope name alone: two passes over the same
 * vendor under different prefixes are different work, and sharing a name
 * would make the second pass inherit the first's "done, verified" and skip
 * a namespace it never listed.
 */
export function analyticsScopeName(poolPrefix: string, providerName: string): string {
  return `analytics[${poolPrefix}]:${providerName}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One namespace to purge: the pool prefix it came from, and the workspace-scoped prefix to walk. */
export interface AnalyticsPurgeNamespace {
  poolPrefix: string;
  /** Always ends in `workspace=<id>/` — never widens to the whole namespace. */
  workspacePrefix: string;
}

/**
 * Every namespace to purge for one workspace, oldest prefix first.
 *
 * Throws on a malformed workspace id rather than returning a broader
 * prefix: the failure mode of a permissive fallback here is enumerating —
 * and deleting — another tenant's analytics data.
 */
export async function analyticsWorkspacePrefixes(
  config: ServerConfig,
  workspaceId: string,
): Promise<AnalyticsPurgeNamespace[]> {
  if (!UUID_RE.test(workspaceId)) {
    throw new Error(`analytics_deletion_invalid_workspace_id: ${workspaceId}`);
  }
  const pool = await readAnalyticsPool(config);
  const prefixes = pool.knownPrefixes.length > 0 ? pool.knownPrefixes : [pool.prefix];
  const seen = new Set<string>();
  const out: AnalyticsPurgeNamespace[] = [];
  for (const poolPrefix of prefixes) {
    if (seen.has(poolPrefix)) continue;
    seen.add(poolPrefix);
    out.push({ poolPrefix, workspacePrefix: analyticsWorkspacePrefix(poolPrefix, workspaceId) });
  }
  return out;
}

/**
 * Every vendor that could hold analytics objects, as cleanup scopes.
 *
 * Async because the vendor list lives in the database. A failed read THROWS
 * rather than returning a short list — silently dropping a scope would let
 * deletion advance to the DB purge while copies survive, which is exactly
 * the failure this module exists to prevent.
 */
export async function analyticsStorageScopes(
  config: ServerConfig,
  poolPrefix: string,
): Promise<CleanupScope[]> {
  const [analyticsPool, generalPool] = await Promise.all([
    readAnalyticsPool(config),
    readStoragePool(config),
  ]);

  // Union, in a stable order: the vendors analytics names today, then every
  // other vendor that holds credentials. The engine deduplicates by
  // physical fingerprint, so listing a vendor twice costs nothing.
  const named = [
    ...(analyticsPool.primary ? [analyticsPool.primary] : []),
    ...analyticsPool.replicas,
    ...Object.keys(analyticsPool.replicaState),
  ];
  const vendors = [...new Set([...named, ...Object.keys(generalPool.providers)])]
    // Only vendors analytics could ever have WRITTEN to. This is not an
    // optimization: `gcs` and `azure_blob` hold credentials but have no
    // listing driver (server/services/storage/index.ts's listHandlers), so
    // including them would make every listing fail, exhaust the job's
    // retries, and leave the workspace permanently undeletable. They are in
    // neither analytics eligibility list, so they can never have received
    // an analytics object in the first place.
    .filter((name) => isAnalyticsReplicaEligible(name));

  return vendors.map((name) => ({
    name: analyticsScopeName(poolPrefix, name),
    async resolve() {
      const entry = generalPool.providers[name];
      if (!entry || Object.keys(entry.config).length === 0) {
        // No credentials stored: this platform cannot reach the vendor at
        // all, so it holds nothing this deployment ever wrote.
        return { configured: false as const, reason: `no stored credentials for ${name}` };
      }
      return { configured: true as const, config: storageConfigFromRecord(name, entry.config) };
    },
  }));
}
