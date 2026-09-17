/**
 * Partition management tests.
 *
 * These tests cover the service layer: the health derivation the worker alerts
 * on and the admin badge renders, the idempotency contract, and the guarantee
 * that nothing here can remove a partition.
 *
 * The RPC layer is mocked throughout, so the parent-table names below are
 * arbitrary fixtures — deliberately generic, since the partition service is
 * table-agnostic and no table is partitioned in this schema right now.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { ServerConfig } from '../../config.js';

const rpcMock = vi.fn();
vi.mock('../../supabase.js', () => ({
  getServiceClient: () => ({ rpc: rpcMock }),
}));

const {
  ensureFuturePartitions,
  getPartitionHealth,
  getPartitionInventory,
  previewPartitionRetention,
  validatePartitionLayout,
  FUTURE_MONTHS,
} = await import('./partitionService.js');

const config = {} as ServerConfig;

function healthRow(over: Record<string, unknown> = {}) {
  return {
    parent_table: 'example_events',
    partition_key: 'captured_at',
    partition_count: 4,
    current_partition: 'example_events_2026_11',
    next_partition: 'example_events_2026_12',
    next_partition_ready: true,
    oldest_partition: 'example_events_2026_09',
    oldest_start: '2026-09-01T00:00:00Z',
    newest_partition: 'example_events_2027_01',
    newest_end: '2027-02-01T00:00:00Z',
    total_rows: 2262,
    total_bytes: 1_000_000,
    largest_partition: 'example_events_2026_11',
    largest_bytes: 400_000,
    has_default: true,
    default_rows: 0,
    ...over,
  };
}

beforeEach(() => rpcMock.mockReset());

describe('partition health derivation', () => {
  it('reports a fully provisioned table as healthy', async () => {
    rpcMock.mockResolvedValue({ data: [healthRow()], error: null });
    const [t] = await getPartitionHealth(config);
    expect(t.health).toBe('ok');
    expect(t.issues).toEqual([]);
  });

  it('flags a missing next-month partition', async () => {
    rpcMock.mockResolvedValue({ data: [healthRow({ next_partition_ready: false })], error: null });
    const [t] = await getPartitionHealth(config);
    expect(t.issues).toContain('next_partition_missing');
    // A DEFAULT partition keeps inserts working, so this is not an outage.
    expect(t.health).toBe('attention');
  });

  it('treats a missing next-month partition with no DEFAULT as critical', async () => {
    rpcMock.mockResolvedValue({
      data: [healthRow({ next_partition_ready: false, has_default: false })],
      error: null,
    });
    const [t] = await getPartitionHealth(config);
    expect(t.health).toBe('critical');
  });

  it('treats any row in the DEFAULT partition as critical', async () => {
    rpcMock.mockResolvedValue({ data: [healthRow({ default_rows: 1 })], error: null });
    const [t] = await getPartitionHealth(config);
    expect(t.issues).toContain('rows_in_default_partition');
    expect(t.health).toBe('critical');
  });

  it('flags a table with no partitions at all', async () => {
    rpcMock.mockResolvedValue({
      data: [healthRow({ partition_count: 0, current_partition: null, next_partition_ready: false })],
      error: null,
    });
    const [t] = await getPartitionHealth(config);
    expect(t.issues).toEqual(
      expect.arrayContaining(['no_partitions', 'current_partition_missing', 'next_partition_missing']),
    );
    expect(t.health).toBe('critical');
  });

  it('surfaces the same codes through validatePartitionLayout', async () => {
    rpcMock.mockResolvedValue({ data: [healthRow({ default_rows: 3 })], error: null });
    const result = await validatePartitionLayout(config);
    expect(result.ok).toBe(false);
    expect(result.alerts).toEqual([
      { table: 'example_events', severity: 'critical', code: 'rows_in_default_partition' },
    ]);
  });

  it('reports ok with no alerts when every table is provisioned', async () => {
    rpcMock.mockResolvedValue({ data: [healthRow()], error: null });
    const result = await validatePartitionLayout(config);
    expect(result.ok).toBe(true);
    expect(result.alerts).toEqual([]);
  });
});

describe('future partition creation', () => {
  it('asks for the current month plus FUTURE_MONTHS ahead, for every managed table', async () => {
    rpcMock.mockResolvedValue({
      data: [
        { parent_table: 'example_events', partitions: ['example_events_2026_12'] },
        { parent_table: 'example_samples', partitions: [] },
      ],
      error: null,
    });
    const created = await ensureFuturePartitions(config);
    expect(rpcMock).toHaveBeenCalledWith('partition_ensure_all', { _months: FUTURE_MONTHS });
    expect(created).toHaveLength(2);
    // Idempotency contract: an already-provisioned table simply reports none.
    expect(created[1].partitions).toEqual([]);
  });

  it('can target a single table', async () => {
    rpcMock.mockResolvedValue({ data: ['example_samples_2027_01'], error: null });
    const created = await ensureFuturePartitions(config, 'example_samples');
    expect(rpcMock).toHaveBeenCalledWith('partition_ensure_future', {
      _parent: 'example_samples',
      _months: FUTURE_MONTHS,
    });
    expect(created).toEqual([
      { table: 'example_samples', partitions: ['example_samples_2027_01'] },
    ]);
  });

  it('never issues a drop or detach call', async () => {
    rpcMock.mockResolvedValue({ data: [], error: null });
    await ensureFuturePartitions(config);
    await getPartitionInventory(config);
    await previewPartitionRetention(config, 'example_samples');
    const called = rpcMock.mock.calls.map((c) => String(c[0]));
    expect(called.some((fn) => /drop|detach|truncate|delete/i.test(fn))).toBe(false);
  });
});

describe('partition retention preview', () => {
  it('is a read-only preview keyed by policy', async () => {
    rpcMock.mockResolvedValue({
      data: [{
        policy_key: 'example_samples',
        parent_table: 'example_samples',
        partition_key: 'bucket',
        cutoff: '2026-08-01T00:00:00Z',
        partition_name: 'example_samples_2026_06',
        range_start: '2026-06-01T00:00:00Z',
        range_end: '2026-07-01T00:00:00Z',
        est_rows: 8000,
        est_bytes: 500_000,
      }],
      error: null,
    });
    const candidates = await previewPartitionRetention(config, 'example_samples');
    expect(rpcMock).toHaveBeenCalledWith('retention_partition_preview', {
      _policy_key: 'example_samples',
    });
    expect(candidates[0].partition_name).toBe('example_samples_2026_06');
  });

  it('returns nothing for a protected or disabled policy (enforced in SQL)', async () => {
    rpcMock.mockResolvedValue({ data: [], error: null });
    expect(await previewPartitionRetention(config, 'billing_payments')).toEqual([]);
  });

  it('surfaces RPC failures instead of silently reporting no candidates', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: 'permission denied' } });
    await expect(previewPartitionRetention(config, 'example_samples')).rejects.toThrow(/permission denied/);
  });
});

describe('inventory', () => {
  it('narrows to one parent table when asked', async () => {
    rpcMock.mockResolvedValue({
      data: [
        { parent_table: 'example_events', partition_name: 'a', is_default: false, range_start: null, range_end: null, est_rows: 1, total_bytes: 1 },
        { parent_table: 'example_samples', partition_name: 'b', is_default: false, range_start: null, range_end: null, est_rows: 1, total_bytes: 1 },
      ],
      error: null,
    });
    const rows = await getPartitionInventory(config, 'example_samples');
    expect(rows).toHaveLength(1);
    expect(rows[0].partition_name).toBe('b');
  });
});
