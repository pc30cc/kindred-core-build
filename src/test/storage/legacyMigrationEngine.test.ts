/**
 * Legacy storage migration engine — server/services/storage/legacyMigration/engine.ts.
 *
 * Proves the copy -> verify -> DB update -> read-verify -> delete-old
 * pipeline docs/STORAGE_ARCHITECTURE_AUDIT.md's migration tooling
 * requirement describes, plus its dry-run/resumable/idempotent properties.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { migrateLegacyBatch, type LegacyMigrationProvider, type LegacyMigrationCandidate } from '../../../server/services/storage/legacyMigration/engine';

const { downloadWithConfigMock, uploadWithConfigMock, deleteWithConfigMock } = vi.hoisted(() => ({
  downloadWithConfigMock: vi.fn(),
  uploadWithConfigMock: vi.fn(),
  deleteWithConfigMock: vi.fn(),
}));

vi.mock('../../../server/services/storage/index.js', () => ({
  downloadWithConfig: downloadWithConfigMock,
  uploadWithConfig: uploadWithConfigMock,
  deleteWithConfig: deleteWithConfigMock,
}));

const STORAGE_CONFIG = { provider: 'local', localPath: '/tmp/storage' };
const BYTES = Buffer.from('legacy-object-bytes');

/** A fake provider backed by an in-memory row map, so "resumability" can be proven by calling fetchBatch twice against the SAME store. */
function makeFakeProvider(rows: Map<string, string>): LegacyMigrationProvider & { commits: Array<{ id: string; newKey: string }> } {
  const commits: Array<{ id: string; newKey: string }> = [];
  return {
    category: 'fake',
    commits,
    async fetchBatch(limit) {
      const candidates: LegacyMigrationCandidate[] = [];
      for (const [id, key] of rows) {
        if (!key.startsWith('legacy/')) continue; // already migrated rows no longer match
        candidates.push({ id, oldKey: key, newKey: key.replace('legacy/', 'canonical/') });
        if (candidates.length >= limit) break;
      }
      return candidates;
    },
    async resolveStorageConfig() {
      return STORAGE_CONFIG;
    },
    async commitNewKey(id, newKey) {
      rows.set(id, newKey);
      commits.push({ id, newKey });
    },
    async readBackKey(id) {
      return rows.get(id) ?? null;
    },
  };
}

beforeEach(() => {
  downloadWithConfigMock.mockReset();
  uploadWithConfigMock.mockReset();
  deleteWithConfigMock.mockReset();
  downloadWithConfigMock.mockResolvedValue({ success: true, data: BYTES });
  uploadWithConfigMock.mockResolvedValue({ success: true });
  deleteWithConfigMock.mockResolvedValue({ success: true });
});

