/**
 * Workspace deletion worker — multi-provider, multi-worker-safe, FENCED
 * poll loop.
 *
 * Lifecycle (docs/STORAGE_ARCHITECTURE_AUDIT.md's ACTIVE -> DELETING ->
 * storage cleanup -> DB cleanup -> DELETED requirement):
 *   pending --(claim)--> storage_cleanup --(every scope done+VERIFIED)--> db_cleanup
 *           --(admin_delete_workspace succeeds)--> completed
 *                                                --(exhausted retries)--> failed
 *
 * Storage cleanup walks every physical scope a workspace can have objects
 * in (server/services/storage/workspaceScopes.ts — ordinary attachments,
 * LiveKit recordings, privacy exports) via the shared
 * server/services/storage/scopeCleanupEngine.ts walker, never just the
 * ordinary one. `db_cleanup` is never reached until every scope is
 * 'skipped_not_configured' or 'done' AND `verified: true` — a scope
 * reaching 'done' only means its last listing pass exhausted its cursor,
 * NOT that nothing has been written there since; a fresh from-scratch
 * verification listing must find it genuinely empty before it counts. Two
 * scopes resolving to the same physical StorageConfig (fingerprint match)
 * are only ever listed/deleted once — the second defers entirely to the
 * first via `dedup_of`.
 *
 * ── Lease fencing (second corrective pass, P0) ──────────────────────────
 * A fixed lease is not long enough to guarantee a worker never legitimately
 * outlives it (a 1000-object S3 page, retried deletes, a slow
 * un-paginated Bunny recursive listing). `claim_workspace_deletion_job()`
 * (database/migrations/185_deletion_lease_fencing.sql) mints a fresh
 * `lease_token` on every successful claim, including a reclaim of an
 * expired lease. EVERY progress/status write this worker makes is
 * conditioned on `id = <job> AND lease_token = <token this claim was
 * given>` (persistFenced() below) — if another worker has since reclaimed
 * the job, that token no longer matches, the write affects zero rows, and
 * persistFenced() throws LeaseFencedError. tick() catches exactly that
 * error and stops all further work for the job on this worker — a stale
 * worker can keep computing (harmlessly — deletes are idempotent) but can
 * never again mutate job state once fenced out.
 *
 * `renewLease()` is the heartbeat: called periodically INSIDE the
 * scopeCleanupEngine's per-key delete loop (not only between poll ticks),
 * extending `lease_expires_at` without changing the token, as long as this
 * worker still holds it. If a slow, unpaginated single provider call (e.g.
 * Bunny's recursive listing) runs long enough to lose the lease with no
 * opportunity to heartbeat mid-call, fencing is still the safety net: the
 * eventual persist attempt after that call returns is simply rejected.
 *
 * `tickRunning` is a same-process guard: setInterval never launches a
 * second overlapping tick in this process while one is still in flight
 * (e.g. a slow storage call outliving the poll interval) — defense in
 * depth alongside the DB-level fencing, not a replacement for it (it does
 * nothing for a second WORKER PROCESS, which is what lease_token exists
 * for).
 *
 * Claiming is multi-worker-safe: claim_workspace_deletion_job() uses
 * Postgres FOR UPDATE SKIP LOCKED so any number of concurrent worker
 * processes can poll the same table without double-processing a job, and
 * a worker that crashes mid-tick self-heals once its lease expires — no
 * separate stuck-job sweep needed.
 *
 * Failures are retried automatically with backoff (attempt_count/
 * next_retry_at) up to MAX_JOB_ATTEMPTS before the job becomes terminally
 * 'failed' and visible to an admin via GET .../deletion-status; a human
 * can then call retry_workspace_deletion_job() (server/routes/
 * adminManagement.ts's POST .../deletion-retry) to resume — never from
 * scratch, since storage_scopes progress already made is never redone.
 * A storage-config-drift error (a scope's physical provider changed mid-
 * cleanup) surfaces through this exact same retry/terminal-failure path —
 * see scopeCleanupEngine.ts's driftMessage().
 *
 * db_cleanup calls the EXISTING admin_delete_workspace RPC — this worker
 * sequences a storage cleanup before it, never reimplements its purge
 * logic. If that RPC errors but the workspace row is already gone, that's
 * treated as a successful idempotent resume of a run that crashed between
 * the purge committing and this worker recording the result, not a
 * failure. (This purge itself is NOT conditioned on the lease token — it's
 * naturally idempotent, a second concurrent/stale call either deletes
 * nothing or errors "not found", so overlap between a stale and a fresh
 * worker's db_cleanup attempt is harmless; only the JOB-ROW bookkeeping
 * write needs fencing, per persistFenced() above.)
 */
