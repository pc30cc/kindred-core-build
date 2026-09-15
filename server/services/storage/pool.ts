/**
 * STORAGE PROVIDER POOL
 *
 * The platform can hold credentials for SEVERAL storage vendors at once.
 * Exactly one of them is the PRIMARY — every read and every write goes
 * there. The other enabled vendors are REPLICAS: writes are mirrored to
 * them so the same objects exist in more than one place, and an operator
 * can promote one of them to primary without re-entering credentials.
 *
 * Where it lives: `app_runtime_config` — the same generic key/value table
 * `default_storage_provider` already uses, so no new table is needed.
 *
 * Compatibility: `default_storage_provider` remains the single source of
 * truth for every existing reader (resolveStorageConfig and friends). The
 * pool and that pointer MUST agree — a disagreement means the screen shows
 * one primary while bytes land on another — so they are written together
 * by ONE transactional RPC (database/migrations/189…): either both land or
 * neither does. There is deliberately no non-atomic fallback path here.
 * When the pool has never been written, the legacy value is PROJECTED into
 * a one-entry pool so the first read already reflects reality.
 *
 * Reads fail closed. A PostgREST error resolves as `{data, error}` rather
 * than throwing, and treating that as "no pool configured" would let an
 * admin mutation overwrite a multi-provider pool with a one-entry one, and
 * would let deletion conclude there are no replicas to clean. Every read
 * goes through `mustDb`.
 *
 * Writes carry a REVISION. A whole-pool write is a compare-and-set against
 * the revision it was read at, so an operation that spends seconds doing
 * provider I/O (a sync batch) can never write its stale snapshot back over
 * credentials, an enabled flag or a primary that changed meanwhile. Replica
 * progress and readiness have their own targeted writers that touch one
 * vendor's fields and nothing else.
 */

import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { mustDb } from '../../utils/mustDb.js';

export const STORAGE_POOL_KEY = 'storage_provider_pool';
export const STORAGE_DEFAULT_KEY = 'default_storage_provider';

/**
 * Position and running totals of a back-fill walk, kept on the vendor so
 * the next batch resumes from where the server left it — never from a
 * number a client handed back.
 */
export interface StoragePoolSyncState {
  /** Prefix being walked ('' = the vendor's whole namespace). */
  prefix: string;
  /** The primary the objects are being copied FROM. */
  from: string;
  /** When this walk began — a replication gap recorded after it cannot be covered by it. */
  startedAt: string;
  /** Opaque resume token; null once the walk is exhausted. */
  cursor: string | null;
  total: { scanned: number; copied: number; skipped: number; failed: number };
  done: boolean;
  updatedAt: string;
}

export interface StoragePoolEntry {
  /** Mirrored on write while enabled. The primary is always enabled. */
  enabled: boolean;
  config: Record<string, unknown>;
  updatedAt?: string;
  /**
   * Readiness for promotion, not a progress bar: set only when a
   * back-fill walked this vendor's ENTIRE namespace (no prefix) to
   * completion with zero failures, and recording which primary it was
   * walked from. Promotion checks it so a half-populated mirror cannot
   * silently become the provider every read resolves through.
   * Cleared whenever the vendor's credentials change (they may point at a
   * different bucket) or when the primary changes underneath it.
   */
  syncedAt?: string | null;
  syncedFrom?: string | null;
  /**
   * A known replication gap: a mirrored write failed, or replication could
   * not even be resolved. Set server-side on the upload path, never from a
   * client. Any dirty mark clears `syncedAt`, so promotion stays blocked
   * until a fresh whole-namespace walk proves the vendor caught up.
   */
  dirtyAt?: string | null;
  dirtyReason?: string | null;
  /** In-flight (or last finished) back-fill walk — see StoragePoolSyncState. */
  sync?: StoragePoolSyncState | null;
}

