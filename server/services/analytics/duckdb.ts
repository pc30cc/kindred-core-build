/**
 * EMBEDDED DUCKDB — in this process, not a service.
 *
 * No container, no daemon, no port. `@duckdb/node-api` is an in-process
 * library; this module owns one lazily-created instance for the lifetime of
 * the backend and hands out connections for a single query at a time.
 *
 * ── Optional by design ───────────────────────────────────────────
 *
 * The package is an OPTIONAL dependency, and every entry point here reports
 * "unavailable" rather than throwing when it is absent. A deployment whose
 * platform has no prebuilt binary must still boot and serve every existing
 * report — in Phase 2 the S3 read path is shadow-only, so its absence costs
 * a comparison, never a user-facing response.
 *
 * ── Why objects are fetched, not read over httpfs ────────────────
 *
 * DuckDB can read S3 directly through its `httpfs` extension, and the
 * obvious design would hand it the bucket and credentials. That was
 * rejected for three concrete reasons:
 *
 *   1. `httpfs` is downloaded from extensions.duckdb.org on first use. That
 *      makes the first analytics query depend on outbound internet from the
 *      backend — which an air-gapped or egress-restricted self-host
 *      deployment does not have, and which fails at the worst moment.
 *   2. It would need a SECOND implementation of every provider's endpoint,
 *      region, path-style and credential handling, in DuckDB's config
 *      dialect, alongside the one in server/services/storage/index.ts —
 *      including the virtual-host-vs-path-style rule that module already
 *      gets right. Two implementations of the same thing drift.
 *   3. It covers only S3-compatible vendors. Fetching through the existing
 *      drivers covers every vendor analytics supports, `local` included,
 *      with one code path.
 *
 * What httpfs would buy is range reads: letting DuckDB pull only the row
 * groups a predicate needs. That is recovered where it actually matters —
 * partition pruning happens on the OBJECT KEY before anything is fetched
 * (see ./objectCache.ts), so a one-day query never downloads a year. What
 * remains is reading whole objects for the days actually in range, which is
 * the same order of bytes, and they are cached locally afterwards because
 * an analytics object is immutable once written.
 *
 * ── Aggregation stays in the engine ──────────────────────────────
 *
 * Callers pass SQL that aggregates. Nothing here streams rows into
 * JavaScript to be counted there — that is the ROW_CAP pattern this whole
 * read path exists to replace. Only the (small) result set crosses back.
 */

import type { ServerConfig } from '../../config.js';
import { emitLog, emitMetric } from '../observability/metrics.js';

/** Minimal surface of `@duckdb/node-api` this module uses. */
interface DuckDBConnection {
  run(sql: string): Promise<unknown>;
  runAndReadAll(sql: string): Promise<{ getRowObjects(): Record<string, unknown>[] }>;
  prepare(sql: string): Promise<DuckDBPrepared>;
  closeSync?(): void;
}

interface DuckDBPrepared {
  bindVarchar(index: number, value: string): void;
  bindInteger?(index: number, value: number): void;
  runAndReadAll(): Promise<{ getRowObjects(): Record<string, unknown>[] }>;
}

interface DuckDBInstanceLike {
  connect(): Promise<DuckDBConnection>;
}

export type DuckDBAvailability =
  | { available: true }
  | { available: false; reason: string };

let instance: DuckDBInstanceLike | null = null;
let loadFailure: string | null = null;
let loading: Promise<DuckDBInstanceLike | null> | null = null;

/** Test seam — forces the next call to re-attempt the optional import. */
export function __resetDuckDbForTests(): void {
  instance = null;
  loadFailure = null;
  loading = null;
}

/**
 * Load the optional native module once.
 *
 * A failure is remembered so a deployment without the binary does not pay
 * a failed dynamic import on every query, and is reported as a reason
 * rather than thrown.
 */
async function getInstance(): Promise<DuckDBInstanceLike | null> {
  if (instance) return instance;
  if (loadFailure) return null;
  if (loading) return loading;

  loading = (async () => {
    try {
      // Assembled so a bundler cannot statically resolve an optional
      // dependency that may legitimately be absent.
      const moduleName = ['@duckdb', 'node-api'].join('/');
      const mod = (await import(/* @vite-ignore */ moduleName)) as {
        DuckDBInstance: { create(path: string): Promise<DuckDBInstanceLike> };
      };
      // In-memory: the lake is the storage, this is only the engine.
      instance = await mod.DuckDBInstance.create(':memory:');
      return instance;
    } catch (err: unknown) {
      loadFailure = err instanceof Error ? err.message : String(err);
      return null;
    } finally {
      loading = null;
    }
  })();

  return loading;
}