import { randomUUID } from 'node:crypto';
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { workspaceStorageScopes, workspaceScopePrefix } from '../storage/workspaceScopes.js';
import { runScopeCleanupTick, type ScopeCleanupState } from '../storage/scopeCleanupEngine.js';
import type { WorkspaceDeletionJobRow } from './types.js';

const POLL_INTERVAL_MS = 5_000;
const LEASE_SECONDS = 60;
const HEARTBEAT_INTERVAL_MS = 15_000;
const MAX_DELETE_ATTEMPTS_PER_KEY = 3;
const MAX_JOB_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 30 * 60_000;

const WORKER_ID = `wsdel-${randomUUID()}`;

let started = false;
let tickRunning = false;

/** Thrown when a job-row write is rejected because this worker no longer holds the current lease_token (another worker has reclaimed the job). Never corrupts state — the write simply didn't happen. */
export class LeaseFencedError extends Error {}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Multi-worker-safe: Postgres FOR UPDATE SKIP LOCKED via the RPC, not an application-level mutex. Mints a fresh lease_token on every claim. */
export async function claimNext(config: ServerConfig): Promise<WorkspaceDeletionJobRow | null> {
  const sb = getServiceClient(config);
  const { data, error } = await sb.rpc('claim_workspace_deletion_job', {
    _worker_id: WORKER_ID,
    _lease_seconds: LEASE_SECONDS,
  });
  if (error || !data?.ok) return null;
  return (data.job as WorkspaceDeletionJobRow | null) ?? null;
}

/** Heartbeat: extends the lease without changing the token. Returns false the instant this worker no longer holds it. */
async function renewLease(config: ServerConfig, jobId: string, leaseToken: string): Promise<boolean> {
  const sb = getServiceClient(config);
  const { data, error } = await sb.rpc('renew_workspace_deletion_lease', {
    _job_id: jobId,
    _lease_token: leaseToken,
    _lease_seconds: LEASE_SECONDS,
  });
  return !error && !!data?.ok;
}

/** Every job-row write goes through this. Conditioned on id AND lease_token — a mismatch (fenced out) throws rather than silently no-op'ing. */
async function persistFenced(
  config: ServerConfig,
  jobId: string,
  leaseToken: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('workspace_deletion_jobs')
    .update(patch)
    .eq('id', jobId)
    .eq('lease_token', leaseToken)
    .select('id');
  if (error) throw error;
  if (!data || data.length === 0) {
    throw new LeaseFencedError(`workspace_deletion_jobs ${jobId}: lease no longer held (fenced out) — another worker has reclaimed this job`);
  }
}

/**
 * Backs off and retries a transient failure up to MAX_JOB_ATTEMPTS before
 * terminally failing the job. Never touches storage_scopes progress
 * already recorded by the caller — only the retry bookkeeping fields.
 */
async function retryOrFail(
  config: ServerConfig,
  job: WorkspaceDeletionJobRow,
  state: ScopeCleanupState,
  errorMessage: string,
): Promise<void> {
  const nextAttempt = job.attempt_count + 1;
  if (nextAttempt >= MAX_JOB_ATTEMPTS) {
    await persistFenced(config, job.id, job.lease_token!, {
      storage_scopes: state, status: 'failed', attempt_count: nextAttempt, error_message: errorMessage,
      locked_by: null, lease_expires_at: null,
    });
    return;
  }
  const backoffMs = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** nextAttempt);
  await persistFenced(config, job.id, job.lease_token!, {
    storage_scopes: state, attempt_count: nextAttempt, error_message: errorMessage,
    next_retry_at: new Date(Date.now() + backoffMs).toISOString(),
    locked_by: null, lease_expires_at: null,
  });
}

