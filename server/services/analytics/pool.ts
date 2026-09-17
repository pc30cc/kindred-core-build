/**
 * ANALYTICS STORAGE POOL — a SECOND, INDEPENDENT storage topology.
 *
 * The platform already has a storage pool (server/services/storage/pool.ts):
 * one primary that serves every attachment, avatar, recording and workspace
 * file, plus mirrors. That pool is NOT this one, and the two must never be
 * read through each other.
 *
 *   General Storage Primary  = e.g. Bunny   → workspace/, users/, platform/
 *   Analytics Storage Primary = e.g. Arvan  → analytics/
 *
 * Changing one has no effect on the other. That is the whole point of this
 * module existing rather than adding a flag to the general pool: a role is
 * per-topology, and only the CREDENTIALS are shared.
 *
 * Shared credentials, separate roles
 * ----------------------------------
 * This pool stores provider NAMES only. The actual endpoint/bucket/keys are
 * resolved at use time from the general pool's provider entries — the same
 * records the Providers → Storage screen writes. So an operator who has
 * already configured Arvan for general storage does not re-enter a single
 * credential to make it the analytics primary, and rotating that credential
 * in one place fixes both topologies. There is deliberately no
 * `analytics_access_key` anywhere in this codebase.
 *
 * Where it lives: `app_runtime_config` under its own key, written through
 * its own compare-and-set RPC (database/migrations/192…), exactly mirroring
 * the proven semantics of the general pool — revision conflicts, guarded
 * replica-progress writes, durable dirty marks — without sharing a byte of
 * its state. Same proven semantics, different logical pool.
 */

import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { mustDb } from '../../utils/mustDb.js';
import { readStoragePool } from '../storage/pool.js';
import { storageConfigFromRecord, type StorageConfig } from '../storage/index.js';

export const ANALYTICS_POOL_KEY = 'analytics_storage_pool';

/** Bumped whenever a written row's shape changes in a way readers must notice. */
/**
 * v2 added `session_last_seen_at` so a session's duration is the same
 * number on both read paths. Files written at v1 lack the column; every
 * read uses `union_by_name = true`, so they surface it as NULL and the
 * query falls back to MAX(occurred_at) — the v1 behaviour, for v1 data.
 */
export const ANALYTICS_SCHEMA_VERSION = 2;

// ─── Provider eligibility ────────────────────────────────────────

/**
 * Which vendors may hold analytics objects, and in which role.
 *
 * This is a capability statement, not a vendor preference list. An analytics
 * PRIMARY is the canonical store AND the thing the Phase 2 query engine
 * points at, so it has to support the full object contract (PUT / GET /
 * LIST / DELETE plus ranged GET, which is how any Parquet reader avoids
 * downloading a whole file to read its footer) over an S3-compatible
 * endpoint.
 *
 * A REPLICA only ever receives and returns whole objects, so the bar is
 * lower — a vendor that is a fine backup but that no Parquet reader can
 * query directly is allowed to be a replica and refused as a primary. That
 * is exactly the distinction the requirement asks for, and it falls out of
 * the driver table in server/services/storage/index.ts rather than being a
 * hardcoded list of brand names.
 */
export const ANALYTICS_PRIMARY_ELIGIBLE = [
  's3', 'arvan_storage', 'cloudflare_r2', 'minio', 'do_spaces', 'local',
] as const;

/**
 * Replica-eligible adds the vendors that can store and return an object but
 * cannot be queried as a Parquet source: Bunny speaks its own HTTP storage
 * API, not S3.
 *
 * `gcs` and `azure_blob` are in NEITHER list. The general pool maps them
 * onto the S3 upload handler as an optimistic interop bet, but they have no
 * LIST or DELETE handler — so replication could write to them and then
 * never be able to prove, re-sync or purge what it wrote. A replica whose
 * contents cannot be listed is not a replica, it is a write-only hole.
 */
export const ANALYTICS_REPLICA_ELIGIBLE = [
  ...ANALYTICS_PRIMARY_ELIGIBLE, 'bunny_storage',
] as const;

export function isAnalyticsPrimaryEligible(provider: string): boolean {
  return (ANALYTICS_PRIMARY_ELIGIBLE as readonly string[]).includes(provider);
}

export function isAnalyticsReplicaEligible(provider: string): boolean {
  return (ANALYTICS_REPLICA_ELIGIBLE as readonly string[]).includes(provider);
}

