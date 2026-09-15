/**
 * Periodic TTL purge for expired privacy export artifacts.
 *
 * Why this exists:
 *   The download route auto-purges an artifact after the first successful
 *   download, but artifacts that are NEVER downloaded would otherwise sit
 *   in storage forever. This sweep runs in-process every SWEEP_INTERVAL_MS
 *   and deletes the underlying object via the same provider-resolved
 *   storage policy that wrote it.
 *
 * Selection criteria:
 *   privacy_jobs row where:
 *     - action = 'export'
 *     - status = 'completed'
 *     - expires_at IS NOT NULL AND expires_at < now()
 *     - artifact_path IS NOT NULL  (i.e. not already purged)
 *
 * For each row we attempt:
 *   A) New provider-based path (artifact_storage_provider + artifact_storage_key set)
 *      - Resolve current privacy storage policy for the workspace
 *      - If policy.provider matches the recorded provider, delete via deleteWithConfig
 *      - If it doesn't match, skip with a warning (operator changed providers
 *        after the job ran — manual cleanup needed; we do NOT silently delete
 *        from the wrong provider)
 *   B) Legacy local-disk path (artifact_storage_provider IS NULL)
 *      - Delete via deleteLegacyArtifact (best-effort, idempotent)
 *
 * After a successful purge attempt we NULL out artifact_path /
 * artifact_storage_key on the row and write an audit entry. The row itself
 * is preserved for audit/history — only the artifact bytes are removed.
 *
 * Failures don't crash the sweep — each row is independent. Provider
 * outages are logged so an operator can re-run later.
 */

import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { resolvePrivacyStoragePolicy, PrivacyStorageNotConfigured } from './storageResolver.js';
import { deleteWithConfig, logWorkspaceStorageUsage } from '../storage/index.js';
import { deleteLegacyArtifact, legacyArtifactExists } from './artifactStore.js';
import { writePrivacyAudit } from './audit.js';

const SWEEP_INTERVAL_MS = 60 * 60_000; // hourly
const BATCH_SIZE = 100;

let started = false;

export interface ExpiredJobRow {
  id: string;
  workspace_id: string | null;
  actor_user_id: string;
  artifact_storage_provider: string | null;
  artifact_storage_key: string | null;
  artifact_path: string | null;
  artifact_size_bytes: number | null;
  expires_at: string | null;
}

export async function purgeOne(config: ServerConfig, job: ExpiredJobRow): Promise<{ ok: boolean; reason?: string; provider?: string }> {
  // (A) Provider-based artifact
  if (job.artifact_storage_provider && job.artifact_storage_key) {
    try {
      const policy = await resolvePrivacyStoragePolicy(config, job.workspace_id);
      if (policy.provider !== job.artifact_storage_provider) {
        return {
          ok: false,
          provider: job.artifact_storage_provider,
          reason: `policy_provider_changed (current=${policy.provider}, artifact=${job.artifact_storage_provider})`,
        };
      }
      const r = await deleteWithConfig(policy.config, job.artifact_storage_key);
      if (!r.success) {
        return { ok: false, provider: policy.provider, reason: r.error || 'delete_failed' };
      }
      // Mirror worker.ts's upload-side logWorkspaceStorageUsage() call so a
      // workspace-owned export's bytes are freed from storage_bytes the
      // same way any other deleted upload is — see
      // server/services/storage/categoryPolicy.ts's 'privacy_export' entry.
      if (job.workspace_id) {
        await logWorkspaceStorageUsage(config, {
          workspaceId: job.workspace_id,
          providerName: policy.provider,
          operation: 'delete',
          fileKey: job.artifact_storage_key,
          fileSize: job.artifact_size_bytes,
          success: true,
        });
      }
      return { ok: true, provider: policy.provider };
    } catch (err) {
      if (err instanceof PrivacyStorageNotConfigured) {
        return { ok: false, provider: job.artifact_storage_provider, reason: 'policy_not_configured' };
      }
      return { ok: false, provider: job.artifact_storage_provider, reason: (err as Error)?.message || 'unknown' };
    }
  }

  // (B) Legacy on-disk artifact
  if (legacyArtifactExists(job.id)) {
    deleteLegacyArtifact(job.id);
  }
  return { ok: true, provider: 'local_legacy' };
}

async function tick(config: ServerConfig): Promise<void> {
  const sb = getServiceClient(config);
  const nowIso = new Date().toISOString();

  const { data: rows, error } = await sb
    .from('privacy_jobs')
    .select('id, workspace_id, actor_user_id, artifact_storage_provider, artifact_storage_key, artifact_path, artifact_size_bytes, expires_at')
    .eq('action', 'export')
    .eq('status', 'completed')
    .not('artifact_path', 'is', null)
    .not('expires_at', 'is', null)
    .lt('expires_at', nowIso)
    .limit(BATCH_SIZE);

  if (error) {
    console.error('[privacy expiry sweep] query error:', error.message);
    return;
  }
  if (!rows || rows.length === 0) return;

  let purged = 0;
  let skipped = 0;
  for (const row of rows as ExpiredJobRow[]) {
    const result = await purgeOne(config, row);
    if (result.ok) {
      // Clear artifact pointers but keep the row for audit history.
      await sb
        .from('privacy_jobs')
        .update({ artifact_path: null, artifact_storage_key: null, download_token_hash: null })
        .eq('id', row.id);
      await writePrivacyAudit(config, {
        workspaceId: row.workspace_id,
        userId: row.actor_user_id,
        action: 'privacy.export.expired_purged',
        jobId: row.id,
        metadata: { provider: result.provider, expires_at: row.expires_at },
      });
      purged++;
    } else {
      await writePrivacyAudit(config, {
        workspaceId: row.workspace_id,
        userId: row.actor_user_id,
        action: 'privacy.export.expired_purge_failed',
        jobId: row.id,
        metadata: { provider: result.provider, reason: result.reason, expires_at: row.expires_at },
      });
      skipped++;
    }
  }

  console.log(`[privacy expiry sweep] purged=${purged} skipped=${skipped} batch=${rows.length}`);
}

export function startPrivacyExpirySweep(config: ServerConfig): void {
  if (started) return;
  started = true;
  // Run once on boot, then on interval.
  tick(config).catch((e) => console.error('[privacy expiry sweep] initial tick error:', e));
  const id = setInterval(() => {
    tick(config).catch((e) => console.error('[privacy expiry sweep] tick error:', e));
  }, SWEEP_INTERVAL_MS);
  id.unref?.();
  console.log('[privacy expiry sweep] started, interval', SWEEP_INTERVAL_MS, 'ms');
}
