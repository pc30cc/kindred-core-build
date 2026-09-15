/**
 * Privacy job worker — single-process loop.
 *
 * Lifecycle:
 *   pending --(claim)--> running --(success)--> completed
 *                                 --(error)----> failed
 *
 * Claim is atomic-enough for self-host: an UPDATE ... WHERE status='pending'
 * AND id = (SELECT id FROM privacy_jobs WHERE status='pending'
 *           ORDER BY requested_at LIMIT 1 FOR UPDATE SKIP LOCKED).
 * We perform it as two-step (read oldest, then conditional update with a
 * status check) which is safe because there's a single worker per process
 * and operator concurrency is low. A second concurrent worker would either
 * lose the conditional update race (and skip) or pick a different row.
 *
 * Stuck-job recovery: on startup, any 'running' job older than 10 minutes
 * is marked 'failed' so it can be manually retried by re-creating a job.
 * Idempotent operations make a retry of the same scope safe.
 */

import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { resolveSubject } from './identity.js';
import { buildExportZip } from './exporter.js';
import { runAnonymize } from './anonymizer.js';
import { writePrivacyAudit } from './audit.js';
import {
  resolvePrivacyStoragePolicy,
  PrivacyStorageNotConfigured,
} from './storageResolver.js';
import { uploadWithConfigForOwner, logWorkspaceStorageUsage, type StorageOwner } from '../storage/index.js';
import { privacyExportKey } from '../storage/keys.js';
import type { PrivacyJobRow } from './types.js';

/**
 * Contact/visitor jobs always carry workspace_id (DB-enforced by the
 * caller — see server/routes/privacy.ts); a null workspace_id only ever
 * occurs for subject_type='user' jobs, whose export artifact is owned by
 * the user the job concerns (subject_id), not the actor who requested it.
 */
export function ownerForJob(job: Pick<PrivacyJobRow, 'workspace_id' | 'subject_id'>): StorageOwner {
  if (job.workspace_id) return { kind: 'workspace', workspaceId: job.workspace_id };
  return { kind: 'user', userId: job.subject_id };
}

const POLL_INTERVAL_MS = 5_000;
const STUCK_AFTER_MS = 10 * 60_000;
const ARTIFACT_TTL_MS = 7 * 24 * 60 * 60_000; // 7 days

let started = false;

async function recoverStuckJobs(config: ServerConfig) {
  const sb = getServiceClient(config);
  const cutoff = new Date(Date.now() - STUCK_AFTER_MS).toISOString();
  await sb
    .from('privacy_jobs')
    .update({ status: 'failed', error_message: 'Worker restarted while running', completed_at: new Date().toISOString() })
    .eq('status', 'running')
    .lt('started_at', cutoff);
}

