/**
 * STORAGE POOL SCOPES — replicas as physical deletion scopes.
 *
 * Canonical ownership (`workspace/<id>/...`, `users/<id>/...`) says nothing
 * about how many physical accounts hold those bytes. Since the storage pool
 * mirrors every primary write to the enabled replicas, an owner's objects
 * can exist in several buckets at once — and workspace/user deletion must
 * erase and VERIFY every one of them, or a fully DB-purged owner leaves
 * private data behind forever.
 *
 * This is why `replication.mirrorDeletes` is irrelevant here. That flag is
 * about ORDINARY object deletion (an operator deleting one attachment
 * should be able to keep a backup copy on a mirror). Owner lifecycle
 * deletion is a different contract: it must leave nothing anywhere, so it
 * always walks every configured pool vendor regardless of that flag.
 *
 * And why `enabled` is irrelevant here too. Switching a vendor off stops it
 * receiving NEW mirrored writes; it does not remove the objects it already
 * holds. A retired mirror that is skipped by deletion keeps that owner's
 * private data forever, which is the exact failure this module exists to
 * prevent — so every CONFIGURED vendor is a scope, enabled or not. A vendor
 * only stops being walked when its entry is removed from the pool, and
 * removal is itself gated on the vendor being verified free of managed data
 * (see the admin route's DELETE handler).
 *
 * Each vendor becomes its own named scope (`replica:<vendor>`); the shared
 * cleanup walker (./scopeCleanupEngine.ts) then gives it the same
 * treatment every other scope gets — listing with a cursor, per-key delete
 * retries, config-drift detection, dedup against an identical physical
 * location by fingerprint, and a from-scratch verification pass before the
 * job may advance to the DB purge.
 */
import type { ServerConfig } from '../../config.js';
import { storageConfigFromRecord, type StorageConfig } from './index.js';
import { readStoragePool } from './pool.js';

export type PoolScopeResolution =
  | { configured: true; config: StorageConfig }
  | { configured: false; reason: string };

export interface PoolStorageScope {
  name: string;
  resolve(): Promise<PoolScopeResolution>;
}

/** Scope name for one pool vendor. Stable across ticks — it is persisted in the job's storage_scopes state. */
export function poolScopeName(providerName: string): string {
  return `replica:${providerName}`;
}

/**
 * Every CONFIGURED vendor in the pool, as deletion scopes — including the
 * ones that are switched off.
 *
 * The primary is included too: it normally resolves to the same physical
 * location as the ordinary 'attachment'/'default' scope and is then
 * deduplicated by fingerprint at zero cost — but if the two ever disagree
 * (a resolver override, a stale pointer) including it is what keeps the
 * invariant "every physical provider that can hold this prefix" true.
 *
 * Throws if the pool cannot be read. Callers must treat that as "this tick
 * failed", never as "there are no replicas" — see readStoragePool. The same
 * reasoning applies to a retired vendor that is unreachable: the deletion
 * job stays blocked and retryable rather than reporting success while the
 * data survives somewhere else.
 */
export async function storagePoolScopes(config: ServerConfig): Promise<PoolStorageScope[]> {
  const pool = await readStoragePool(config);

  return Object.entries(pool.providers)
    .map(([name, entry]) => ({
      name: poolScopeName(name),
      async resolve(): Promise<PoolScopeResolution> {
        const cfg = storageConfigFromRecord(name, entry.config);
        return { configured: true, config: cfg };
      },
    }));
}
