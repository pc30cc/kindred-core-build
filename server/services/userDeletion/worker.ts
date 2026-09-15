/**
 * User (account) deletion worker — routes owned workspaces through the
 * SAME storage-aware, multi-provider workspace deletion machinery
 * (server/services/workspaceDeletion/worker.ts) instead of the old
 * ad-hoc, capped, best-effort storage sweep. See database/migrations/
 * 183_user_deletion_lifecycle.sql for the full rationale.
 *
 * Lifecycle:
 *   collecting_workspaces --(enqueue one workspace_deletion_jobs row per
 *     owned workspace, via the same enqueue_workspace_deletion RPC the
 *     admin workspace-delete route uses)--> awaiting_workspace_deletions
 *   awaiting_workspace_deletions --(every owned workspace is gone from
 *     public.workspaces, i.e. its own deletion job reached db_cleanup and
 *     completed — checked directly against workspaces, never inferred
 *     from job status alone, so a job whose row was itself pruned still
 *     counts as done)--> purging_user
 *   purging_user --(delete the user's own GLOBAL users/<id>/ storage,
 *     e.g. the account avatar, then call the existing admin_delete_user
 *     RPC for the final per-user-column sweep + profile delete — by this
 *     point zero workspaces remain owned by the user, so
 *     admin_delete_user's internal admin_purge_workspaces call is a
 *     guaranteed no-op, never a second attempt at work already done)
 *     --> completed
 *                                                                --> failed (retries exhausted)
 *
 * The DB ownership row (profiles) is never touched until every owned
 * workspace's storage AND DB cleanup has completed — enforced structurally
 * by the state machine order above, not by a best-effort ordering guess.
 *
 * Claiming, retry/backoff and multi-worker safety mirror 181's workspace
 * deletion job design exactly (claim_user_deletion_job: FOR UPDATE SKIP
 * LOCKED + lease; automatic bounded retry; retry_user_deletion_job for a
 * terminally failed job) — see workspaceDeletion/worker.ts's doc comment
 * for the rationale, unchanged here.
 */
import { randomUUID } from 'node:crypto';
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { listForOwner, deleteForOwner } from '../storage/index.js';
import type { UserDeletionJobRow } from './types.js';

const POLL_INTERVAL_MS = 5_000;
const LEASE_SECONDS = 60;
const MAX_DELETE_ATTEMPTS_PER_KEY = 3;
const MAX_JOB_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 30 * 60_000;

const WORKER_ID = `userdel-${randomUUID()}`;

let started = false;

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function claimNext(config: ServerConfig): Promise<UserDeletionJobRow | null> {
  const sb = getServiceClient(config);
  const { data, error } = await sb.rpc('claim_user_deletion_job', {
    _worker_id: WORKER_ID,
    _lease_seconds: LEASE_SECONDS,
  });
  if (error || !data?.ok) return null;
  return (data.job as UserDeletionJobRow | null) ?? null;
}

async function releaseLease(config: ServerConfig, jobId: string, extra: Record<string, unknown> = {}): Promise<void> {
  const sb = getServiceClient(config);
  await sb.from('user_deletion_jobs').update({ locked_by: null, lease_expires_at: null, ...extra }).eq('id', jobId);
}

async function retryOrFail(config: ServerConfig, job: UserDeletionJobRow, errorMessage: string): Promise<void> {
  const nextAttempt = job.attempt_count + 1;
  if (nextAttempt >= MAX_JOB_ATTEMPTS) {
    await releaseLease(config, job.id, { status: 'failed', attempt_count: nextAttempt, error_message: errorMessage });
    return;
  }
  const backoffMs = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** nextAttempt);
  await releaseLease(config, job.id, {
    attempt_count: nextAttempt,
    error_message: errorMessage,
    next_retry_at: new Date(Date.now() + backoffMs).toISOString(),
  });
}

async function collectWorkspaces(config: ServerConfig, job: UserDeletionJobRow): Promise<void> {
  const sb = getServiceClient(config);
  const { data: owned, error } = await sb.from('workspaces').select('id').eq('owner_id', job.user_id);
  if (error) {
    await retryOrFail(config, job, `failed to list owned workspaces: ${error.message}`);
    return;
  }
  const workspaceIds = (owned ?? []).map((w) => w.id as string);

  for (const workspaceId of workspaceIds) {
    const { error: enqueueError } = await sb.rpc('enqueue_workspace_deletion', {
      _workspace_id: workspaceId,
      _actor_user_id: job.requested_by,
    });
    // A workspace already 'deleting' (e.g. an admin deleted it directly)
    // is not a failure here — enqueue_workspace_deletion returns
    // started:false and reuses the existing job in that case; an RPC-level
    // error is the only thing worth retrying on.
    if (enqueueError) {
      await retryOrFail(config, job, `failed to enqueue deletion for workspace ${workspaceId}: ${enqueueError.message}`);
      return;
    }
  }

  await releaseLease(config, job.id, { status: 'awaiting_workspace_deletions', workspace_ids: workspaceIds });
}

