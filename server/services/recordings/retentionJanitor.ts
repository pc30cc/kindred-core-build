/**
 * ============================================================
 * CALL RECORDING RETENTION JANITOR
 * ------------------------------------------------------------
 * Sole enforcement path for the `recording_retention_days` plan
 * limit. Periodically sweeps `public.call_recordings` for rows
 * whose retention has expired, hard-deletes the storage object,
 * then hard-deletes the row.
 *
 * Selection (single-query, uses idx_call_recordings_retention):
 *   WHERE legal_hold = false
 *     AND retention_expires_at IS NOT NULL
 *     AND retention_expires_at <= now()
 *
 * Recordings physically live in LiveKit's own recording_storage account
 * (server/services/calls/recordingStorageResolver.ts), resolved once per
 * sweep — never the per-workspace attachment provider `call_sessions`'s
 * join would otherwise suggest. If recording_storage isn't configured,
 * the entire sweep is skipped rather than risking a DB-row delete whose
 * bytes were never actually freed.
 *
 * Failure handling:
 *   - Storage delete failure → row is left in place; next sweep
 *     retries. Never deletes a DB row without first attempting
 *     storage delete, so an orphan storage object cannot result
 *     from a janitor crash mid-pair.
 *   - DB delete failure → logged, sweep continues with next row.
 *   - Legal hold rows are never selected, ever.
 *
 * Run cadence: best-effort, in-process. Cheap, indexed query.
 * Never throws.
 * ============================================================
 */

import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { deleteWithConfig } from '../storage/index.js';
import { resolveRecordingStorageConfig, RecordingStorageNotConfigured } from '../calls/recordingStorageResolver.js';

const RUN_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const BOOT_DELAY_MS   = 2 * 60 * 1000;  // 2 minutes after boot
const BATCH_SIZE      = 100;

interface ExpiredRow {
  id: string;
  call_session_id: string;
  storage_path: string | null;
  workspace_id: string | null;
}

async function selectExpired(config: ServerConfig): Promise<ExpiredRow[]> {
  const sb = getServiceClient(config);
  const nowIso = new Date().toISOString();
  const { data, error } = await sb
    .from('call_recordings')
    .select('id, call_session_id, storage_path, call_sessions!inner(workspace_id)')
    .eq('legal_hold', false)
    .not('retention_expires_at', 'is', null)
    .lte('retention_expires_at', nowIso)
    .order('retention_expires_at', { ascending: true })
    .limit(BATCH_SIZE);
  if (error) {
    console.warn('[recordingRetentionJanitor] select failed:', error.message);
    return [];
  }
  type SelectedRow = { id: string; call_session_id: string; storage_path: string | null; call_sessions?: { workspace_id: string } };
  return ((data || []) as unknown as SelectedRow[]).map((r) => ({
    id: r.id,
    call_session_id: r.call_session_id,
    storage_path: r.storage_path ?? null,
    workspace_id: r.call_sessions?.workspace_id ?? null,
  }));
}

export async function sweepRecordingRetention(config: ServerConfig): Promise<{
  scanned: number;
  storage_deleted: number;
  rows_deleted: number;
  failures: number;
}> {
  const rows = await selectExpired(config);
  let storageDeleted = 0;
  let rowsDeleted = 0;
  let failures = 0;
  const sb = getServiceClient(config);

  // Recordings physically live in LiveKit's own recording_storage account
  // (server/services/calls/recordingStorageResolver.ts), never the
  // workspace's ordinary attachment provider — resolved once per sweep
  // since it's a single platform-wide config, not per-workspace. If it's
  // unconfigured, no storage delete can be attempted safely for ANY row;
  // skip the whole sweep rather than risk deleting DB rows whose bytes
  // were never actually freed (the same "storage delete before row
  // delete" invariant this janitor was built to guarantee).
  let recordingStorageConfig;
  try {
    recordingStorageConfig = await resolveRecordingStorageConfig(config);
  } catch (err) {
    if (err instanceof RecordingStorageNotConfigured && rows.length) {
      console.warn('[recordingRetentionJanitor] recording storage not configured — skipping sweep of', rows.length, 'row(s)');
      return { scanned: rows.length, storage_deleted: 0, rows_deleted: 0, failures: rows.length };
    }
    return { scanned: 0, storage_deleted: 0, rows_deleted: 0, failures: 0 };
  }

  for (const row of rows) {
    // Storage delete first — best-effort but required before row delete
    // so we never produce orphan storage objects.
    let storageOk = true;
    if (row.storage_path) {
      try {
        const result = await deleteWithConfig(recordingStorageConfig, row.storage_path);
        if (result.success) {
          storageDeleted += 1;
        } else {
          // 404-style "not found" is treated as success — the object is
          // already gone, the row should be cleaned up to match.
          const msg = (result.error || '').toLowerCase();
          if (msg.includes('not found') || msg.includes('no such') || msg.includes('404')) {
            storageOk = true;
          } else {
            storageOk = false;
            failures += 1;
            console.warn('[recordingRetentionJanitor] storage delete failed:', row.id, result.error);
          }
        }
      } catch (err) {
        storageOk = false;
        failures += 1;
        console.warn('[recordingRetentionJanitor] storage delete threw:', row.id, err instanceof Error ? err.message : err);
      }
    } else {
      // Recording row never received a storage_path (e.g. egress failed
      // before writing the file). Safe to delete the DB row outright.
      storageOk = true;
    }

    if (!storageOk) continue;

    const { error: delErr } = await sb
      .from('call_recordings')
      .delete()
      .eq('id', row.id);
    if (delErr) {
      failures += 1;
      console.warn('[recordingRetentionJanitor] row delete failed:', row.id, delErr.message);
    } else {
      rowsDeleted += 1;
    }
  }

  if (rows.length) {
    console.log(
      `[recordingRetentionJanitor] swept=${rows.length} storage_deleted=${storageDeleted} rows_deleted=${rowsDeleted} failures=${failures}`,
    );
  }
  return { scanned: rows.length, storage_deleted: storageDeleted, rows_deleted: rowsDeleted, failures };
}

export function startRecordingRetentionJanitor(config: ServerConfig): void {
  setTimeout(() => { void sweepRecordingRetention(config); }, BOOT_DELAY_MS);
  setInterval(() => { void sweepRecordingRetention(config); }, RUN_INTERVAL_MS);
}