/**
 * Processes exactly ONE unit of work (one listing page, one verification
 * pass, or one dedup) via the shared scopeCleanupEngine — deliberately not
 * a loop draining every scope/page in one invocation, see the module doc
 * comment. Advances the job to 'db_cleanup' once every scope is settled
 * (done AND verified, or skipped_not_configured).
 */
export async function runStorageCleanup(config: ServerConfig, job: WorkspaceDeletionJobRow): Promise<void> {
  const scopes = workspaceStorageScopes(config, job.workspace_id);
  const state: ScopeCleanupState = { ...(job.storage_scopes ?? {}) };
  const leaseToken = job.lease_token!;

  const outcome = await runScopeCleanupTick({
    scopes,
    prefix: workspaceScopePrefix(job.workspace_id),
    state,
    maxDeleteAttemptsPerKey: MAX_DELETE_ATTEMPTS_PER_KEY,
    heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
    heartbeat: () => renewLease(config, job.id, leaseToken),
    // Intermediate saves within a single tick (e.g. several skip/dedup
    // scopes in a row before real work) — deliberately does NOT release
    // the lock; only the final write below does, once this call returns.
    persist: (s) => persistFenced(config, job.id, leaseToken, { storage_scopes: s }),
  });

  if (outcome.kind === 'error') {
    await retryOrFail(config, job, state, outcome.message);
    return;
  }
  if (outcome.kind === 'advance') {
    await persistFenced(config, job.id, leaseToken, { storage_scopes: state, status: 'db_cleanup', locked_by: null, lease_expires_at: null });
    return;
  }
  await persistFenced(config, job.id, leaseToken, { storage_scopes: state, locked_by: null, lease_expires_at: null });
}

async function workspaceStillExists(config: ServerConfig, workspaceId: string): Promise<boolean> {
  const sb = getServiceClient(config);
  const { data } = await sb.from('workspaces').select('id').eq('id', workspaceId).maybeSingle();
  return !!data;
}

export async function runDbCleanup(config: ServerConfig, job: WorkspaceDeletionJobRow): Promise<void> {
  const sb = getServiceClient(config);
  const { error } = await sb.rpc('admin_delete_workspace', {
    _actor_user_id: job.requested_by,
    _workspace_id: job.workspace_id,
  });

  if (error) {
    // A crashed prior run (or a stale worker whose RPC call raced a fresh
    // claimant's) may have already committed the purge before recording
    // the result — re-check reality instead of trusting the RPC's second,
    // redundant call to fail loudly. This RPC is intentionally not
    // fencing-conditioned (see module doc comment) — it's the job-row
    // write below that is.
    const stillExists = await workspaceStillExists(config, job.workspace_id);
    if (stillExists) {
      await retryOrFail(config, job, job.storage_scopes ?? {}, `db cleanup failed: ${error.message}`);
      return;
    }
  }

  const now = new Date().toISOString();
  await persistFenced(config, job.id, job.lease_token!, {
    status: 'completed', db_cleanup_completed_at: now, completed_at: now, locked_by: null, lease_expires_at: null,
  });
}

async function tick(config: ServerConfig): Promise<void> {
  if (tickRunning) return; // same-process guard — defense in depth alongside DB-level fencing, never a substitute for it
  tickRunning = true;
  try {
    const job = await claimNext(config);
    if (!job) return;

    try {
      if (job.status === 'storage_cleanup') {
        await runStorageCleanup(config, job);
        return; // re-claimed next tick to pick up db_cleanup, keeps each tick single-purpose and observable
      }
      if (job.status === 'db_cleanup') {
        await runDbCleanup(config, job);
      }
    } catch (err) {
      if (err instanceof LeaseFencedError) {
        console.warn('[workspace deletion]', err.message);
        return; // job is now owned by another worker — nothing more to do here
      }
      throw err;
    }
  } finally {
    tickRunning = false;
  }
}

export function startWorkspaceDeletionWorker(config: ServerConfig): void {
  if (started) return;
  started = true;
  tick(config).catch((e) => console.error('[workspace deletion] initial tick error:', errMessage(e)));
  const id = setInterval(() => {
    tick(config).catch((e) => console.error('[workspace deletion] tick error:', errMessage(e)));
  }, POLL_INTERVAL_MS);
  id.unref?.();
  console.log('[workspace deletion] worker started, id', WORKER_ID, 'interval', POLL_INTERVAL_MS, 'ms');
}