async function checkWorkspaceDeletionsComplete(config: ServerConfig, job: UserDeletionJobRow): Promise<void> {
  if (job.workspace_ids.length === 0) {
    await releaseLease(config, job.id, { status: 'purging_user' });
    return;
  }

  const sb = getServiceClient(config);
  const { data: remaining, error } = await sb.from('workspaces').select('id').in('id', job.workspace_ids);
  if (error) {
    await retryOrFail(config, job, `failed to check workspace deletion progress: ${error.message}`);
    return;
  }
  if ((remaining ?? []).length > 0) {
    // Still in flight — not a failure, just not ready yet. Release the
    // lease without bumping attempt_count so this never counts toward
    // MAX_JOB_ATTEMPTS; the next poll (by any worker) re-checks.
    await releaseLease(config, job.id);
    return;
  }

  // Every owned workspace is gone from `workspaces` — but a job that
  // exhausted ITS OWN retries and is terminally 'failed' also removes the
  // workspace row only on success, so if the row is gone the job that
  // deleted it necessarily reached 'completed'. Nothing further to verify.
  await releaseLease(config, job.id, { status: 'purging_user' });
}

async function purgeUser(config: ServerConfig, job: UserDeletionJobRow): Promise<void> {
  const sb = getServiceClient(config);

  if (!job.avatar_cleanup_done) {
    const listing = await listForOwner(config, { kind: 'user', userId: job.user_id });
    if (!listing.success) {
      await retryOrFail(config, job, `failed to list global user storage: ${listing.error ?? 'unknown'}`);
      return;
    }
    for (const key of listing.keys ?? []) {
      let ok = false;
      let lastError: string | undefined;
      for (let attempt = 1; attempt <= MAX_DELETE_ATTEMPTS_PER_KEY && !ok; attempt++) {
        const del = await deleteForOwner(config, { kind: 'user', userId: job.user_id }, key);
        ok = del.success;
        lastError = del.error;
      }
      if (!ok) {
        await retryOrFail(config, job, `failed to delete global user object ${key}: ${lastError ?? 'unknown'}`);
        return;
      }
    }
    // local/BunnyCDN listings are always complete in one call; S3 pages —
    // loop until nextCursor is exhausted before declaring avatar cleanup done.
    let cursor = listing.nextCursor ?? null;
    while (cursor) {
      const page = await listForOwner(config, { kind: 'user', userId: job.user_id }, undefined, cursor);
      if (!page.success) {
        await retryOrFail(config, job, `failed to list global user storage (paged): ${page.error ?? 'unknown'}`);
        return;
      }
      for (const key of page.keys ?? []) {
        let ok = false;
        let lastError: string | undefined;
        for (let attempt = 1; attempt <= MAX_DELETE_ATTEMPTS_PER_KEY && !ok; attempt++) {
          const del = await deleteForOwner(config, { kind: 'user', userId: job.user_id }, key);
          ok = del.success;
          lastError = del.error;
        }
        if (!ok) {
          await retryOrFail(config, job, `failed to delete global user object ${key}: ${lastError ?? 'unknown'}`);
          return;
        }
      }
      cursor = page.nextCursor ?? null;
    }
    await releaseLease(config, job.id, { avatar_cleanup_done: true });
    return; // re-claimed next tick to run the final DB purge — one storage/DB action per tick, same rationale as workspaceDeletion/worker.ts
  }

  const { data, error } = await sb.rpc('admin_delete_user', {
    _actor_user_id: job.requested_by,
    _user_id: job.user_id,
  });
  if (error) {
    const { data: stillExists } = await sb.from('profiles').select('id').eq('id', job.user_id).maybeSingle();
    if (stillExists) {
      await retryOrFail(config, job, `admin_delete_user failed: ${error.message}`);
      return;
    }
  }

  const now = new Date().toISOString();
  await sb
    .from('user_deletion_jobs')
    .update({ status: 'completed', purge_result: data ?? null, completed_at: now, locked_by: null, lease_expires_at: null })
    .eq('id', job.id);
}

async function tick(config: ServerConfig): Promise<void> {
  const job = await claimNext(config);
  if (!job) return;

  try {
    if (job.status === 'collecting_workspaces') {
      await collectWorkspaces(config, job);
    } else if (job.status === 'awaiting_workspace_deletions') {
      await checkWorkspaceDeletionsComplete(config, job);
    } else if (job.status === 'purging_user') {
      await purgeUser(config, job);
    }
  } catch (err) {
    await retryOrFail(config, job, errMessage(err));
  }
}

export function startUserDeletionWorker(config: ServerConfig): void {
  if (started) return;
  started = true;
  tick(config).catch((e) => console.error('[user deletion] initial tick error:', e));
  const id = setInterval(() => {
    tick(config).catch((e) => console.error('[user deletion] tick error:', e));
  }, POLL_INTERVAL_MS);
  id.unref?.();
  console.log('[user deletion] worker started, id', WORKER_ID, 'interval', POLL_INTERVAL_MS, 'ms');
}
