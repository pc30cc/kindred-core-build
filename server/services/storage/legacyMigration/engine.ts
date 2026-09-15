/**
 * Legacy storage key migration engine.
 *
 * Generic copy -> verify -> DB pointer update -> read-verify -> delete-old
 * pipeline (docs/STORAGE_ARCHITECTURE_AUDIT.md's migration tooling
 * requirement), parameterized per producer by a small LegacyMigrationProvider
 * — see legacyMigration/categories.ts for the four concrete ones (email
 * attachments, privacy exports, LiveKit call recordings, account avatars).
 *
 * Design properties:
 *   - Dry-run: `dryRun: true` reports what WOULD happen and performs zero
 *     writes (no copy, no DB update, no delete).
 *   - Resumable: a provider's fetchBatch() selects only rows whose pointer
 *     still matches the legacy shape. Once a row's DB pointer is updated to
 *     the canonical key (step 3), it stops matching and is never
 *     re-selected — so migration progress IS the data itself. No separate
 *     progress-tracking table to keep in sync or get out of sync.
 *   - Idempotent: re-running against an already-migrated row set returns an
 *     empty batch (nothing left to do). Re-running against a row that
 *     failed partway (e.g. copy succeeded but the process crashed before
 *     the DB update) simply repeats the copy — uploading the same bytes to
 *     the same new key again is a harmless overwrite, not a duplicate.
 *   - Batchable: caller loops calling migrateLegacyBatch() until it returns
 *     zero results, controlling batch size and pacing.
 *   - Never rolls back the DB once step 3 commits: from that point the
 *     database is already canonical-correct, so a step-5 delete failure is
 *     logged and reported, never treated as a reason to undo the pointer
 *     update — a dangling legacy object is wasted storage, not incorrect
 *     data. The row is reported with oldDeleted: false so an operator can
 *     follow up.
 */
import type { ServerConfig } from '../../../config.js';
import { downloadWithConfig, uploadWithConfig, deleteWithConfig, type StorageConfig } from '../index.js';

export interface LegacyMigrationCandidate {
  /** Row id — used for logging and as the DB update/read-verify key. */
  id: string;
  oldKey: string;
  newKey: string;
}

export interface LegacyMigrationProvider {
  /** Human-readable category name, e.g. 'email_attachments'. Used only for reporting. */
  category: string;
  /**
   * Fetch up to `limit` rows still on a legacy key shape, ordered
   * deterministically (implementation's choice, e.g. by id) so repeated
   * calls make steady progress. Must NOT return a row already fixed by a
   * prior call in the same run (the underlying WHERE clause re-evaluates
   * the legacy predicate every call, so a migrated row simply stops
   * matching — no cursor bookkeeping required).
   */
  fetchBatch(limit: number): Promise<LegacyMigrationCandidate[]>;
  /** Resolve the StorageConfig this row's bytes live under (same account for both the old and new key — only the key path changes). */
  resolveStorageConfig(candidateId: string): Promise<StorageConfig>;
  /** Commit the row's pointer column to newKey. One atomic single-row write. */
  commitNewKey(candidateId: string, newKey: string): Promise<void>;
  /** Read the row's pointer column back from the database (not from any in-memory value) to confirm the commit really landed. */
  readBackKey(candidateId: string): Promise<string | null>;
}

export type LegacyMigrationRowStatus =
  | 'dry_run'
  | 'migrated'
  | 'skipped_no_bytes'
  | 'copy_failed'
  | 'verify_mismatch'
  | 'commit_failed'
  | 'readback_mismatch';

export interface LegacyMigrationRowResult {
  id: string;
  oldKey: string;
  newKey: string;
  status: LegacyMigrationRowStatus;
  bytes?: number;
  oldDeleted?: boolean;
  error?: string;
}

export interface MigrateLegacyBatchOptions {
  /** Report only; perform zero writes. Default false. */
  dryRun?: boolean;
  /** Max rows to process in this call. Default 25. */
  batchSize?: number;
  /** Best-effort delete of the old object once the new one is confirmed live in the DB. Default true. */
  deleteOld?: boolean;
}

export interface MigrateLegacyBatchResult {
  category: string;
  dryRun: boolean;
  results: LegacyMigrationRowResult[];
}

export async function migrateLegacyBatch(
  _serverConfig: ServerConfig,
  provider: LegacyMigrationProvider,
  opts: MigrateLegacyBatchOptions = {},
): Promise<MigrateLegacyBatchResult> {
  const batchSize = opts.batchSize ?? 25;
  const deleteOld = opts.deleteOld ?? true;
  const dryRun = !!opts.dryRun;

  const candidates = await provider.fetchBatch(batchSize);
  const results: LegacyMigrationRowResult[] = [];

  for (const candidate of candidates) {
    if (dryRun) {
      results.push({ id: candidate.id, oldKey: candidate.oldKey, newKey: candidate.newKey, status: 'dry_run' });
      continue;
    }
    results.push(await migrateOne(provider, candidate, deleteOld));
  }

  return { category: provider.category, dryRun, results };
}

async function migrateOne(
  provider: LegacyMigrationProvider,
  candidate: LegacyMigrationCandidate,
  deleteOld: boolean,
): Promise<LegacyMigrationRowResult> {
  const { id, oldKey, newKey } = candidate;
  try {
    const storageConfig = await provider.resolveStorageConfig(id);

    // 1. Copy: read the old object, write it to the new key.
    const source = await downloadWithConfig(storageConfig, oldKey);
    if (!source.success || !source.data) {
      return { id, oldKey, newKey, status: 'skipped_no_bytes', error: source.error };
    }
    const upload = await uploadWithConfig(storageConfig, {
      fileKey: newKey,
      data: source.data,
      contentType: 'application/octet-stream',
    });
    if (!upload.success) {
      return { id, oldKey, newKey, status: 'copy_failed', bytes: source.data.length, error: upload.error };
    }

    // 2. Verify: read the new object back and compare size against the source.
    const verify = await downloadWithConfig(storageConfig, newKey);
    if (!verify.success || !verify.data || verify.data.length !== source.data.length) {
      return { id, oldKey, newKey, status: 'verify_mismatch', bytes: source.data.length };
    }

    // 3. DB pointer update — the commit point. From here on the database is
    // canonical-correct regardless of what happens below.
    try {
      await provider.commitNewKey(id, newKey);
    } catch (err) {
      return {
        id, oldKey, newKey, status: 'commit_failed', bytes: source.data.length,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    // 4. Read-verify: confirm the database actually reflects the new key
    // (defends against a write that silently no-op'd, e.g. a stale WHERE
    // clause matching zero rows).
    const readBack = await provider.readBackKey(id);
    if (readBack !== newKey) {
      return { id, oldKey, newKey, status: 'readback_mismatch', bytes: source.data.length };
    }

    // 5. Best-effort delete of the old object. Never affects the result
    // status — the row is already correctly migrated at the database level.
    let oldDeleted: boolean | undefined;
    if (deleteOld) {
      const del = await deleteWithConfig(storageConfig, oldKey);
      oldDeleted = del.success;
    }

    return { id, oldKey, newKey, status: 'migrated', bytes: source.data.length, oldDeleted };
  } catch (err) {
    return { id, oldKey, newKey, status: 'copy_failed', error: err instanceof Error ? err.message : String(err) };
  }
}
