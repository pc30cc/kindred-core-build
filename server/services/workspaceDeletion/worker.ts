/**
 * Workspace deletion worker — single-process poll loop, same shape as
 * server/services/privacy/worker.ts.
 *
 * Lifecycle (docs/STORAGE_ARCHITECTURE_AUDIT.md's ACTIVE -> DELETING ->
 * storage cleanup -> DB cleanup -> DELETED requirement):
 *   pending --(claim)--> storage_cleanup --(all objects gone)--> db_cleanup
 *           --(admin_purge_workspaces succeeds)--> completed
 *                                                --(any step throws)--> failed
 *
 * storage_cleanup is safely resumable: listForOwner()/deleteForOwner() are
 * idempotent (deleting an already-gone key just no-ops), and the job row's
 * storage_cursor persists provider pagination progress across restarts. A
 * worker that crashes mid-run simply re-claims the same row on the next
 * poll and continues — no separate crash-recovery pass needed for this
 * phase, unlike privacy/worker.ts's STUCK_AFTER_MS sweep.
 *
 * db_cleanup calls the EXISTING admin_delete_workspace RPC — this worker
 * does not reimplement or duplicate its purge logic, only sequences a
 * storage cleanup before it. That RPC is hosted-only today (no self-host
 * CREATE FUNCTION exists yet — a pre-existing gap, see the migration
 * comment in 180_workspace_deletion_lifecycle.sql); on self-host this step
 * fails with a clear "function does not exist" error and the job is
 * marked failed, exactly as workspace deletion already fails on self-host
 * today.
 *
 * If the RPC call itself errors but the workspace row is already gone
 * (checked explicitly), that's treated as a successful, idempotent resume
 * of a run that crashed between the RPC committing and this worker
 * recording the result — never as a failure.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { listForOwner, deleteForOwner } from '../storage/index.js';
import type { WorkspaceDeletionJobRow } from './types.js';

const POLL_INTERVAL_MS = 5_000;
const MAX_DELETE_ATTEMPTS_PER_KEY = 3;

let started = false;

async function claimNext(config: ServerConfig): Promise<WorkspaceDeletionJobRow | null> {
  const sb = getServiceClient(config);
  const { data: candidate } = await sb
    .from('workspace_deletion_jobs')
    .select('*')
    .in('status', ['pending', 'storage_cleanup', 'db_cleanup'])
    .order('requested_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!candidate) return null;

  const row = candidate as WorkspaceDeletionJobRow;
  if (row.status === 'pending') {
    const { data: claimed, error } = await sb
      .from('workspace_deletion_jobs')
      .update({ status: 'storage_cleanup', started_at: new Date().toISOString() })
      .eq('id', row.id)
      .eq('status', 'pending')
      .select('*')
      .maybeSingle();
    if (error || !claimed) return null; // another worker claimed it first
    return claimed as WorkspaceDeletionJobRow;
  }
  // Already in flight (storage_cleanup / db_cleanup) — a prior run crashed
  // partway through. Resume it as-is; no separate claim needed since a
  // single-process worker has nothing else competing for it.
  return row;
}

/**
 * Processes exactly ONE provider listing page per call — deliberately not
 * a loop draining every page in one invocation. A workspace with many
 * thousands of objects would otherwise tie up a single poll tick for a
 * long time with no observable progress and no opportunity to yield; one
 * page per tick keeps each step small, its progress visible on the job
 * row (storage_cursor/storage_objects_deleted) after every call, and
 * resumable the same way whether the process crashes or simply hasn't
 * gotten to the next page yet. The outer tick() loop re-invokes this on
 * the next POLL_INTERVAL_MS until nextCursor comes back null, at which
 * point this function itself advances the job to 'db_cleanup'.
 */
async function runStorageCleanup(config: ServerConfig, job: WorkspaceDeletionJobRow): Promise<void> {
  const sb = getServiceClient(config);
  const owner = { kind: 'workspace' as const, workspaceId: job.workspace_id };

  const listing = await listForOwner(config, owner, undefined, job.storage_cursor ?? undefined);
  if (!listing.success) {
    await sb
      .from('workspace_deletion_jobs')
      .update({ status: 'failed', storage_cleanup_error: listing.error ?? 'list_failed', error_message: `storage listing failed: ${listing.error ?? 'unknown'}` })
      .eq('id', job.id);
    return;
  }

  let deleted = job.storage_objects_deleted;
  for (const key of listing.keys ?? []) {
    let lastError: string | undefined;
    let ok = false;
    for (let attempt = 1; attempt <= MAX_DELETE_ATTEMPTS_PER_KEY && !ok; attempt++) {
      const result = await deleteForOwner(config, owner, key);
      ok = result.success;
      lastError = result.error;
    }
    if (!ok) {
      await sb
        .from('workspace_deletion_jobs')
        .update({ status: 'failed', storage_cleanup_error: `failed to delete ${key}: ${lastError ?? 'unknown'}`, storage_objects_deleted: deleted })
        .eq('id', job.id);
      return;
    }
    deleted++;
  }

  const nextCursor = listing.nextCursor ?? null;
  await sb
    .from('workspace_deletion_jobs')
    .update({
      status: nextCursor ? 'storage_cleanup' : 'db_cleanup',
      storage_objects_found: (job.storage_objects_found ?? 0) + (listing.keys?.length ?? 0),
      storage_objects_deleted: deleted,
      storage_cursor: nextCursor,
    })
    .eq('id', job.id);
}

async function workspaceStillExists(config: ServerConfig, workspaceId: string): Promise<boolean> {
  const sb = getServiceClient(config);
  const { data } = await sb.from('workspaces').select('id').eq('id', workspaceId).maybeSingle();
  return !!data;
}

async function runDbCleanup(config: ServerConfig, job: WorkspaceDeletionJobRow): Promise<void> {
  const sb = getServiceClient(config);
  const { error } = await sb.rpc('admin_delete_workspace', {
    _actor_user_id: job.requested_by,
    _workspace_id: job.workspace_id,
  });

  if (error) {
    // A crashed prior run may have already committed the purge before
    // recording the result — re-check reality instead of trusting the
    // RPC's second, redundant call to fail loudly.
    const stillExists = await workspaceStillExists(config, job.workspace_id);
    if (stillExists) {
      await sb
        .from('workspace_deletion_jobs')
        .update({ status: 'failed', error_message: `db cleanup failed: ${error.message}` })
        .eq('id', job.id);
      return;
    }
  }

  const now = new Date().toISOString();
  await sb
    .from('workspace_deletion_jobs')
    .update({ status: 'completed', db_cleanup_completed_at: now, completed_at: now })
    .eq('id', job.id);
}

async function tick(config: ServerConfig): Promise<void> {
  const job = await claimNext(config);
  if (!job) return;

  if (job.status === 'storage_cleanup') {
    await runStorageCleanup(config, job);
    return; // re-claimed next tick to pick up db_cleanup, keeps each tick single-purpose and observable
  }
  if (job.status === 'db_cleanup') {
    await runDbCleanup(config, job);
  }
}

export function startWorkspaceDeletionWorker(config: ServerConfig): void {
  if (started) return;
  started = true;
  tick(config).catch((e) => console.error('[workspace deletion] initial tick error:', e));
  const id = setInterval(() => {
    tick(config).catch((e) => console.error('[workspace deletion] tick error:', e));
  }, POLL_INTERVAL_MS);
  id.unref?.();
  console.log('[workspace deletion] worker started, interval', POLL_INTERVAL_MS, 'ms');
}

export { claimNext, runStorageCleanup, runDbCleanup };
