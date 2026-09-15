/**
 * In-memory stand-in for the storage-pool half of `app_runtime_config`,
 * including a faithful re-implementation of the four RPCs migration 189
 * installs:
 *
 *   set_storage_provider_pool            — whole-pool write, compare-and-set
 *   set_storage_replica_sync             — targeted, guarded progress/readiness
 *   mark_storage_replica_dirty           — targeted readiness invalidation
 *   mark_storage_replication_uncertain   — invalidate every replica at once
 *
 * The SQL itself is proven by the migration-chain jobs in CI; what these
 * suites need is the same SEMANTICS (revision conflicts, the config/primary/
 * dirty guards) without a database, so the concurrency and readiness rules
 * can be tested deterministically.
 *
 * Not a test file — no `.test.ts` suffix — it is imported by the suites and
 * by their `vi.mock` factories, which share this module's singleton state.
 */

export const POOL_KEY = 'storage_provider_pool';
export const DEFAULT_KEY = 'default_storage_provider';

export const runtimeConfig = new Map<string, unknown>();

export const dbState: {
  /** Makes app_runtime_config reads resolve as a PostgREST error. */
  readError: { message: string } | null;
  /** When set, only these keys fail; other reads still succeed. */
  readErrorKeys: string[] | null;
  /** Makes set_storage_provider_pool fail the way a real transaction would. */
  rpcError: { message: string } | null;
  poolWrites: number;
} = { readError: null, readErrorKeys: null, rpcError: null, poolWrites: 0 };

export function resetFakeStoragePool(): void {
  runtimeConfig.clear();
  dbState.readError = null;
  dbState.readErrorKeys = null;
  dbState.rpcError = null;
  dbState.poolWrites = 0;
}

type Json = Record<string, unknown>;

function pool(): Json | null {
  return (runtimeConfig.get(POOL_KEY) as Json | undefined) ?? null;
}

function revisionOf(value: Json | null): number {
  const raw = value?.revision;
  return typeof raw === 'number' ? raw : 0;
}

function providersOf(value: Json | null): Record<string, Json> {
  return (value?.providers as Record<string, Json> | undefined) ?? {};
}

