/**
 * Workspace deletion worker — multi-provider, multi-worker-safe poll loop.
 *
 * Lifecycle (docs/STORAGE_ARCHITECTURE_AUDIT.md's ACTIVE -> DELETING ->
 * storage cleanup -> DB cleanup -> DELETED requirement):
 *   pending --(claim)--> storage_cleanup --(every scope done)--> db_cleanup
 *           --(admin_delete_workspace succeeds)--> completed
 *                                                --(exhausted retries)--> failed
 *
 * Storage cleanup walks every physical scope a workspace can have objects
 * in (server/services/storage/workspaceScopes.ts — ordinary attachments,
 * LiveKit recordings, privacy exports), never just the ordinary one.
 * `db_cleanup` is never reached until every scope is 'done' or
 * 'skipped_not_configured'. Two scopes resolving to the same physical
 * StorageConfig (storageConfigFingerprint match) are only ever
 * listed/deleted once — the second is marked 'done' via dedup_of, copying
 * the first's counts, never re-scanned.
 *
 * Exactly one storage-listing page is processed per tick (not a draining
 * loop) so a huge workspace never monopolizes one call; progress
 * (storage_scopes JSON: per-scope status/cursor/counts) is persisted after
 * every step and is what makes a crash mid-run safely resumable — the next
 * claim just picks the same job back up and continues from the stored
 * cursor, never re-touching a scope already 'done'.
 *
 * Claiming is multi-worker-safe: claim_workspace_deletion_job() uses
 * Postgres FOR UPDATE SKIP LOCKED plus a lease (locked_by/lease_expires_at)
 * so any number of concurrent worker processes can poll the same table
 * without double-processing a job, and a worker that crashes mid-tick
 * self-heals once its lease expires — no separate stuck-job sweep needed.
 *
 * Failures are retried automatically with backoff (attempt_count/
 * next_retry_at) up to MAX_JOB_ATTEMPTS before the job becomes terminally
 * 'failed' and visible to an admin via GET .../deletion-status; a human
 * can then call retry_workspace_deletion_job() (server/routes/
 * adminManagement.ts's POST .../deletion-retry) to resume — never from
 * scratch, since storage_scopes progress already made is never redone.
 *
 * db_cleanup calls the EXISTING admin_delete_workspace RPC — this worker
 * sequences a storage cleanup before it, never reimplements its purge
 * logic. If that RPC errors but the workspace row is already gone, that's
 * treated as a successful idempotent resume of a run that crashed between
 * the purge committing and this worker recording the result, not a
 * failure.
 */
import { randomUUID } from 'node:crypto';
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { listWithConfig, deleteWithConfig } from '../storage/index.js';
import {
  workspaceStorageScopes,
  workspaceScopePrefix,
  storageConfigFingerprint,
  type WorkspaceStorageScopeName,
} from '../storage/workspaceScopes.js';
import type { WorkspaceDeletionJobRow, StorageScopesState, ScopeProgress } from './types.js';

const POLL_INTERVAL_MS = 5_000;
const LEASE_SECONDS = 60;
const MAX_DELETE_ATTEMPTS_PER_KEY = 3;
const MAX_JOB_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 30 * 60_000;

const WORKER_ID = `wsdel-${randomUUID()}`;

let started = false;

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function emptyScope(status: ScopeProgress['status']): ScopeProgress {
  return { status, cursor: null, objects_found: 0, objects_deleted: 0, error: null, fingerprint: null, dedup_of: null };
}

function findDoneScopeWithFingerprint(state: StorageScopesState, fingerprint: string): WorkspaceStorageScopeName | null {
  for (const [name, progress] of Object.entries(state) as Array<[WorkspaceStorageScopeName, ScopeProgress | undefined]>) {
    if (progress?.status === 'done' && progress.fingerprint === fingerprint && !progress.dedup_of) {
      return name;
    }
  }
  return null;
}

/** Multi-worker-safe: Postgres FOR UPDATE SKIP LOCKED via the RPC, not an application-level mutex. */
export async function claimNext(config: ServerConfig): Promise<WorkspaceDeletionJobRow | null> {
  const sb = getServiceClient(config);
  const { data, error } = await sb.rpc('claim_workspace_deletion_job', {
    _worker_id: WORKER_ID,
    _lease_seconds: LEASE_SECONDS,
  });
  if (error || !data?.ok) return null;
  return (data.job as WorkspaceDeletionJobRow | null) ?? null;
}

async function releaseLeaseAndPersistScopes(
  config: ServerConfig,
  jobId: string,
  state: StorageScopesState,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const sb = getServiceClient(config);
  await sb
    .from('workspace_deletion_jobs')
    .update({ storage_scopes: state, locked_by: null, lease_expires_at: null, ...extra })
    .eq('id', jobId);
}

/**
 * Backs off and retries a transient failure up to MAX_JOB_ATTEMPTS before
 * terminally failing the job. Never touches storage_scopes progress
 * already recorded by the caller — only the retry bookkeeping fields.
 */
