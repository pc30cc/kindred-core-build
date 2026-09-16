/**
 * In-memory stand-in for BOTH storage halves of `app_runtime_config`:
 *
 *   storage_provider_pool     — the general topology (migration 189)
 *   analytics_storage_pool    — the analytics topology (migration 192)
 *
 * Both are here on purpose. The central claim these suites exist to prove is
 * that the two are INDEPENDENT, and that claim is only meaningful if both
 * live in the same fake store and could, in principle, interfere. A fake
 * that held only the analytics key would make the isolation tests pass by
 * construction rather than by evidence.
 *
 * The RPC bodies re-implement the semantics of the real migrations —
 * revision compare-and-set, the primary/replica guards, durable dirty marks
 * — so concurrency and readiness rules can be exercised without a database.
 * The SQL itself is covered by the migration-chain jobs in CI.
 *
 * Not a test file — no `.test.ts` suffix — it is imported by the suites and
 * by their `vi.mock` factories, which share this module's singleton state.
 */

export const STORAGE_POOL_KEY = 'storage_provider_pool';
export const STORAGE_DEFAULT_KEY = 'default_storage_provider';
export const ANALYTICS_POOL_KEY = 'analytics_storage_pool';

export const runtimeConfig = new Map<string, unknown>();

export const dbState: {
  readError: { message: string } | null;
  analyticsWrites: number;
  generalWrites: number;
} = { readError: null, analyticsWrites: 0, generalWrites: 0 };

export function resetFakeAnalyticsPool(): void {
  runtimeConfig.clear();
  dbState.readError = null;
  dbState.analyticsWrites = 0;
  dbState.generalWrites = 0;
}

type Json = Record<string, unknown>;

function get(key: string): Json | null {
  return (runtimeConfig.get(key) as Json | undefined) ?? null;
}

function revisionOf(value: Json | null): number {
  const raw = value?.revision;
  return typeof raw === 'number' ? raw : 0;
}

function nowIso(): string {
  return new Date().toISOString();
}

export function getAnalyticsPool(): Json | null {
  return get(ANALYTICS_POOL_KEY);
}

export function getGeneralPool(): Json | null {
  return get(STORAGE_POOL_KEY);
}

export function getReplicaState(provider: string): Json | undefined {
  const state = (get(ANALYTICS_POOL_KEY)?.replicaState as Record<string, Json> | undefined) ?? {};
  return state[provider];
}

/** Seed a general pool with credentials — the only thing analytics borrows from it. */
export function seedGeneralPool(params: {
  primary: string | null;
  providers: Record<string, { enabled?: boolean; config: Json }>;
  replicationEnabled?: boolean;
}): void {
  const providers: Record<string, Json> = {};
  for (const [name, entry] of Object.entries(params.providers)) {
    providers[name] = {
      enabled: entry.enabled !== false,
      config: entry.config,
      syncedAt: null, syncedFrom: null, dirtyAt: null, dirtyReason: null, sync: null,
    };
  }
  runtimeConfig.set(STORAGE_POOL_KEY, {
    primary: params.primary,
    replication: { enabled: params.replicationEnabled !== false, mirrorDeletes: false },
    providers,
    revision: 1,
  });
  if (params.primary) {
    runtimeConfig.set(STORAGE_DEFAULT_KEY, {
      provider_name: params.primary,
      config: params.providers[params.primary]?.config ?? {},
    });
  }
}

export function seedAnalyticsPool(pool: Json): void {
  runtimeConfig.set(ANALYTICS_POOL_KEY, { revision: 1, ...pool });
}