async function claimNext(config: ServerConfig): Promise<PrivacyJobRow | null> {
  const sb = getServiceClient(config);
  const { data: candidate } = await sb
    .from('privacy_jobs')
    .select('*')
    .eq('status', 'pending')
    .order('requested_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!candidate) return null;

  // Conditional claim — only succeeds if still pending.
  const { data: claimed, error } = await sb
    .from('privacy_jobs')
    .update({ status: 'running', started_at: new Date().toISOString() })
    .eq('id', candidate.id)
    .eq('status', 'pending')
    .select('*')
    .maybeSingle();
  if (error || !claimed) return null;
  return claimed as PrivacyJobRow;
}

export async function processJob(config: ServerConfig, job: PrivacyJobRow): Promise<void> {
  const sb = getServiceClient(config);

  // 1. Resolve identity (canonical) and persist on the job.
  const resolved = await resolveSubject(config, job.workspace_id, job.subject_type, job.subject_id);
  await sb
    .from('privacy_jobs')
    .update({ resolved_identity: resolved as unknown as Record<string, unknown> })
    .eq('id', job.id);
  job.resolved_identity = resolved;

  if (job.action === 'export') {
    const { buffer, sha256, manifestSummary } = await buildExportZip(config, job);

    // Resolve the privacy-export-specific storage policy. Throws if no
    // provider is configured and fallback is not allowed — the catch
    // block below will mark the job failed with a clear error.
    const policy = await resolvePrivacyStoragePolicy(config, job.workspace_id);
    const owner = ownerForJob(job);
    const objectKey = privacyExportKey(owner, job.id);

    // uploadWithConfigForOwner (not the bare uploadWithConfig) — second
    // corrective pass, P0: a workspace-owned privacy export must respect
    // the SAME owner-scope enforcement and workspace-deletion write lock
    // every other workspace-owned write gets, so an export that was
    // already in flight when deletion began cannot write a new object
    // into a workspace whose storage scopes have already been swept.
    const upload = await uploadWithConfigForOwner(config, owner, policy.config, {
      fileKey: objectKey,
      data: buffer,
      contentType: 'application/zip',
    });
    if (!upload.success) {
      throw new Error(`Privacy artifact upload failed via ${policy.provider}: ${upload.error || 'unknown'}`);
    }

    // Privacy exports bypass uploadForOwner() entirely (they need the
    // dedicated privacy provider-policy resolver, not the standard
    // per-owner one), so they don't get storage_usage_logs participation
    // for free the way every other workspace-owned upload does. Log it
    // explicitly here for workspace-owned jobs only — user-subject jobs
    // (job.workspace_id null) are never attributed to any workspace's
    // quota. See server/services/storage/categoryPolicy.ts's
    // 'privacy_export' entry.
    if (job.workspace_id) {
      await logWorkspaceStorageUsage(config, {
        workspaceId: job.workspace_id,
        providerName: policy.provider,
        operation: 'upload',
        fileKey: objectKey,
        fileSize: buffer.length,
        contentType: 'application/zip',
        success: true,
      });
    }

    const expiresAt = new Date(Date.now() + ARTIFACT_TTL_MS).toISOString();
    await sb
      .from('privacy_jobs')
      .update({
        status: 'completed',
        completed_at: new Date().toISOString(),
        artifact_path: objectKey, // logical path (kept for compatibility)
        artifact_storage_provider: policy.provider,
        artifact_storage_key: objectKey,
        artifact_hash: sha256,
        artifact_size_bytes: buffer.length,
        expires_at: expiresAt,
      })
      .eq('id', job.id);
    await writePrivacyAudit(config, {
      workspaceId: job.workspace_id,
      userId: job.actor_user_id,
      action: 'privacy.export.completed',
      jobId: job.id,
      metadata: {
        sha256,
        size: buffer.length,
        counts: manifestSummary,
        storage_provider: policy.provider,
        storage_source: policy.source,
      },
    });
    return;
  }

  if (job.action === 'delete') {
    const summary = await runAnonymize(config, job);
    await sb
      .from('privacy_jobs')
      .update({ status: 'completed', completed_at: new Date().toISOString(), scope: { ...(job.scope || {}), summary } as unknown as Record<string, unknown> })
      .eq('id', job.id);
    await writePrivacyAudit(config, {
      workspaceId: job.workspace_id,
      userId: job.actor_user_id,
      action: 'privacy.delete.completed',
      jobId: job.id,
      metadata: { summary },
    });
    return;
  }

  throw new Error(`Unknown action: ${job.action}`);
}

async function tick(config: ServerConfig) {
  try {
    const job = await claimNext(config);
    if (!job) return;
    try {
      await processJob(config, job);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const sb = getServiceClient(config);
      await sb
        .from('privacy_jobs')
        .update({ status: 'failed', error_message: message.slice(0, 1000) || 'unknown error', completed_at: new Date().toISOString() })
        .eq('id', job.id);
      await writePrivacyAudit(config, {
        workspaceId: job.workspace_id,
        userId: job.actor_user_id,
        action: job.action === 'export' ? 'privacy.export.failed' : 'privacy.delete.failed',
        jobId: job.id,
        metadata: { error: message },
      });
    }
  } catch (err) {
    console.error('[privacy worker] tick error:', err);
  }
}

// Re-export so callers (routes / future periodic sweep) can detect the
// configuration error class without reaching into the resolver module.
export { PrivacyStorageNotConfigured };

export function startPrivacyWorker(config: ServerConfig) {
  if (started) return;
  started = true;
  recoverStuckJobs(config).catch((e) => console.error('[privacy worker] recovery error:', e));
  const id = setInterval(() => tick(config), POLL_INTERVAL_MS);
  id.unref?.();
  console.log('[privacy worker] started, polling every', POLL_INTERVAL_MS, 'ms');
}