async function retryOrFail(
  config: ServerConfig,
  job: WorkspaceDeletionJobRow,
  state: StorageScopesState,
  errorMessage: string,
): Promise<void> {
  const nextAttempt = job.attempt_count + 1;
  if (nextAttempt >= MAX_JOB_ATTEMPTS) {
    await releaseLeaseAndPersistScopes(config, job.id, state, {
      status: 'failed',
      attempt_count: nextAttempt,
      error_message: errorMessage,
    });
    return;
  }
  const backoffMs = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** nextAttempt);
  await releaseLeaseAndPersistScopes(config, job.id, state, {
    attempt_count: nextAttempt,
    error_message: errorMessage,
    next_retry_at: new Date(Date.now() + backoffMs).toISOString(),
  });
}

/**
 * Processes exactly ONE provider-listing page for the first scope that
 * still needs work, deliberately not a loop draining every scope/page in
 * one invocation — see the module doc comment for why. Advances the job
 * to 'db_cleanup' once every scope is done/skipped/deduped.
 */
export async function runStorageCleanup(config: ServerConfig, job: WorkspaceDeletionJobRow): Promise<void> {
  const scopes = workspaceStorageScopes(config, job.workspace_id);
  const state: StorageScopesState = { ...(job.storage_scopes ?? {}) };

  for (const scope of scopes) {
    const existing = state[scope.name];
    if (existing && (existing.status === 'done' || existing.status === 'skipped_not_configured' || existing.status === 'failed')) {
      continue;
    }

    const isFirstTouch = !existing;
    let resolution;
    try {
      resolution = await scope.resolve();
    } catch (err) {
      await retryOrFail(config, job, state, `scope ${scope.name} resolve failed: ${errMessage(err)}`);
      return;
    }

    if (!resolution.configured) {
      if (isFirstTouch) {
        state[scope.name] = emptyScope('skipped_not_configured');
        await releaseLeaseAndPersistScopes(config, job.id, state);
        continue;
      }
      // Was configured on an earlier tick, isn't now (e.g. an operator
      // disabled the integration mid-cleanup) — never silently declare a
      // partially-cleaned scope "done"; surface it for retry/investigation.
      await retryOrFail(config, job, state, `scope ${scope.name} became unconfigured mid-cleanup: ${resolution.reason}`);
      return;
    }

    const fingerprint = storageConfigFingerprint(resolution.config);
    let cur: ScopeProgress;
    if (isFirstTouch) {
      const dedupTarget = findDoneScopeWithFingerprint(state, fingerprint);
      if (dedupTarget) {
        const src = state[dedupTarget]!;
        state[scope.name] = {
          status: 'done', cursor: null, objects_found: src.objects_found, objects_deleted: src.objects_deleted,
          error: null, fingerprint, dedup_of: dedupTarget,
        };
        await releaseLeaseAndPersistScopes(config, job.id, state);
        continue;
      }
      cur = { status: 'in_progress', cursor: null, objects_found: 0, objects_deleted: 0, error: null, fingerprint, dedup_of: null };
      state[scope.name] = cur;
    } else {
      cur = existing!;
    }

    const listing = await listWithConfig(resolution.config, workspaceScopePrefix(job.workspace_id), cur.cursor ?? undefined);
    if (!listing.success) {
      cur.error = listing.error ?? 'list_failed';
      await retryOrFail(config, job, state, `scope ${scope.name} listing failed: ${listing.error ?? 'unknown'}`);
      return;
    }

    for (const key of listing.keys ?? []) {
      let ok = false;
      let lastError: string | undefined;
      for (let attempt = 1; attempt <= MAX_DELETE_ATTEMPTS_PER_KEY && !ok; attempt++) {
        const del = await deleteWithConfig(resolution.config, key);
        ok = del.success;
        lastError = del.error;
      }
      if (!ok) {
        cur.error = `failed to delete ${key}: ${lastError ?? 'unknown'}`;
        await retryOrFail(config, job, state, `scope ${scope.name}: ${cur.error}`);
        return;
      }
      cur.objects_deleted++;
    }
    cur.objects_found += listing.keys?.length ?? 0;
    cur.cursor = listing.nextCursor ?? null;
    if (!cur.cursor) cur.status = 'done';

    await releaseLeaseAndPersistScopes(config, job.id, state);
    return;
  }

  // Every scope is done/skipped/deduped.
  await releaseLeaseAndPersistScopes(config, job.id, state, { status: 'db_cleanup' });
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
    // A crashed prior run may have already committed the purge before
    // recording the result — re-check reality instead of trusting the
    // RPC's second, redundant call to fail loudly.
    const stillExists = await workspaceStillExists(config, job.workspace_id);
    if (stillExists) {
      await retryOrFail(config, job, job.storage_scopes ?? {}, `db cleanup failed: ${error.message}`);
      return;
    }
  }

  const now = new Date().toISOString();
  await sb
    .from('workspace_deletion_jobs')
    .update({ status: 'completed', db_cleanup_completed_at: now, completed_at: now, locked_by: null, lease_expires_at: null })
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
  console.log('[workspace deletion] worker started, id', WORKER_ID, 'interval', POLL_INTERVAL_MS, 'ms');
}