/** jsonb comparison is order-insensitive; JSON.stringify is not. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Json).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

export function getPool(): Json | null {
  return pool();
}

export function getEntry(name: string): Json | undefined {
  return providersOf(pool())[name];
}

/** The service client the storage modules resolve through. */
export function makeFakeSupabaseClient() {
  return {
    from: (table: string) => {
      let wantedKey: string | null = null;
      const builder = {
        select: () => builder,
        eq: (col: string, value: string) => { if (col === 'key') wantedKey = value; return builder; },
        order: () => builder,
        limit: () => builder,
        single: async () => builder.maybeSingle(),
        // Tables other than app_runtime_config (storage_usage_logs, …) are
        // not what these suites are about — accept and drop their writes.
        insert: async () => ({ data: null, error: null }),
        update: () => builder,
        upsert: async () => ({ data: null, error: null }),
        delete: () => builder,
        not: () => builder,
        maybeSingle: async () => {
          if (table !== 'app_runtime_config') return { data: null, error: null };
          if (dbState.readError && (!dbState.readErrorKeys || (wantedKey && dbState.readErrorKeys.includes(wantedKey)))) {
            return { data: null, error: dbState.readError };
          }
          return {
            data: wantedKey && runtimeConfig.has(wantedKey)
              ? { key: wantedKey, value: runtimeConfig.get(wantedKey) }
              : null,
            error: null,
          };
        },
      };
      return builder;
    },

    rpc: async (fn: string, args: Json) => {
      switch (fn) {
        case 'set_storage_provider_pool': {
          if (dbState.rpcError) return { data: null, error: dbState.rpcError };
          const current = pool();
          const revision = revisionOf(current);
          const expected = args._expected_revision as number | null | undefined;
          if (expected !== null && expected !== undefined && expected !== revision) {
            return { data: { ok: false, error: 'revision_conflict', revision }, error: null };
          }
          const next = { ...(args._pool as Json), revision: revision + 1 };
          runtimeConfig.set(POOL_KEY, next);
          dbState.poolWrites++;
          if (args._default === null || args._default === undefined) runtimeConfig.delete(DEFAULT_KEY);
          else runtimeConfig.set(DEFAULT_KEY, args._default);
          return { data: { ok: true, revision: revision + 1 }, error: null };
        }

        case 'set_storage_replica_sync': {
          const current = pool();
          if (!current) return { data: { ok: false, error: 'pool_missing' }, error: null };
          const providers = providersOf(current);
          const name = args._provider as string;
          const entry = providers[name];
          if (!entry) return { data: { ok: false, error: 'provider_missing' }, error: null };

          if (canonical(entry.config ?? {}) !== canonical(args._expected_config ?? {})) {
            return { data: { ok: false, error: 'config_changed' }, error: null };
          }
          if ((current.primary ?? '') !== ((args._expected_primary as string | null) ?? '')) {
            return { data: { ok: false, error: 'primary_changed' }, error: null };
          }

          const nextEntry: Json = { ...entry, sync: args._sync ?? null };
          if (args._mark_synced === true) {
            const dirtyAt = entry.dirtyAt as string | null | undefined;
            const walkStartedAt = args._walk_started_at as string | null | undefined;
            if (dirtyAt && walkStartedAt && dirtyAt >= walkStartedAt) {
              return { data: { ok: false, error: 'replication_gap_during_walk' }, error: null };
            }
            nextEntry.syncedAt = nowIso();
            nextEntry.syncedFrom = args._expected_primary ?? null;
            nextEntry.dirtyAt = null;
            nextEntry.dirtyReason = null;
          }

          const revision = revisionOf(current);
          runtimeConfig.set(POOL_KEY, {
            ...current,
            providers: { ...providers, [name]: nextEntry },
            revision: revision + 1,
          });
          return { data: { ok: true, revision: revision + 1 }, error: null };
        }

        case 'mark_storage_replica_dirty': {
          const current = pool();
          if (!current) return { data: { ok: true, skipped: 'pool_missing' }, error: null };
          const providers = providersOf(current);
          const name = args._provider as string;
          const entry = providers[name];
          if (!entry) return { data: { ok: true, skipped: 'provider_missing' }, error: null };

          const revision = revisionOf(current);
          runtimeConfig.set(POOL_KEY, {
            ...current,
            providers: {
              ...providers,
              [name]: {
                ...entry,
                syncedAt: null,
                syncedFrom: null,
                dirtyAt: nowIso(),
                dirtyReason: (args._reason as string) ?? 'replication_failed',
              },
            },
            revision: revision + 1,
          });
          return { data: { ok: true, revision: revision + 1 }, error: null };
        }

        case 'mark_storage_replication_uncertain': {
          const current = pool();
          if (!current) return { data: { ok: true, marked: 0 }, error: null };
          const providers = providersOf(current);
          const primary = current.primary as string | null;
          const next: Record<string, Json> = { ...providers };
          let marked = 0;
          for (const [name, entry] of Object.entries(providers)) {
            if (primary && name === primary) continue;
            next[name] = {
              ...entry,
              syncedAt: null,
              syncedFrom: null,
              dirtyAt: nowIso(),
              dirtyReason: (args._reason as string) ?? 'replication_unresolved',
            };
            marked++;
          }
          if (marked === 0) return { data: { ok: true, marked: 0 }, error: null };
          const revision = revisionOf(current);
          runtimeConfig.set(POOL_KEY, { ...current, providers: next, revision: revision + 1 });
          return { data: { ok: true, marked, revision: revision + 1 }, error: null };
        }

        default:
          throw new Error(`unexpected rpc ${fn}`);
      }
    },
  };
}