describe('migrateLegacyBatch — dry run', () => {
  it('reports candidates without performing any copy/upload/delete/commit', async () => {
    const rows = new Map([['row-1', 'legacy/a'], ['row-2', 'legacy/b']]);
    const provider = makeFakeProvider(rows);

    const result = await migrateLegacyBatch({} as never, provider, { dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.results).toEqual([
      { id: 'row-1', oldKey: 'legacy/a', newKey: 'canonical/a', status: 'dry_run' },
      { id: 'row-2', oldKey: 'legacy/b', newKey: 'canonical/b', status: 'dry_run' },
    ]);
    expect(downloadWithConfigMock).not.toHaveBeenCalled();
    expect(uploadWithConfigMock).not.toHaveBeenCalled();
    expect(deleteWithConfigMock).not.toHaveBeenCalled();
    expect(provider.commits).toHaveLength(0);
    // Rows are untouched — still on the legacy shape.
    expect(rows.get('row-1')).toBe('legacy/a');
  });
});

describe('migrateLegacyBatch — happy path', () => {
  it('runs copy -> verify -> commit -> read-verify -> delete-old in order and reports migrated', async () => {
    const rows = new Map([['row-1', 'legacy/a']]);
    const provider = makeFakeProvider(rows);

    const result = await migrateLegacyBatch({} as never, provider);

    expect(result.results).toEqual([
      { id: 'row-1', oldKey: 'legacy/a', newKey: 'canonical/a', status: 'migrated', bytes: BYTES.length, oldDeleted: true },
    ]);
    expect(downloadWithConfigMock).toHaveBeenNthCalledWith(1, STORAGE_CONFIG, 'legacy/a');
    expect(uploadWithConfigMock).toHaveBeenCalledWith(STORAGE_CONFIG, { fileKey: 'canonical/a', data: BYTES, contentType: 'application/octet-stream' });
    expect(downloadWithConfigMock).toHaveBeenNthCalledWith(2, STORAGE_CONFIG, 'canonical/a');
    expect(deleteWithConfigMock).toHaveBeenCalledWith(STORAGE_CONFIG, 'legacy/a');
    expect(provider.commits).toEqual([{ id: 'row-1', newKey: 'canonical/a' }]);
    // The row now shows the canonical key — idempotent/resumable via the data itself.
    expect(rows.get('row-1')).toBe('canonical/a');
  });

  it('is idempotent: a second call against the same store returns nothing (nothing left on the legacy shape)', async () => {
    const rows = new Map([['row-1', 'legacy/a']]);
    const provider = makeFakeProvider(rows);

    await migrateLegacyBatch({} as never, provider);
    uploadWithConfigMock.mockClear();
    const second = await migrateLegacyBatch({} as never, provider);

    expect(second.results).toEqual([]);
    expect(uploadWithConfigMock).not.toHaveBeenCalled();
  });

  it('is resumable across separate calls: a mixed legacy/already-migrated store only processes the legacy rows', async () => {
    const rows = new Map([
      ['row-1', 'canonical/already-done'],
      ['row-2', 'legacy/still-pending'],
    ]);
    const provider = makeFakeProvider(rows);

    const result = await migrateLegacyBatch({} as never, provider);

    expect(result.results.map((r) => r.id)).toEqual(['row-2']);
  });

  it('respects batchSize', async () => {
    const rows = new Map([['row-1', 'legacy/a'], ['row-2', 'legacy/b'], ['row-3', 'legacy/c']]);
    const provider = makeFakeProvider(rows);

    const result = await migrateLegacyBatch({} as never, provider, { batchSize: 2 });

    expect(result.results).toHaveLength(2);
  });
});

describe('migrateLegacyBatch — failure handling', () => {
  it('skipped_no_bytes when the old object cannot be read, and never calls upload/commit', async () => {
    downloadWithConfigMock.mockResolvedValueOnce({ success: false, error: 'not_found' });
    const rows = new Map([['row-1', 'legacy/a']]);
    const provider = makeFakeProvider(rows);

    const result = await migrateLegacyBatch({} as never, provider);

    expect(result.results[0].status).toBe('skipped_no_bytes');
    expect(uploadWithConfigMock).not.toHaveBeenCalled();
    expect(provider.commits).toHaveLength(0);
    expect(rows.get('row-1')).toBe('legacy/a'); // untouched, will be retried next run
  });

  it('copy_failed when the upload to the new key fails, and never commits', async () => {
    uploadWithConfigMock.mockResolvedValueOnce({ success: false, error: 'upload_error' });
    const rows = new Map([['row-1', 'legacy/a']]);
    const provider = makeFakeProvider(rows);

    const result = await migrateLegacyBatch({} as never, provider);

    expect(result.results[0].status).toBe('copy_failed');
    expect(provider.commits).toHaveLength(0);
    expect(rows.get('row-1')).toBe('legacy/a');
  });

  it('verify_mismatch when the read-back object size does not match the source, and never commits', async () => {
    downloadWithConfigMock
      .mockResolvedValueOnce({ success: true, data: BYTES }) // source read
      .mockResolvedValueOnce({ success: true, data: Buffer.from('short') }); // verify read — wrong size
    const rows = new Map([['row-1', 'legacy/a']]);
    const provider = makeFakeProvider(rows);

    const result = await migrateLegacyBatch({} as never, provider);

    expect(result.results[0].status).toBe('verify_mismatch');
    expect(provider.commits).toHaveLength(0);
    expect(deleteWithConfigMock).not.toHaveBeenCalled();
  });

  it('commit_failed when the DB update throws, and never deletes the old object', async () => {
    const rows = new Map([['row-1', 'legacy/a']]);
    const provider = makeFakeProvider(rows);
    provider.commitNewKey = vi.fn(async () => {
      throw new Error('db_write_failed');
    });

    const result = await migrateLegacyBatch({} as never, provider);

    expect(result.results[0]).toMatchObject({ status: 'commit_failed', error: 'db_write_failed' });
    expect(deleteWithConfigMock).not.toHaveBeenCalled();
  });

  it('readback_mismatch when the committed key does not match what readBackKey reports, and never deletes the old object', async () => {
    const rows = new Map([['row-1', 'legacy/a']]);
    const provider = makeFakeProvider(rows);
    provider.readBackKey = vi.fn(async () => 'something-else');

    const result = await migrateLegacyBatch({} as never, provider);

    expect(result.results[0].status).toBe('readback_mismatch');
    expect(deleteWithConfigMock).not.toHaveBeenCalled();
  });

  it('a failed old-object delete is reported but the row still counts as migrated — the DB is already canonical', async () => {
    deleteWithConfigMock.mockResolvedValueOnce({ success: false, error: 'delete_denied' });
    const rows = new Map([['row-1', 'legacy/a']]);
    const provider = makeFakeProvider(rows);

    const result = await migrateLegacyBatch({} as never, provider);

    expect(result.results[0]).toMatchObject({ status: 'migrated', oldDeleted: false });
    expect(rows.get('row-1')).toBe('canonical/a');
  });

  it('deleteOld: false skips the delete step entirely', async () => {
    const rows = new Map([['row-1', 'legacy/a']]);
    const provider = makeFakeProvider(rows);

    const result = await migrateLegacyBatch({} as never, provider, { deleteOld: false });

    expect(result.results[0]).toMatchObject({ status: 'migrated', oldDeleted: undefined });
    expect(deleteWithConfigMock).not.toHaveBeenCalled();
  });
});
