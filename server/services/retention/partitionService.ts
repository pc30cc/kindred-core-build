/**
 * THE canonical partition-management component.
 *
 * Every CREATE TABLE ... PARTITION OF in this product happens through
 * `partition_ensure_month` / `partition_ensure_future`, which this service is
 * the only caller of. Workers and routes call this service; they never build
 * partition DDL themselves.
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

export interface PartitionHealth {
  parent_table: string;
  partition_key: string;
  partition_count: number;
  current_partition: string | null;
  next_partition: string | null;
  next_partition_ready: boolean;
  oldest_partition: string | null;
  newest_partition: string | null;
  oldest_start: string | null;
  newest_end: string | null;
  est_rows: number;
  total_bytes: number;
  largest_partition: string | null;
  largest_bytes: number;
  default_partition: string | null;
  default_rows: number;
  /** ok | attention | critical — derived in SQL, mirrored by the UI badge. */
  health: string;
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
  index_bytes: number;
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

async function rpc<T>(config: ServerConfig, fn: string, args: Record<string, unknown> = {}): Promise<T[]> {
  const sb = getServiceClient(config);
  const { data, error } = await sb.rpc(fn, args);
  if (error) throw new RetentionError('partition_rpc_failed', `${fn}: ${error.message}`);
  return (data || []) as T[];
}

/** Health summary for every partitioned table the platform manages. */
export function getPartitionHealth(config: ServerConfig): Promise<PartitionHealth[]> {
  return rpc<PartitionHealth>(config, 'partition_health');
}

/** Full per-partition listing, optionally narrowed to one parent table. */
export function getPartitionInventory(config: ServerConfig, parentTable?: string): Promise<PartitionInventoryRow[]> {
  return rpc<PartitionInventoryRow>(config, 'partition_inventory', parentTable ? { _parent: parentTable } : {});
}

/**
 * Create any missing current/future partitions. Idempotent: an existing
 * partition is returned untouched, so this is safe to call every tick.
 */
export async function ensureFuturePartitions(
  config: ServerConfig,
  parentTable?: string,
): Promise<{ table: string; partitions: string[] }[]> {
  if (parentTable) {
    const rows = await rpc<{ partition_name: string }>(config, 'partition_ensure_future', {
      _parent: parentTable,
      _months: FUTURE_MONTHS,
    });
    return [{ table: parentTable, partitions: rows.map((r) => r.partition_name) }];
  }
  const rows = await rpc<{ parent_table: string; partition_name: string }>(config, 'partition_ensure_all', {
    _months: FUTURE_MONTHS,
  });
  const byTable = new Map<string, string[]>();
  for (const r of rows) {
    const list = byTable.get(r.parent_table) || [];
    list.push(r.partition_name);
    byTable.set(r.parent_table, list);
  }
  return [...byTable.entries()].map(([table, partitions]) => ({ table, partitions }));
}

/**
 * Read-only preview of the whole months a retention policy WOULD cover.
 *
 * Returns an empty list for protected, permanent or disabled policies — the
 * SQL function enforces that independently of this layer, so a UI bug can
 * never surface a protected table as droppable.
 */
export function previewPartitionRetention(
  config: ServerConfig,
  policyKey: string,
): Promise<PartitionRetentionCandidate[]> {
  return rpc<PartitionRetentionCandidate>(config, 'retention_partition_preview', { _policy_key: policyKey });
}

/**
 * Layout validation, used by both the admin "Validate layout" action and the
 * worker's alerting. Anything returned here is an operational problem.
 */
export async function validatePartitionLayout(config: ServerConfig): Promise<{
  ok: boolean;
  tables: PartitionHealth[];
  alerts: { table: string; severity: 'warning' | 'critical'; code: string }[];
}> {
  const tables = await getPartitionHealth(config);
  const alerts: { table: string; severity: 'warning' | 'critical'; code: string }[] = [];
  for (const t of tables) {
    if (!t.next_partition_ready) {
      alerts.push({ table: t.parent_table, severity: 'critical', code: 'next_partition_missing' });
    }
    if (t.default_rows > 0) {
      // Rows in DEFAULT mean a boundary was missed: inserts survived, but the
      // rows are outside the monthly layout and invisible to pruning.
      alerts.push({ table: t.parent_table, severity: 'critical', code: 'rows_in_default_partition' });
    }
    if (t.partition_count === 0) {
      alerts.push({ table: t.parent_table, severity: 'critical', code: 'no_partitions' });
    }
    // A month more than 10x the table average is worth a look before it
    // becomes an unqueryable partition.
    const avg = t.partition_count > 0 ? t.total_bytes / t.partition_count : 0;
    if (avg > 0 && t.largest_bytes > avg * 10 && t.largest_bytes > 1_000_000_000) {
      alerts.push({ table: t.parent_table, severity: 'warning', code: 'oversized_partition' });
    }
  }
  return { ok: alerts.length === 0, tables, alerts };
}