/** The service client every storage and analytics module resolves through. */
export function makeFakeSupabaseClient() {
  const rows: Record<string, Json[]> = {};

  const builder = (table: string) => {
    let wantedKey: string | null = null;
    const api = {
      select: () => api,
      eq: (col: string, value: string) => { if (col === 'key') wantedKey = value; return api; },
      in: () => api,
      gte: () => api, lte: () => api, order: () => api, range: () => api, limit: () => api, not: () => api,
      insert: async (row: Json) => { (rows[table] ||= []).push(row); return { data: null, error: null }; },
      update: () => api,
      upsert: async () => ({ data: null, error: null }),
      delete: () => api,
      single: async () => api.maybeSingle(),
      maybeSingle: async () => {
        if (table !== 'app_runtime_config') return { data: null, error: null };
        if (dbState.readError) return { data: null, error: dbState.readError };
        return {
          data: wantedKey && runtimeConfig.has(wantedKey)
            ? { key: wantedKey, value: runtimeConfig.get(wantedKey) }
            : null,
          error: null,
        };
      },
      then: undefined,
    };
    return api;
  };

  return {
    from: builder,
    /** Rows a suite's code inserted into a non-config table, for assertions. */
    __rows: rows,

    rpc: async (fn: string, args: Json) => {
      switch (fn) {
        // ── General pool (migration 189) ──
        case 'set_storage_provider_pool': {
          const current = get(STORAGE_POOL_KEY);
          const revision = revisionOf(current);
          const expected = args._expected_revision as number | null | undefined;
          if (expected !== null && expected !== undefined && expected !== revision) {
            return { data: { ok: false, error: 'revision_conflict', revision }, error: null };
          }
          runtimeConfig.set(STORAGE_POOL_KEY, { ...(args._pool as Json), revision: revision + 1 });
          dbState.generalWrites++;
          if (args._default == null) runtimeConfig.delete(STORAGE_DEFAULT_KEY);
          else runtimeConfig.set(STORAGE_DEFAULT_KEY, args._default);
          return { data: { ok: true, revision: revision + 1 }, error: null };
        }
        case 'mark_storage_replica_dirty':
        case 'mark_storage_replication_uncertain':
        case 'set_storage_replica_sync':
          return { data: { ok: true, revision: revisionOf(get(STORAGE_POOL_KEY)) }, error: null };

        // ── Analytics pool (migration 192) ──
        case 'set_analytics_storage_pool': {
          const current = get(ANALYTICS_POOL_KEY);
          const revision = revisionOf(current);
          const expected = args._expected_revision as number | null | undefined;
          if (expected !== null && expected !== undefined && expected !== revision) {
            return { data: { ok: false, error: 'revision_conflict', revision }, error: null };
          }
          runtimeConfig.set(ANALYTICS_POOL_KEY, { ...(args._pool as Json), revision: revision + 1 });
          dbState.analyticsWrites++;
          return { data: { ok: true, revision: revision + 1 }, error: null };
        }

        case 'set_analytics_replica_sync': {
          const current = get(ANALYTICS_POOL_KEY);
          if (!current) return { data: { ok: false, error: 'pool_missing' }, error: null };
          if ((current.primary ?? '') !== ((args._expected_primary as string | null) ?? '')) {
            return { data: { ok: false, error: 'primary_changed' }, error: null };
          }
          const replicas = (current.replicas as string[] | undefined) ?? [];
          const name = args._provider as string;
          if (!replicas.includes(name)) {
            return { data: { ok: false, error: 'replica_removed' }, error: null };
          }
          const state = { ...(((current.replicaState as Record<string, Json>) ?? {})[name] ?? {}) };
          state.sync = args._sync ?? null;
          if (args._mark_synced === true) {
            const dirtyAt = state.dirtyAt as string | null | undefined;
            const walkStartedAt = args._walk_started_at as string | null | undefined;
            if (dirtyAt && walkStartedAt && dirtyAt >= walkStartedAt) {
              return { data: { ok: false, error: 'replication_gap_during_walk' }, error: null };
            }
            state.syncedAt = nowIso();
            state.syncedFrom = args._expected_primary ?? null;
            state.dirtyAt = null;
            state.dirtyReason = null;
            state.lastError = null;
          }
          const revision = revisionOf(current);
          runtimeConfig.set(ANALYTICS_POOL_KEY, {
            ...current,
            replicaState: { ...((current.replicaState as Record<string, Json>) ?? {}), [name]: state },
            lastReplicationAt: nowIso(),
            revision: revision + 1,
          });
          return { data: { ok: true, revision: revision + 1 }, error: null };
        }

        case 'mark_analytics_replica_dirty': {
          const current = get(ANALYTICS_POOL_KEY);
          if (!current) return { data: { ok: true, skipped: 'pool_missing' }, error: null };
          const name = args._provider as string;
          const previous = ((current.replicaState as Record<string, Json>) ?? {})[name] ?? {};
          runtimeConfig.set(ANALYTICS_POOL_KEY, {
            ...current,
            replicaState: {
              ...((current.replicaState as Record<string, Json>) ?? {}),
              [name]: {
                ...previous,
                syncedAt: null, syncedFrom: null,
                dirtyAt: nowIso(),
                dirtyReason: (args._reason as string) ?? 'replication_failed',
              },
            },
            revision: revisionOf(current) + 1,
          });
          return { data: { ok: true }, error: null };
        }

        case 'mark_analytics_replication_uncertain': {
          const current = get(ANALYTICS_POOL_KEY);
          if (!current) return { data: { ok: true, marked: 0 }, error: null };
          const next: Record<string, Json> = { ...((current.replicaState as Record<string, Json>) ?? {}) };
          for (const name of (current.replicas as string[] | undefined) ?? []) {
            next[name] = {
              ...(next[name] ?? {}),
              syncedAt: null, syncedFrom: null,
              dirtyAt: nowIso(),
              dirtyReason: (args._reason as string) ?? 'replication_unresolved',
            };
          }
          runtimeConfig.set(ANALYTICS_POOL_KEY, {
            ...current, replicaState: next, revision: revisionOf(current) + 1,
          });
          return { data: { ok: true }, error: null };
        }

        case 'record_analytics_storage_write': {
          const current = get(ANALYTICS_POOL_KEY);
          if (!current) return { data: { ok: true, skipped: 'pool_missing' }, error: null };
          runtimeConfig.set(ANALYTICS_POOL_KEY, {
            ...current,
            objectsWritten: (Number(current.objectsWritten) || 0) + Number(args._objects ?? 0),
            bytesWritten: (Number(current.bytesWritten) || 0) + Number(args._bytes ?? 0),
            rowsWritten: (Number(current.rowsWritten) || 0) + Number(args._rows ?? 0),
            lastWriteAt: nowIso(),
            ...(args._replicated ? { lastReplicationAt: nowIso() } : {}),
            lastError: null, lastErrorAt: null,
            revision: revisionOf(current) + 1,
          });
          return { data: { ok: true }, error: null };
        }

        case 'record_analytics_storage_error': {
          const current = get(ANALYTICS_POOL_KEY);
          if (!current) return { data: { ok: true, skipped: 'pool_missing' }, error: null };
          runtimeConfig.set(ANALYTICS_POOL_KEY, {
            ...current,
            lastError: args._error as string,
            lastErrorAt: nowIso(),
            revision: revisionOf(current) + 1,
          });
          return { data: { ok: true }, error: null };
        }

        default:
          throw new Error(`unexpected rpc ${fn}`);
      }
    },
  };
}
