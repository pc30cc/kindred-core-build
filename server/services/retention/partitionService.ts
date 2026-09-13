/**
 * THE canonical partition-management component.
 *
 * Every CREATE TABLE ... PARTITION OF in this product happens through
 * `partition_ensure_month` / `partition_ensure_future` / `partition_ensure_all`
 * (database/migrations/176 + 177 + 179), and this service is their only
 * caller. Workers and routes call this service; they never build partition
 * DDL themselves.
 *
 * Everything here is either read-only or additive (creating future
 * partitions). There is deliberately NO detach/drop path in this phase —
 * destructive partition lifecycle is a separate, later task, and the
 * retention preview below is read-only by construction (see
 * database/migrations/181_retention_partition_integration.sql).
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { RetentionError } from './retentionService.js';

/** How many months ahead we keep ready. current + this many = never a missing partition. */
export const FUTURE_MONTHS = 2;

/** Raw shape of public.partition_health(). */
interface PartitionHealthRow {
  parent_table: string;
  partition_key: string;
  partition_count: number;
  current_partition: string | null;
  next_partition: string | null;
  next_partition_ready: boolean;
  oldest_partition: string | null;
  oldest_start: string | null;
  newest_partition: string | null;
  newest_end: string | null;
  total_rows: number;
  total_bytes: number;
  largest_partition: string | null;
  largest_bytes: number;
  has_default: boolean;
  default_rows: number;
}

export type PartitionHealthState = 'ok' | 'attention' | 'critical';

export interface PartitionHealth extends PartitionHealthRow {
  health: PartitionHealthState;
  issues: string[];
}

export interface PartitionInventoryRow {
  parent_table: string;
  partition_name: string;
  is_default: boolean;
  range_start: string | null;
  range_end: string | null;
  est_rows: number;
  total_bytes: number;
}

export interface PartitionRetentionCandidate {
  policy_key: string;
  parent_table: string;
  partition_key: string;
  cutoff: string;
  partition_name: string;
  range_start: string;
  range_end: string;
  est_rows: number;
  est_bytes: number;
}

export interface PartitionAlert {
  table: string;
  severity: 'warning' | 'critical';
  code:
    | 'next_partition_missing'
    | 'rows_in_default_partition'
    | 'no_partitions'
    | 'oversized_partition'
    | 'current_partition_missing';
}

async function rpc<T>(config: ServerConfig, fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const sb = getServiceClient(config);
  const { data, error } = await sb.rpc(fn, args);
  if (error) throw new RetentionError('partition_rpc_failed', `${fn}: ${error.message}`);
  return data as T;
}

/**
 * Per-table issue derivation. Kept in one place so the worker's alerts and
 * the admin badge can never disagree.
 */
function deriveIssues(row: PartitionHealthRow): PartitionAlert[] {
  const alerts: PartitionAlert[] = [];
  if (row.partition_count === 0) {
    alerts.push({ table: row.parent_table, severity: 'critical', code: 'no_partitions' });
  }
  if (!row.current_partition) {
    alerts.push({ table: row.parent_table, severity: 'critical', code: 'current_partition_missing' });
  }
  if (!row.next_partition_ready) {
    // Not fatal while a DEFAULT partition exists — inserts still land — but it
    // means rows are being written outside the monthly layout.
    alerts.push({
      table: row.parent_table,
      severity: row.has_default ? 'warning' : 'critical',
      code: 'next_partition_missing',
    });
  }
  if (row.default_rows > 0) {
    // Rows in DEFAULT mean a boundary was missed: the inserts survived, but
    // those rows sit outside the monthly layout and are invisible to
    // partition-level pruning.
    alerts.push({ table: row.parent_table, severity: 'critical', code: 'rows_in_default_partition' });
  }
  const avg = row.partition_count > 0 ? row.total_bytes / row.partition_count : 0;
  if (avg > 0 && row.largest_bytes > avg * 10 && row.largest_bytes > 1_000_000_000) {
    alerts.push({ table: row.parent_table, severity: 'warning', code: 'oversized_partition' });
  }
  return alerts;
}

/** Health summary for every partitioned table the platform manages. */
export async function getPartitionHealth(config: ServerConfig): Promise<PartitionHealth[]> {
  const rows = (await rpc<PartitionHealthRow[]>(config, 'partition_health')) || [];
  return rows.map((row) => {
    const alerts = deriveIssues(row);
    const health: PartitionHealthState = alerts.some((a) => a.severity === 'critical')
      ? 'critical'
      : alerts.length > 0
        ? 'attention'
        : 'ok';
    return { ...row, health, issues: alerts.map((a) => a.code) };
  });
}

/** Full per-partition listing, optionally narrowed to one parent table. */
export async function getPartitionInventory(
  config: ServerConfig,
  parentTable?: string,
): Promise<PartitionInventoryRow[]> {
  const rows = (await rpc<PartitionInventoryRow[]>(config, 'partition_inventory')) || [];
  return parentTable ? rows.filter((r) => r.parent_table === parentTable) : rows;
}

/**
 * Create any missing current/future partitions. Idempotent: an existing
 * partition is returned untouched, so this is safe to call on every tick and
 * safe to re-run after a failure.
 */
export async function ensureFuturePartitions(
  config: ServerConfig,
  parentTable?: string,
): Promise<{ table: string; partitions: string[] }[]> {
  if (parentTable) {
    const partitions = (await rpc<string[]>(config, 'partition_ensure_future', {
      _parent: parentTable,
      _months: FUTURE_MONTHS,
    })) || [];
    return [{ table: parentTable, partitions }];
  }
  const rows = (await rpc<{ parent_table: string; partitions: string[] }[]>(config, 'partition_ensure_all', {
    _months: FUTURE_MONTHS,
  })) || [];
  return rows.map((r) => ({ table: r.parent_table, partitions: r.partitions || [] }));
}

/**
 * Read-only preview of the whole months a retention policy WOULD cover.
 *
 * Returns an empty list for protected, permanent or disabled policies — the
 * SQL function enforces that independently of this layer, so neither a UI bug
 * nor a bad call here can surface a protected table as droppable. Nothing in
 * this phase consumes the result destructively.
 */
export async function previewPartitionRetention(
  config: ServerConfig,
  policyKey: string,
): Promise<PartitionRetentionCandidate[]> {
  return (await rpc<PartitionRetentionCandidate[]>(config, 'retention_partition_preview', {
    _policy_key: policyKey,
  })) || [];
}

/**
 * Layout validation, used by both the admin "Validate layout" action and the
 * worker's alerting. Anything returned in `alerts` is an operational problem.
 */
export async function validatePartitionLayout(config: ServerConfig): Promise<{
  ok: boolean;
  tables: PartitionHealth[];
  alerts: PartitionAlert[];
}> {
  const rows = (await rpc<PartitionHealthRow[]>(config, 'partition_health')) || [];
  const alerts = rows.flatMap(deriveIssues);
  const tables = await getPartitionHealth(config);
  return { ok: alerts.length === 0, tables, alerts };
}