// ─── Model ───────────────────────────────────────────────────────

/** Progress of an analytics back-fill walk — same shape and rules as the general pool's. */
export interface AnalyticsSyncState {
  prefix: string;
  /** The analytics primary the objects were copied FROM — never the general primary. */
  from: string;
  startedAt: string;
  cursor: string | null;
  total: { scanned: number; copied: number; skipped: number; failed: number };
  done: boolean;
  updatedAt: string;
}

export interface AnalyticsReplicaState {
  /** Proven to hold everything the CURRENT analytics primary holds. */
  syncedAt?: string | null;
  syncedFrom?: string | null;
  /**
   * A known replication gap. Kept because PROMOTION correctness depends on
   * it — promoting a replica that missed writes loses data — not for
   * reporting. No reason string, no error string, no history.
   */
  dirtyAt?: string | null;
  sync?: AnalyticsSyncState | null;
}

/** Dual-write keeps PostgreSQL authoritative; s3_only is a later, explicit cutover. */
export type AnalyticsWriteMode = 'dual_write' | 's3_only';
/** Phase 1 always reads PostgreSQL. `s3` is Phase 3 and is refused until then. */
export type AnalyticsReadMode = 'postgres' | 's3';

export interface AnalyticsStoragePool {
  enabled: boolean;
  primary: string | null;
  replicas: string[];
  replicationEnabled: boolean;
  prefix: string;
  batchRows: number;
  batchBytes: number;
  flushIntervalMs: number;
  /** Fixed for now — declared so the wire shape does not change when it stops being fixed. */
  format: 'parquet';
  compression: 'zstd';
  /**
   * Every prefix this pool has ever written under, newest last, including
   * the current one.
   *
   * The prefix IS the namespace, so changing it strands everything written
   * under the old one — including, critically, objects that a workspace
   * deletion must still be able to find and purge. Keeping the history
   * means deletion walks every place a workspace's analytics data can
   * physically be, not just wherever the pool happens to point today.
   * Bounded to the last few so a pathological operator cannot grow the row
   * without limit.
   */
  knownPrefixes: string[];
  writeMode: AnalyticsWriteMode;
  readMode: AnalyticsReadMode;
  replicaState: Record<string, AnalyticsReplicaState>;
  /** Last successful canonical write, for the admin status panel. */
  revision: number;
}

/**
 * Defaults tuned for a chat-widget-scale site rather than ad-tech volume:
 * ~10k rows or ~32 MB of buffered Parquet input, whichever comes first, and
 * a 15 s ceiling so a quiet workspace still lands its rows promptly instead
 * of holding them until the buffer happens to fill.
 */
export const ANALYTICS_DEFAULTS = {
  prefix: 'analytics/web/',
  batchRows: 10_000,
  batchBytes: 32 * 1024 * 1024,
  flushIntervalMs: 15_000,
} as const;

export const ANALYTICS_LIMITS = {
  batchRows: { min: 100, max: 500_000 },
  batchBytes: { min: 1024 * 1024, max: 256 * 1024 * 1024 },
  flushIntervalMs: { min: 1_000, max: 300_000 },
} as const;

export class AnalyticsPoolConflictError extends Error {
  constructor(public readonly currentRevision: number) {
    super('analytics_pool_revision_conflict');
    this.name = 'AnalyticsPoolConflictError';
  }
}

export function emptyAnalyticsPool(): AnalyticsStoragePool {
  return {
    // Off until a platform admin turns it on. A brand-new write pipeline
    // must never start emitting objects on the strength of a deploy.
    enabled: false,
    primary: null,
    replicas: [],
    replicationEnabled: true,
    prefix: ANALYTICS_DEFAULTS.prefix,
    batchRows: ANALYTICS_DEFAULTS.batchRows,
    batchBytes: ANALYTICS_DEFAULTS.batchBytes,
    flushIntervalMs: ANALYTICS_DEFAULTS.flushIntervalMs,
    format: 'parquet',
    compression: 'zstd',
    knownPrefixes: [ANALYTICS_DEFAULTS.prefix],
    writeMode: 'dual_write',
    readMode: 'postgres',
    replicaState: {},
    revision: 0,
  };
}

// ─── Normalization ───────────────────────────────────────────────

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

function clamp(value: unknown, range: { min: number; max: number }, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.floor(value), range.min), range.max);
}

