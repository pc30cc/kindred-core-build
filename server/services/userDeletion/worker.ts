/**
 * User (account) deletion worker — routes owned workspaces through the
 * SAME storage-aware, multi-provider workspace deletion machinery
 * (server/services/workspaceDeletion/worker.ts) instead of the old
 * ad-hoc, capped, best-effort storage sweep, and cleans the user's own
 * GLOBAL users/<id>/ objects across every physical scope that can hold
 * them (server/services/storage/userScopes.ts — 'default' and
 * 'privacy_export'), not just the default provider. See database/
 * migrations/183_user_deletion_lifecycle.sql and
 * 186_user_deletion_multi_provider.sql for the full rationale.
 *
 * Lifecycle:
 *   collecting_workspaces --(enqueue one workspace_deletion_jobs row per
 *     owned workspace, via the same enqueue_workspace_deletion RPC the
 *     admin workspace-delete route uses — a business-level {ok:false}
 *     result is treated as a real failure, not just a transport error)-->
 *   awaiting_workspace_deletions --(every owned workspace is gone from
 *     public.workspaces AND no remaining owned workspace's latest
 *     deletion job is terminally 'failed' — a terminal child failure
 *     propagates as a failure here too, rather than polling forever)-->
 *   purging_user --(walk every user storage scope via the shared
 *     scopeCleanupEngine — same dedup/verify/drift-detection guarantees
 *     as workspace deletion — then call the existing admin_delete_user
 *     RPC for the final per-user-column sweep + profile delete; by this
 *     point zero workspaces remain owned by the user, so
 *     admin_delete_user's internal admin_purge_workspaces call is a
 *     guaranteed no-op)--> completed
 *                                                                --> failed (retries exhausted)
 *
 * The DB ownership row (profiles) is never touched until every owned
 * workspace's storage AND DB cleanup has completed, AND every user
 * storage scope is done+verified — enforced structurally by the state
 * machine order above, not by a best-effort ordering guess.
 *
 * Claiming, fencing, heartbeat, tickRunning, retry/backoff and
 * multi-worker safety mirror workspaceDeletion/worker.ts exactly — see
 * that module's doc comment for the full rationale, unchanged here.
 */
import { randomUUID } from 'node:crypto';
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { userStorageScopes, userScopePrefix } from '../storage/userScopes.js';
import { runScopeCleanupTick, type ScopeCleanupState } from '../storage/scopeCleanupEngine.js';
import { hasActiveOwnerWriteLeases } from '../storage/writerLease.js';
import type { UserDeletionJobRow } from './types.js';

const POLL_INTERVAL_MS = 5_000;
const LEASE_SECONDS = 60;
const HEARTBEAT_INTERVAL_MS = 15_000;
const MAX_DELETE_ATTEMPTS_PER_KEY = 3;
const MAX_JOB_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 30 * 60_000;

const WORKER_ID = `userdel-${randomUUID()}`;

let started = false;
let tickRunning = false;

export class LeaseFencedError extends Error {}

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

async function renewLease(config: ServerConfig, jobId: string, leaseToken: string): Promise<boolean> {
  const sb = getServiceClient(config);
  const { data, error } = await sb.rpc('renew_user_deletion_lease', {
    _job_id: jobId,
    _lease_token: leaseToken,
    _lease_seconds: LEASE_SECONDS,
  });
  return !error && !!data?.ok;
}

async function persistFenced(
  config: ServerConfig,
  jobId: string,
  leaseToken: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('user_deletion_jobs')
    .update(patch)
    .eq('id', jobId)
    .eq('lease_token', leaseToken)
    .select('id');
  if (error) throw error;
  if (!data || data.length === 0) {
    throw new LeaseFencedError(`user_deletion_jobs ${jobId}: lease no longer held (fenced out) — another worker has reclaimed this job`);
  }
}

async function retryOrFail(config: ServerConfig, job: UserDeletionJobRow, errorMessage: string, extra: Record<string, unknown> = {}): Promise<void> {
  const nextAttempt = job.attempt_count + 1;
  if (nextAttempt >= MAX_JOB_ATTEMPTS) {
    await persistFenced(config, job.id, job.lease_token!, {
      ...extra, status: 'failed', attempt_count: nextAttempt, error_message: errorMessage,
      locked_by: null, lease_expires_at: null,
    });
    return;
  }
  const backoffMs = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** nextAttempt);
  await persistFenced(config, job.id, job.lease_token!, {
    ...extra, attempt_count: nextAttempt, error_message: errorMessage,
    next_retry_at: new Date(Date.now() + backoffMs).toISOString(),
    locked_by: null, lease_expires_at: null,
  });
}

