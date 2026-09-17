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
  for (const key of Object.keys(tableRows)) delete tableRows[key];
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

/**
 * Rows for the SOURCE tables the sealing pass and the day rebuild read
 * (`visitor_page_views`, `web_analytics_events`, `visitor_sessions`,
 * `analytics_day_seals`, `workspace_deletion_jobs`). Seeded per test; the
 * query builder below applies the filters those call sites actually use.
 */
export const tableRows: Record<string, Json[]> = {};

export function seedTable(table: string, rows: Json[]): void {
  tableRows[table] = rows;
}

interface Filter { op: 'eq' | 'gte' | 'gt' | 'lte' | 'lt' | 'in'; column: string; value: unknown }

function applyFilters(rows: Json[], filters: Filter[]): Json[] {
  return rows.filter((row) => filters.every((f) => {
    const value = row[f.column];
    switch (f.op) {
      case 'eq': return value === f.value;
      case 'in': return Array.isArray(f.value) && (f.value as unknown[]).includes(value);
      case 'gte': return String(value) >= String(f.value);
      case 'gt': return String(value) > String(f.value);
      case 'lte': return String(value) <= String(f.value);
      case 'lt': return String(value) < String(f.value);
      default: return true;
    }
  }));
}

/** The service client every storage and analytics module resolves through. */
export function makeFakeSupabaseClient() {
  const rows: Record<string, Json[]> = {};

  const builder = (table: string) => {
    let wantedKey: string | null = null;
    const filters: Filter[] = [];
    let orderColumn: string | null = null;
    let ascending = true;
    let limit: number | null = null;
    let rangeBounds: [number, number] | null = null;

    const resolve = () => {
      let out = applyFilters(tableRows[table] ?? [], filters);
      if (orderColumn) {
        out = [...out].sort((a, b) => {
          const left = String(a[orderColumn!]);
          const right = String(b[orderColumn!]);
          return (left < right ? -1 : left > right ? 1 : 0) * (ascending ? 1 : -1);
        });
      }
      if (rangeBounds) out = out.slice(rangeBounds[0], rangeBounds[1] + 1);
      else if (limit !== null) out = out.slice(0, limit);
      return out;
    };

    const api: Record<string, unknown> = {
      select: () => api,
      eq: (col: string, value: unknown) => {
        if (col === 'key') wantedKey = String(value);
        filters.push({ op: 'eq', column: col, value });
        return api;
      },
      in: (col: string, value: unknown) => { filters.push({ op: 'in', column: col, value }); return api; },
      gte: (col: string, value: unknown) => { filters.push({ op: 'gte', column: col, value }); return api; },
      gt: (col: string, value: unknown) => { filters.push({ op: 'gt', column: col, value }); return api; },
      lte: (col: string, value: unknown) => { filters.push({ op: 'lte', column: col, value }); return api; },
      lt: (col: string, value: unknown) => { filters.push({ op: 'lt', column: col, value }); return api; },
      order: (col: string, opts?: { ascending?: boolean }) => {
        orderColumn = col; ascending = opts?.ascending !== false; return api;
      },
      range: (from: number, to: number) => { rangeBounds = [from, to]; return api; },
      limit: (n: number) => { limit = n; return api; },
      not: () => api,
      insert: async (row: Json) => { (rows[table] ||= []).push(row); return { data: null, error: null }; },
      update: () => api,
      upsert: async (row: Json) => {
        if (table === 'app_runtime_config' && row && typeof row === 'object' && 'key' in row) {
          runtimeConfig.set(String((row as Json).key), (row as Json).value);
        }
        return { data: null, error: null };
      },
      delete: () => api,
      single: async () => (api.maybeSingle as () => Promise<unknown>)(),
      maybeSingle: async () => {
        if (table === 'app_runtime_config') {
          if (dbState.readError) return { data: null, error: dbState.readError };
          return {
            data: wantedKey && runtimeConfig.has(wantedKey)
              ? { key: wantedKey, value: runtimeConfig.get(wantedKey) }
              : null,
            error: null,
          };
        }
        return { data: resolve()[0] ?? null, error: null };
      },
      // Awaiting the builder itself runs the query — the PostgREST shape.
      then: (onFulfilled: (v: { data: Json[]; error: null }) => unknown) =>
        Promise.resolve({ data: resolve(), error: null }).then(onFulfilled),
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

        /*
          TRIPWIRES. These two SQL functions still exist in the database —
          nothing drops them — but no code may call them again. They were the
          per-flush and per-failure telemetry writes: analytics counting
          itself into PostgreSQL on every batch.

          Answering them here would let that come back silently and still go
          green, so the fake refuses instead. Any test that trips one of these
          is telling you a write path started recording again.
        */
        case 'record_analytics_storage_write':
        case 'record_analytics_storage_error':
          throw new Error(
            `analytics telemetry has returned: ${String(fn)} was called. `
            + 'Analytics must not write counters or error history to PostgreSQL.',
          );

        case 'record_analytics_day_seal': {
          // Mirrors the SQL: a seal records that a day is canonical, and
          // nothing else. A failed rebuild records NOTHING, so the next
          // cycle retries it. No attempt counter, no error string, no row
          // or object counts — the sealing pass reads back only sealed_at.
          if (args._error !== null && args._error !== undefined) {
            return { data: { ok: true, sealed: false }, error: null };
          }
          const key = `${args._workspace_id}|${args._day}`;
          const existing = (tableRows.analytics_day_seals ??= []).find(
            (row) => `${row.workspace_id}|${row.day}` === key,
          );
          if (existing) existing.sealed_at = nowIso();
          else tableRows.analytics_day_seals.push({
            workspace_id: args._workspace_id, day: args._day, sealed_at: nowIso(),
          });
          return { data: { ok: true, sealed: true }, error: null };
        }

        case 'unseal_analytics_days': {
          let unsealed = 0;
          for (const row of tableRows.analytics_day_seals ?? []) {
            if (row.workspace_id !== args._workspace_id) continue;
            if (String(row.day) < String(args._from) || String(row.day) > String(args._to)) continue;
            row.sealed_at = null;
            unsealed++;
          }
          return { data: { ok: true, unsealed }, error: null };
        }

        default:
          throw new Error(`unexpected rpc ${fn}`);
      }
    },
  };
}