export interface StorageReplication {
  /** Mirror every successful primary upload to the enabled replicas. */
  enabled: boolean;
  /**
   * Also propagate ORDINARY deletes. Off by default — a replica then
   * doubles as a backup. This flag never applies to workspace/user
   * lifecycle deletion, which must purge every physical copy regardless
   * (see server/services/storage/poolScopes.ts).
   */
  mirrorDeletes: boolean;
}

export interface StoragePool {
  primary: string | null;
  replication: StorageReplication;
  providers: Record<string, StoragePoolEntry>;
  /** Bumped by every committed write; the compare-and-set token. */
  revision: number;
}

/** A whole-pool write lost the race with a newer committed write. */
export class StoragePoolConflictError extends Error {
  constructor(public readonly currentRevision: number) {
    super('storage_pool_revision_conflict');
    this.name = 'StoragePoolConflictError';
  }
}

const DEFAULT_REPLICATION: StorageReplication = { enabled: true, mirrorDeletes: false };

export function emptyPool(): StoragePool {
  return { primary: null, replication: { ...DEFAULT_REPLICATION }, providers: {}, revision: 0 };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asIsoOrNull(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function asCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function normalizeSyncState(value: unknown): StoragePoolSyncState | null {
  const raw = asRecord(value);
  if (typeof raw.from !== 'string' || !raw.from) return null;
  const total = asRecord(raw.total);
  return {
    prefix: typeof raw.prefix === 'string' ? raw.prefix : '',
    from: raw.from,
    startedAt: asIsoOrNull(raw.startedAt) ?? new Date(0).toISOString(),
    cursor: asIsoOrNull(raw.cursor),
    total: {
      scanned: asCount(total.scanned),
      copied: asCount(total.copied),
      skipped: asCount(total.skipped),
      failed: asCount(total.failed),
    },
    done: raw.done === true,
    updatedAt: asIsoOrNull(raw.updatedAt) ?? new Date(0).toISOString(),
  };
}

/** Accepts anything the jsonb column may hold and returns a well-formed pool. */
export function normalizePool(value: unknown): StoragePool {
  const raw = asRecord(value);
  const providersRaw = asRecord(raw.providers);
  const providers: Record<string, StoragePoolEntry> = {};

  for (const [name, entryRaw] of Object.entries(providersRaw)) {
    const entry = asRecord(entryRaw);
    providers[name] = {
      enabled: entry.enabled !== false,
      config: asRecord(entry.config),
      updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : undefined,
      syncedAt: asIsoOrNull(entry.syncedAt),
      syncedFrom: asIsoOrNull(entry.syncedFrom),
      dirtyAt: asIsoOrNull(entry.dirtyAt),
      dirtyReason: asIsoOrNull(entry.dirtyReason),
      sync: normalizeSyncState(entry.sync),
    };
  }

  const replicationRaw = asRecord(raw.replication);
  const primary = typeof raw.primary === 'string' && providers[raw.primary] ? raw.primary : null;

  return {
    primary,
    replication: {
      enabled: replicationRaw.enabled !== false,
      mirrorDeletes: replicationRaw.mirrorDeletes === true,
    },
    providers,
    revision: asCount(raw.revision),
  };
}

/**
 * `app_runtime_config.value` for the legacy key is untyped — it stores
 * either `{provider_name, config}` or the provider fields flattened.
 */
function splitLegacyValue(value: unknown): { providerName: string | null; config: Record<string, unknown> } {
  const raw = asRecord(value);
  const providerName =
    typeof raw.provider_name === 'string' ? raw.provider_name
      : typeof raw.provider === 'string' ? raw.provider
        : null;
  const config = raw.config && typeof raw.config === 'object' ? asRecord(raw.config) : raw;
  return { providerName, config };
}

/**
 * Read the pool. Throws on a DB error — a transient failure must never be
 * indistinguishable from "nothing is configured".
 */
export async function readStoragePool(serverConfig: ServerConfig): Promise<StoragePool> {
  const sb = getServiceClient(serverConfig);

  const [poolRow, legacyRow] = await Promise.all([
    mustDb(
      await sb.from('app_runtime_config').select('value').eq('key', STORAGE_POOL_KEY).maybeSingle(),
      'readStoragePool.pool',
    ),
    mustDb(
      await sb.from('app_runtime_config').select('value').eq('key', STORAGE_DEFAULT_KEY).maybeSingle(),
      'readStoragePool.default',
    ),
  ]);

  const pool = normalizePool((poolRow as { value?: unknown } | null)?.value);
  const legacy = splitLegacyValue((legacyRow as { value?: unknown } | null)?.value);

  // Seed from the legacy default so an operator who has never opened this
  // screen still sees their current provider as the primary.
  if (Object.keys(pool.providers).length === 0 && legacy.providerName) {
    pool.providers[legacy.providerName] = {
      enabled: true, config: legacy.config, syncedAt: null, syncedFrom: null, dirtyAt: null, dirtyReason: null,
    };
    pool.primary = legacy.providerName;
    return pool;
  }

  // The legacy pointer wins over a stale `primary` — it is what the running
  // app actually resolves through, so the screen must never disagree with it.
  if (legacy.providerName && pool.providers[legacy.providerName]) {
    pool.primary = legacy.providerName;
  } else if (!pool.primary) {
    const firstEnabled = Object.entries(pool.providers).find(([, e]) => e.enabled)?.[0];
    pool.primary = firstEnabled ?? Object.keys(pool.providers)[0] ?? null;
  }

  return pool;
}

/**
 * Persist the pool AND the legacy primary pointer in ONE transaction
 * (set_storage_provider_pool), as a compare-and-set against the revision the
 * pool was read at. A partial write would send reads and writes to different
 * vendors, and a stale write would silently undo somebody else's change — so
 * there is no fallback to separate upserts and no "last writer wins".
 *
 * Throws StoragePoolConflictError when another write committed first; the
 * caller re-reads and decides, it never overwrites.
 */
export async function writeStoragePool(
  serverConfig: ServerConfig,
  pool: StoragePool,
  opts?: { expectedRevision?: number },
): Promise<number> {
  const normalized = normalizePool(pool);

  // The primary is implicitly enabled; a disabled primary would mean the
  // platform writes to a vendor it also considers switched off.
  if (normalized.primary && normalized.providers[normalized.primary]) {
    normalized.providers[normalized.primary].enabled = true;
  }

  const legacyValue = normalized.primary
    ? {
        provider_name: normalized.primary,
        config: normalized.providers[normalized.primary]?.config ?? {},
      }
    : null;

  const expectedRevision = opts?.expectedRevision ?? pool.revision ?? 0;

  const sb = getServiceClient(serverConfig);
  const { data, error } = await sb.rpc('set_storage_provider_pool', {
    _pool: normalized,
    _default: legacyValue,
    _expected_revision: expectedRevision,
  });
  if (error) {
    throw new Error(`db_write_failed[writeStoragePool]: ${error.message}`);
  }
  const result = (data ?? {}) as { ok?: boolean; error?: string; revision?: number };
  if (result.ok === false) {
    if (result.error === 'revision_conflict') throw new StoragePoolConflictError(result.revision ?? 0);
    throw new Error(`db_write_failed[writeStoragePool]: ${result.error ?? 'unknown'}`);
  }
  return result.revision ?? expectedRevision + 1;
}

export interface ReplicaSyncPersistOutcome {
  ok: boolean;
  revision?: number;
  /** One of: pool_missing, provider_missing, config_changed, primary_changed, replication_gap_during_walk. */
  error?: string;
}

/**
 * Persist one vendor's back-fill progress — and, when the walk earned it,
 * its promotion readiness — WITHOUT rewriting the rest of the pool.
 *
 * Guarded so a walk that started under different conditions can never
 * conclude something about the present: the vendor's config must be
 * byte-identical to what the walk read, the primary must still be the one it
 * copied from, and (when marking readiness) no replication gap may have been
 * recorded since `walkStartedAt`.
 */
export async function persistReplicaSync(
  serverConfig: ServerConfig,
  params: {
    provider: string;
    sync: StoragePoolSyncState | null;
    markSynced: boolean;
    expectedConfig: Record<string, unknown>;
    expectedPrimary: string | null;
    walkStartedAt: string;
  },
): Promise<ReplicaSyncPersistOutcome> {
  const sb = getServiceClient(serverConfig);
  const { data, error } = await sb.rpc('set_storage_replica_sync', {
    _provider: params.provider,
    _sync: params.sync,
    _mark_synced: params.markSynced,
    _expected_config: params.expectedConfig,
    _expected_primary: params.expectedPrimary,
    _walk_started_at: params.walkStartedAt,
  });
  if (error) throw new Error(`db_write_failed[persistReplicaSync]: ${error.message}`);
  const result = (data ?? {}) as { ok?: boolean; error?: string; revision?: number };
  return result.ok ? { ok: true, revision: result.revision ?? 0 } : { ok: false, error: result.error ?? 'unknown' };
}

/**
 * Record a known replication gap for one vendor: it clears that vendor's
 * promotion readiness durably, server-side, from the upload path. Never
 * throws into the caller's write — the primary already holds the object and
 * the upload must not fail because bookkeeping did — but it does report
 * failure so the caller can log it.
 */
export async function markReplicaDirty(
  serverConfig: ServerConfig,
  provider: string,
  reason: string,
): Promise<boolean> {
  try {
    const sb = getServiceClient(serverConfig);
    const { error } = await sb.rpc('mark_storage_replica_dirty', { _provider: provider, _reason: reason });
    if (error) {
      console.error(`[storage] could not mark ${provider} dirty (${reason}): ${error.message}`);
      return false;
    }
    return true;
  } catch (err: unknown) {
    console.error(`[storage] could not mark ${provider} dirty (${reason}):`, err instanceof Error ? err.message : err);
    return false;
  }
}

/**
 * Replication could not even be resolved for a write that DID land on the
 * primary — so every replica may now be missing that object and none of them
 * can be trusted as promotable. Marks them all without reading the pool
 * first, because reading the pool is exactly what failed.
 */
export async function markReplicationUncertain(
  serverConfig: ServerConfig,
  reason: string,
): Promise<boolean> {
  try {
    const sb = getServiceClient(serverConfig);
    const { error } = await sb.rpc('mark_storage_replication_uncertain', { _reason: reason });
    if (error) {
      console.error(`[storage] could not mark replication uncertain (${reason}): ${error.message}`);
      return false;
    }
    return true;
  } catch (err: unknown) {
    console.error(`[storage] could not mark replication uncertain (${reason}):`, err instanceof Error ? err.message : err);
    return false;
  }
}

/** Every enabled vendor that is not the primary — the mirror targets. */
export function replicaEntries(pool: StoragePool): { name: string; config: Record<string, unknown> }[] {
  return Object.entries(pool.providers)
    .filter(([name, entry]) => entry.enabled && name !== pool.primary)
    .map(([name, entry]) => ({ name, config: entry.config }));
}

/**
 * Has this vendor been proven to hold everything the CURRENT primary
 * holds? Only a completed whole-namespace back-fill from that same primary
 * counts (see StoragePoolEntry.syncedAt).
 */
export function isReplicaSynchronized(pool: StoragePool, name: string): boolean {
  const entry = pool.providers[name];
  if (!entry?.syncedAt) return false;
  if (!pool.primary || entry.syncedFrom !== pool.primary) return false;
  // A gap recorded after the proof invalidates it. The dirty writers already
  // clear syncedAt; this is the belt-and-braces check for a row written by an
  // older build or repaired by hand.
  if (entry.dirtyAt && entry.dirtyAt >= entry.syncedAt) return false;
  return true;
}

/** Invalidate a vendor's promotion readiness — its credentials or its source primary changed. */
export function clearSyncReadiness(entry: StoragePoolEntry): void {
  entry.syncedAt = null;
  entry.syncedFrom = null;
  entry.dirtyAt = null;
  entry.dirtyReason = null;
  entry.sync = null;
}