/**
 * Normalizes the stored prefix into the one canonical shape every other
 * module may assume: no leading slash, exactly one trailing slash, no
 * traversal. An operator-supplied prefix reaches object keys, so it is
 * sanitized here rather than at each of the places that concatenate it.
 */
export function normalizeAnalyticsPrefix(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return ANALYTICS_DEFAULTS.prefix;
  const cleaned = raw
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\\/g, '')
    .replace(/\.\./g, '');
  if (!cleaned) return ANALYTICS_DEFAULTS.prefix;
  return `${cleaned}/`;
}

/**
 * The prefix history, always containing the CURRENT prefix.
 *
 * Deduped, sanitized through the same rules as the live prefix, and capped:
 * this list is walked by workspace deletion, so every entry costs a listing
 * per vendor per deleted workspace. The cap is generous enough that a real
 * operator never hits it and low enough that a scripted loop cannot turn
 * deletion into an unbounded walk.
 */
export const MAX_KNOWN_PREFIXES = 8;

/**
 * The history, oldest first, always ending with the CURRENT prefix.
 *
 * Nothing is ever evicted. Dropping the oldest entry to stay under the cap
 * would discard exactly the prefix most likely to still hold objects and
 * least likely to be written again — and deletion walks this list, so an
 * evicted prefix becomes permanently unpurgeable. The admin route refuses a
 * further prefix change once the cap is reached instead
 * (server/routes/adminAnalyticsStorage.ts).
 */
function normalizeKnownPrefixes(value: unknown, current: string): string[] {
  const raw = Array.isArray(value) ? value : [];
  const cleaned = raw
    .filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '')
    .map((entry) => normalizeAnalyticsPrefix(entry));
  return [...new Set([...cleaned.filter((entry) => entry !== current), current])];
}