async function releaseLease(config: ServerConfig, job: UserDeletionJobRow, extra: Record<string, unknown> = {}): Promise<void> {
  await persistFenced(config, job.id, job.lease_token!, { ...extra, locked_by: null, lease_expires_at: null });
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
    const { data, error: enqueueError } = await sb.rpc('enqueue_workspace_deletion', {
      _workspace_id: workspaceId,
      _actor_user_id: job.requested_by,
    });
    if (enqueueError) {
      await retryOrFail(config, job, `failed to enqueue deletion for workspace ${workspaceId}: ${enqueueError.message}`);
      return;
    }
    // Inspect the RPC's BUSINESS result, not just the transport error — a
    // SQL-successful call can still report {ok:false} (e.g. the workspace
    // is stuck 'deleting' with every prior job attempt terminally failed,
    // needing retry_workspace_deletion_job first). A race where the
    // workspace was already deleted between our listing query and this
    // enqueue call (workspace_not_found) is not a failure — there is
    // nothing left to wait for.
    if (!data?.ok && data?.error !== 'workspace_not_found') {
      await retryOrFail(config, job, `enqueue_workspace_deletion for workspace ${workspaceId} returned ok:false (${data?.error ?? 'unknown'})`);
      return;
    }
  }

  await releaseLease(config, job, { status: 'awaiting_workspace_deletions', workspace_ids: workspaceIds });
}

async function checkWorkspaceDeletionsComplete(config: ServerConfig, job: UserDeletionJobRow): Promise<void> {
  if (job.workspace_ids.length === 0) {
    await releaseLease(config, job, { status: 'purging_user' });
    return;
  }

  const sb = getServiceClient(config);
  const { data: remaining, error } = await sb.from('workspaces').select('id').in('id', job.workspace_ids);
  if (error) {
    await retryOrFail(config, job, `failed to check workspace deletion progress: ${error.message}`);
    return;
  }
  const remainingIds = (remaining ?? []).map((w) => w.id as string);
  if (remainingIds.length === 0) {
    // Every owned workspace is gone from `workspaces` — a job that
    // exhausted ITS OWN retries and is terminally 'failed' also removes
    // the workspace row only on success, so if the row is gone the job
    // that deleted it necessarily reached 'completed'. Nothing further to verify.
    await releaseLease(config, job, { status: 'purging_user' });
    return;
  }

  // Some owned workspaces still exist — check whether any of THEIR latest
  // deletion job is terminally 'failed' before deciding to keep waiting.
  // Polling forever on a workspace whose own retries are exhausted would
  // wedge this user-deletion job indefinitely; propagate that as a
  // failure of ours instead (resumable — once an admin retries the
  // failed workspace deletion via POST .../workspaces/:id/deletion-retry,
  // the next check here proceeds normally).
  const { data: jobs, error: jobsError } = await sb
    .from('workspace_deletion_jobs')
    .select('workspace_id, status, requested_at')
    .in('workspace_id', remainingIds)
    .order('requested_at', { ascending: false });
  if (jobsError) {
    await retryOrFail(config, job, `failed to check owned workspace deletion job status: ${jobsError.message}`);
    return;
  }
  const latestStatusByWorkspace = new Map<string, string>();
  for (const row of (jobs ?? []) as Array<{ workspace_id: string; status: string }>) {
    if (!latestStatusByWorkspace.has(row.workspace_id)) latestStatusByWorkspace.set(row.workspace_id, row.status);
  }
  const failedWorkspaceIds = remainingIds.filter((id) => latestStatusByWorkspace.get(id) === 'failed');
  if (failedWorkspaceIds.length > 0) {
    await retryOrFail(
      config, job,
      `owned workspace deletion(s) reached a terminal failure: ${failedWorkspaceIds.join(', ')} — an admin must retry those workspace deletions (POST .../workspaces/:id/deletion-retry) before this account deletion can proceed`,
    );
    return;
  }

  // Still legitimately in flight — not a failure, just not ready yet.
  // Release the lease without bumping attempt_count so this never counts
  // toward MAX_JOB_ATTEMPTS; the next poll (by any worker) re-checks.
  await releaseLease(config, job);
}

