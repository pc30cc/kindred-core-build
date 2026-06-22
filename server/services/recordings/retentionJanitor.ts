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
 * Workspace ownership is resolved per row via the join to
 * `call_sessions(workspace_id)` so the workspace's storage
 * provider deletes the underlying object.
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
import { deleteFile } from '../storage/index.js';

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
  return (data || []).map((r: any) => ({
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

  for (const row of rows) {
    // Storage delete first — best-effort but required before row delete
    // so we never produce orphan storage objects.
    let storageOk = true;
    if (row.storage_path && row.workspace_id) {
      try {
        const result = await deleteFile(config, row.workspace_id, row.storage_path);
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
      } catch (err: any) {
        storageOk = false;
        failures += 1;
        console.warn('[recordingRetentionJanitor] storage delete threw:', row.id, err?.message);
      }
    } else if (!row.storage_path) {
      // Recording row never received a storage_path (e.g. egress failed
      // before writing the file). Safe to delete the DB row outright.
      storageOk = true;
    } else if (!row.workspace_id) {
      // Defensive — should not happen given the inner join.
      failures += 1;
      console.warn('[recordingRetentionJanitor] missing workspace_id for', row.id);
      continue;
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