export async function duckDbAvailability(): Promise<DuckDBAvailability> {
  const loaded = await getInstance();
  if (loaded) return { available: true };
  return {
    available: false,
    reason: loadFailure ?? 'the optional @duckdb/node-api package is not installed',
  };
}

export class DuckDbUnavailableError extends Error {
  constructor(reason: string) {
    super(`analytics_query_engine_unavailable: ${reason}`);
    this.name = 'DuckDbUnavailableError';
  }
}

export interface QueryOptions {
  /** Bound as `$1`, `$2`, … — never interpolated into the SQL text. */
  params?: string[];
  /** For the metric tag, so slow reports are attributable. */
  label?: string;
}

/**
 * Run one aggregating query and return its (small) result rows.
 *
 * Parameters are BOUND, never concatenated. Every value that reaches this
 * layer from a request — a workspace id above all — travels as a bound
 * parameter, so no request input is ever parsed as SQL.
 */
export async function queryAnalytics<T = Record<string, unknown>>(
  config: ServerConfig,
  sql: string,
  opts?: QueryOptions,
): Promise<T[]> {
  const engine = await getInstance();
  if (!engine) throw new DuckDbUnavailableError(loadFailure ?? 'not installed');

  const started = Date.now();
  let connection: DuckDBConnection | null = null;
  try {
    connection = await engine.connect();

    let rows: Record<string, unknown>[];
    if (opts?.params && opts.params.length > 0) {
      const prepared = await connection.prepare(sql);
      opts.params.forEach((value, index) => prepared.bindVarchar(index + 1, value));
      rows = (await prepared.runAndReadAll()).getRowObjects();
    } else {
      rows = (await connection.runAndReadAll(sql)).getRowObjects();
    }

    const durationMs = Date.now() - started;
    health.queries++;
    health.lastQueryAt = new Date().toISOString();
    health.lastDurationMs = durationMs;
    emitMetric(config, {
      metric: 'analytics_s3_query_duration',
      tags: { ms: durationMs, report: opts?.label ?? 'unknown' },
    });
    return rows as T[];
  } catch (err: unknown) {
    health.failures++;
    health.lastError = err instanceof Error ? err.message : String(err);
    health.lastErrorAt = new Date().toISOString();
    emitMetric(config, {
      metric: 'analytics_s3_query_failures',
      tags: { report: opts?.label ?? 'unknown' },
    });
    emitLog(config, 'warn', 'analytics_query_failed', {
      report: opts?.label ?? 'unknown',
      error: err instanceof Error ? err.message : 'unknown',
    });
    throw err;
  } finally {
    try { connection?.closeSync?.(); } catch { /* connection teardown is best-effort */ }
  }
}

/**
 * DuckDB returns BIGINT as a JS bigint and DECIMAL as an object. Reports
 * deal in plain numbers, so every scalar crossing back is normalized here
 * rather than at each of ~20 call sites.
 */
// ─── Query health, for the admin panel ───────────────────────────
//
// In-process and deliberately so: this is a diagnostic about the node that
// answered, not a platform-wide fact, and persisting it would mean a
// database write per report query.

interface QueryHealth {
  lastQueryAt: string | null;
  lastDurationMs: number | null;
  lastError: string | null;
  lastErrorAt: string | null;
  queries: number;
  failures: number;
}

const health: QueryHealth = {
  lastQueryAt: null, lastDurationMs: null, lastError: null, lastErrorAt: null, queries: 0, failures: 0,
};

export function queryHealth(): QueryHealth {
  return { ...health };
}

export function __resetQueryHealthForTests(): void {
  Object.assign(health, {
    lastQueryAt: null, lastDurationMs: null, lastError: null, lastErrorAt: null, queries: 0, failures: 0,
  });
}

export function num(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'bigint') return Number(value);
  if (value === null || value === undefined) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function str(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return String(value);
}