/**
 * Fourth corrective pass, P0: no user storage scope is ever touched while
 * an owner_write_lease (server/services/storage/writerLease.ts) is still
 * outstanding for this user — the same TOCTOU-closing gate
 * workspaceDeletion/worker.ts's runStorageCleanup() applies. No NEW lease
 * can be acquired once this job exists (acquireOwnerWriteLease() checks
 * for an active user_deletion_jobs row, atomically, against the SAME
 * profiles-row lock enqueue_user_deletion() used to create it — see
 * 187_owner_write_leases.sql), so this can only ever be waiting on leases
 * that were already in flight before the job began; it can only shrink
 * from here, never grow.
 */
async function purgeUser(config: ServerConfig, job: UserDeletionJobRow): Promise<void> {
  if (await hasActiveOwnerWriteLeases(config, 'user', job.user_id)) {
    await releaseLease(config, job);
    return;
  }

  const sb = getServiceClient(config);
  const state: ScopeCleanupState = { ...(job.storage_scopes ?? {}) };
  const leaseToken = job.lease_token!;
  // Same as workspace deletion: the pool's enabled vendors are physical
  // scopes, and a failed pool read must retry rather than silently skip them.
  let scopes;
  try {
    scopes = await userStorageScopes(config, job.user_id);
  } catch (err) {
    await retryOrFail(config, job, `storage scope resolution failed: ${err instanceof Error ? err.message : String(err)}`, { storage_scopes: state });
    return;
  }

  const outcome = await runScopeCleanupTick({
    scopes,
    prefix: userScopePrefix(job.user_id),
    state,
    maxDeleteAttemptsPerKey: MAX_DELETE_ATTEMPTS_PER_KEY,
    heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
    heartbeat: () => renewLease(config, job.id, leaseToken),
    persist: (s) => persistFenced(config, job.id, leaseToken, { storage_scopes: s }),
  });

  if (outcome.kind === 'error') {
    await retryOrFail(config, job, outcome.message, { storage_scopes: state });
    return;
  }
  if (outcome.kind === 'progress') {
    await persistFenced(config, job.id, leaseToken, { storage_scopes: state, locked_by: null, lease_expires_at: null });
    return; // re-claimed next tick — one unit of work per tick, same rationale as workspaceDeletion/worker.ts
  }
  // 'advance' — every user storage scope is settled (done+verified, or
  // skipped_not_configured). Persist that and fall through to the DB
  // purge on THIS tick (avoids an extra round-trip; unlike
  // storage_cleanup -> db_cleanup, there's no separate status value to
  // transition through here — 'purging_user' covers both halves).
  await persistFenced(config, job.id, leaseToken, { storage_scopes: state });

  // Sixth corrective pass: defense-in-depth recheck immediately before
  // the irreversible admin_delete_user purge, symmetric with
  // workspaceDeletion/worker.ts's reassertSafeToPurge() before
  // admin_delete_workspace. Not the primary guarantee (that remains the
  // atomic no-new-user-lease invariant in 187_owner_write_leases.sql's
  // acquire_owner_write_lease) — a regression guard against this check
  // above and the purge below drifting apart in the future. If a lease
  // somehow appears outstanding here, release without bumping
  // attempt_count (same as the top-of-function check) so a later tick
  // re-verifies rather than purging.
  if (await hasActiveOwnerWriteLeases(config, 'user', job.user_id)) {
    await releaseLease(config, job);
    return;
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
  await persistFenced(config, job.id, leaseToken, {
    status: 'completed', purge_result: data ?? null, completed_at: now, locked_by: null, lease_expires_at: null,
  });
}

async function tick(config: ServerConfig): Promise<void> {
  if (tickRunning) return;
  tickRunning = true;
  try {
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
      if (err instanceof LeaseFencedError) {
        console.warn('[user deletion]', err.message);
        return;
      }
      throw err;
    }
  } finally {
    tickRunning = false;
  }
}

export function startUserDeletionWorker(config: ServerConfig): void {
  if (started) return;
  started = true;
  tick(config).catch((e) => console.error('[user deletion] initial tick error:', errMessage(e)));
  const id = setInterval(() => {
    tick(config).catch((e) => console.error('[user deletion] tick error:', errMessage(e)));
  }, POLL_INTERVAL_MS);
  id.unref?.();
  console.log('[user deletion] worker started, id', WORKER_ID, 'interval', POLL_INTERVAL_MS, 'ms');
}