function normalizeSyncState(value: unknown): AnalyticsSyncState | null {
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

export function normalizeAnalyticsPool(value: unknown): AnalyticsStoragePool {
  const raw = asRecord(value);
  const base = emptyAnalyticsPool();

  const primary =
    typeof raw.primary === 'string' && isAnalyticsPrimaryEligible(raw.primary) ? raw.primary : null;

  const replicas = Array.isArray(raw.replicas)
    ? Array.from(
        new Set(
          raw.replicas.filter(
            (name): name is string =>
              typeof name === 'string' && name !== primary && isAnalyticsReplicaEligible(name),
          ),
        ),
      )
    : [];

  const replicaStateRaw = asRecord(raw.replicaState);
  const replicaState: Record<string, AnalyticsReplicaState> = {};
  for (const [name, entryRaw] of Object.entries(replicaStateRaw)) {
    const entry = asRecord(entryRaw);
    replicaState[name] = {
      syncedAt: asIsoOrNull(entry.syncedAt),
      syncedFrom: asIsoOrNull(entry.syncedFrom),
      dirtyAt: asIsoOrNull(entry.dirtyAt),
      sync: normalizeSyncState(entry.sync),
    };
  }

  const prefix = normalizeAnalyticsPrefix(raw.prefix);

  return {
    enabled: raw.enabled === true,
    primary,
    replicas,
    replicationEnabled: raw.replicationEnabled !== false,
    prefix,
    batchRows: clamp(raw.batchRows, ANALYTICS_LIMITS.batchRows, base.batchRows),
    batchBytes: clamp(raw.batchBytes, ANALYTICS_LIMITS.batchBytes, base.batchBytes),
    flushIntervalMs: clamp(raw.flushIntervalMs, ANALYTICS_LIMITS.flushIntervalMs, base.flushIntervalMs),
    format: 'parquet',
    compression: 'zstd',
    knownPrefixes: normalizeKnownPrefixes(raw.knownPrefixes, prefix),
    writeMode: raw.writeMode === 's3_only' ? 's3_only' : 'dual_write',
    readMode: raw.readMode === 's3' ? 's3' : 'postgres',
    replicaState,
    revision: asCount(raw.revision),
  };
}

// ─── Read / write ────────────────────────────────────────────────

/**
 * Read the analytics pool. Throws on a DB error rather than resolving to an
 * empty pool: "the database is briefly unavailable" and "analytics storage
 * is not configured" must never be the same answer, or a transient failure
 * would let a save overwrite a configured topology with a blank one.
 */
export async function readAnalyticsPool(serverConfig: ServerConfig): Promise<AnalyticsStoragePool> {
  const sb = getServiceClient(serverConfig);
  const row = await mustDb(
    await sb.from('app_runtime_config').select('value').eq('key', ANALYTICS_POOL_KEY).maybeSingle(),
    'readAnalyticsPool',
  );
  return normalizeAnalyticsPool((row as { value?: unknown } | null)?.value);
}

/**
 * Persist the pool as a compare-and-set against the revision it was read at.
 *
 * Writes ONLY the analytics key. It never touches `storage_provider_pool` or
 * `default_storage_provider` — which is the mechanical reason changing the
 * analytics primary cannot move the general one, and vice versa.
 */
export async function writeAnalyticsPool(
  serverConfig: ServerConfig,
  pool: AnalyticsStoragePool,
  opts?: { expectedRevision?: number },
): Promise<number> {
  const normalized = normalizeAnalyticsPool(pool);
  const expectedRevision = opts?.expectedRevision ?? pool.revision ?? 0;

  const sb = getServiceClient(serverConfig);
  const { data, error } = await sb.rpc('set_analytics_storage_pool', {
    _pool: normalized,
    _expected_revision: expectedRevision,
  });
  if (error) throw new Error(`db_write_failed[writeAnalyticsPool]: ${error.message}`);

  const result = (data ?? {}) as { ok?: boolean; error?: string; revision?: number };
  if (result.ok === false) {
    if (result.error === 'revision_conflict') throw new AnalyticsPoolConflictError(result.revision ?? 0);
    throw new Error(`db_write_failed[writeAnalyticsPool]: ${result.error ?? 'unknown'}`);
  }
  return result.revision ?? expectedRevision + 1;
}

/**
 * Analytics deliberately keeps NO usage counters, no last-write timestamp and
 * no error history.
 *
 * `recordAnalyticsWrite` and `recordAnalyticsError` used to write to
 * PostgreSQL on every flush and every failure, which turned the database into
 * a telemetry store for a subsystem whose entire point is to stop writing to
 * it. The information they collected only ever fed an admin panel, and the
 * panel now answers the one question that matters — is the provider reachable
 * RIGHT NOW — by running a live round trip instead of reading a stale row.
 *
 * The SQL functions `record_analytics_storage_write` and
 * `record_analytics_storage_error` are left in the database (dropping them is
 * a destructive migration nobody needs) but nothing calls them any more.
 */

export interface AnalyticsSyncPersistOutcome {
  ok: boolean;
  revision?: number;
  error?: string;
}

/**
 * Persist one replica's back-fill progress, guarded the same three ways the
 * general pool guards its own: the analytics primary must still be the one
 * the walk copied from, the replica must still be in the replica list, and
 * (when claiming readiness) no replication gap may have been recorded since
 * the walk began.
 */
export async function persistAnalyticsReplicaSync(
  serverConfig: ServerConfig,
  params: {
    provider: string;
    sync: AnalyticsSyncState | null;
    markSynced: boolean;
    expectedPrimary: string | null;
    walkStartedAt: string;
  },
): Promise<AnalyticsSyncPersistOutcome> {
  const sb = getServiceClient(serverConfig);
  const { data, error } = await sb.rpc('set_analytics_replica_sync', {
    _provider: params.provider,
    _sync: params.sync,
    _mark_synced: params.markSynced,
    _expected_primary: params.expectedPrimary,
    _walk_started_at: params.walkStartedAt,
  });
  if (error) throw new Error(`db_write_failed[persistAnalyticsReplicaSync]: ${error.message}`);
  const result = (data ?? {}) as { ok?: boolean; error?: string; revision?: number };
  return result.ok ? { ok: true, revision: result.revision ?? 0 } : { ok: false, error: result.error ?? 'unknown' };
}

/** A mirrored analytics write failed — clear that replica's readiness durably. */
export async function markAnalyticsReplicaDirty(
  serverConfig: ServerConfig,
  provider: string,
  reason: string,
): Promise<boolean> {
  try {
    const sb = getServiceClient(serverConfig);
    const { error } = await sb.rpc('mark_analytics_replica_dirty', {
      _provider: provider,
      _reason: reason.slice(0, 500),
    });
    if (error) {
      console.error(`[analytics] could not mark ${provider} dirty (${reason}): ${error.message}`);
      return false;
    }
    return true;
  } catch (err: unknown) {
    console.error(`[analytics] could not mark ${provider} dirty:`, err instanceof Error ? err.message : err);
    return false;
  }
}

/** Replication could not be resolved at all for an object the primary already holds. */
export async function markAnalyticsReplicationUncertain(
  serverConfig: ServerConfig,
  reason: string,
): Promise<boolean> {
  try {
    const sb = getServiceClient(serverConfig);
    const { error } = await sb.rpc('mark_analytics_replication_uncertain', { _reason: reason.slice(0, 500) });
    if (error) {
      console.error(`[analytics] could not mark replication uncertain: ${error.message}`);
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

// ─── Readiness ───────────────────────────────────────────────────

/**
 * Has this replica been proven to hold everything the CURRENT analytics
 * primary holds? Only a completed walk of the whole analytics prefix, from
 * that same primary, with zero failures, counts — and a gap recorded after
 * that proof invalidates it.
 */
export function isAnalyticsReplicaSynchronized(pool: AnalyticsStoragePool, name: string): boolean {
  const state = pool.replicaState[name];
  if (!state?.syncedAt) return false;
  if (!pool.primary || state.syncedFrom !== pool.primary) return false;
  if (state.dirtyAt && state.dirtyAt >= state.syncedAt) return false;
  return true;
}

/**
 * Three states, because three is what promotion needs to decide.
 *
 * There used to be five, separating "behind" from "never synchronized" from
 * "failed" — distinctions that only existed to fill a status column. What
 * matters is whether this replica may be promoted without losing data, and
 * `dirty` says why it may not.
 */
export type AnalyticsReplicaHealth = 'synchronized' | 'dirty' | 'never_synchronized';

export function analyticsReplicaHealth(pool: AnalyticsStoragePool, name: string): AnalyticsReplicaHealth {
  const state = pool.replicaState[name];
  if (!state) return 'never_synchronized';
  if (isAnalyticsReplicaSynchronized(pool, name)) return 'synchronized';
  if (state.dirtyAt) return 'dirty';
  return 'never_synchronized';
}

/** Invalidate a replica's readiness — its source primary or its credentials changed. */
export function clearAnalyticsReadiness(state: AnalyticsReplicaState): void {
  state.syncedAt = null;
  state.syncedFrom = null;
  state.dirtyAt = null;
  state.sync = null;
}

// ─── Credential resolution (from the GENERAL provider records) ────

export interface ResolvedAnalyticsTopology {
  primary: { name: string; config: StorageConfig } | null;
  replicas: { name: string; config: StorageConfig }[];
  /** Providers named by the analytics pool that hold no credentials yet. */
  missingCredentials: string[];
}

/**
 * Turn the analytics pool's provider NAMES into usable configs by looking up
 * the credentials the Providers → Storage screen already stores.
 *
 * This is the single place the two topologies touch, and it is read-only in
 * one direction: analytics borrows the general pool's CREDENTIALS and
 * ignores its roles entirely. `generalPool.primary` is never consulted —
 * an analytics write goes to the analytics primary even when that vendor is
 * a mere mirror (or is switched off) on the general side, because the
 * general `enabled` flag governs general mirroring, not this topology.
 */
export async function resolveAnalyticsTopology(
  serverConfig: ServerConfig,
  pool: AnalyticsStoragePool,
): Promise<ResolvedAnalyticsTopology> {
  const generalPool = await readStoragePool(serverConfig);
  const missingCredentials: string[] = [];

  const configOf = (name: string): StorageConfig | null => {
    const entry = generalPool.providers[name];
    if (!entry || Object.keys(entry.config).length === 0) {
      missingCredentials.push(name);
      return null;
    }
    return storageConfigFromRecord(name, entry.config);
  };

  const primaryConfig = pool.primary ? configOf(pool.primary) : null;

  const replicas: { name: string; config: StorageConfig }[] = [];
  if (pool.replicationEnabled) {
    for (const name of pool.replicas) {
      const config = configOf(name);
      if (config) replicas.push({ name, config });
    }
  }

  return {
    primary: pool.primary && primaryConfig ? { name: pool.primary, config: primaryConfig } : null,
    replicas,
    missingCredentials,
  };
}

/** Provider names that currently hold credentials, whatever their general-pool role is. */
export async function configuredProviderNames(serverConfig: ServerConfig): Promise<string[]> {
  const generalPool = await readStoragePool(serverConfig);
  return Object.entries(generalPool.providers)
    .filter(([, entry]) => Object.keys(entry.config).length > 0)
    .map(([name]) => name);
}
