/**
 * THE canonical data-retention engine. Every lifecycle deletion in this
 * product goes through here — there is no other place that expires
 * operational data, and no ad-hoc `DELETE FROM huge_table WHERE created_at <`
 * anywhere in the codebase.
 *
 * Guarantees (each one covered by a test in src/test/retention/):
 *   - a `permanent` policy NEVER deletes (refused here AND by the SQL
 *     function AND by the table CHECK constraint — three independent layers)
 *   - a disabled policy never deletes
 *   - dry-run never modifies data
 *   - deletion is always bounded: batch_size rows per statement, with a
 *     yield between batches so the database stays responsive
 *   - `archive_then_delete` refuses to delete while no archive adapter is
 *     available (see archive.ts)
 *   - every execution is recorded in `data_retention_runs`, so a failed run
 *     is simply re-runnable (the engine is idempotent — it re-derives the
 *     cutoff from now() and picks up where it left off)
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { getArchiveAdapter } from './archive.js';
import {
  EDITABLE_FIELDS,
  isProtected,
  type EditableField,
  type RetentionPolicy,
  type RetentionRun,
  type RetentionRunStatus,
} from './types.js';

/** Hard ceiling on batches per run, so one policy can never monopolise a worker. */
const MAX_BATCHES_PER_RUN = 200;
/** Yield between batches — keeps the database responsive during large purges. */
const BATCH_PAUSE_MS = parseInt(process.env.RETENTION_BATCH_PAUSE_MS || '150', 10);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class RetentionError extends Error {
  code: string;
  constructor(code: string, message?: string) {
    super(message || code);
    this.code = code;
  }
}

export async function listPolicies(config: ServerConfig): Promise<RetentionPolicy[]> {
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('data_retention_policies')
    .select('*')
    .order('category', { ascending: true })
    .order('policy_key', { ascending: true });
  if (error) throw new RetentionError('list_policies_failed', error.message);
  return (data || []) as RetentionPolicy[];
}

export async function getPolicy(config: ServerConfig, policyKey: string): Promise<RetentionPolicy | null> {
  const sb = getServiceClient(config);
  const { data } = await sb.from('data_retention_policies').select('*').eq('policy_key', policyKey).maybeSingle();
  return (data as RetentionPolicy | null) ?? null;
}

export async function listRuns(
  config: ServerConfig,
  opts: { policyKey?: string; limit?: number } = {},
): Promise<RetentionRun[]> {
  const sb = getServiceClient(config);
  let q = sb.from('data_retention_runs').select('*').order('started_at', { ascending: false });
  if (opts.policyKey) q = q.eq('policy_key', opts.policyKey);
  const { data, error } = await q.limit(Math.min(Math.max(opts.limit ?? 50, 1), 200));
  if (error) throw new RetentionError('list_runs_failed', error.message);
  return (data || []) as RetentionRun[];
}

/**
 * Applies operator edits. Financial/core policies are permanent and stay
 * permanent: the mode is not editable at all, and enabling/disabling them
 * changes nothing because a permanent policy never deletes.
 */
export async function updatePolicy(
  config: ServerConfig,
  policyKey: string,
  patch: Partial<Record<EditableField, unknown>>,
): Promise<RetentionPolicy> {
  const policy = await getPolicy(config, policyKey);
  if (!policy) throw new RetentionError('policy_not_found');

  const clean: Record<string, unknown> = {};
  for (const key of EDITABLE_FIELDS) {
    if (!(key in patch)) continue;
    clean[key] = patch[key];
  }
  if (Object.keys(clean).length === 0) return policy;

  if (isProtected(policy)) {
    // A permanent/financial policy has no window to tune: only `description`
    // is meaningful, everything else would be a no-op or an attempt to widen
    // deletion scope.
    for (const key of Object.keys(clean)) {
      if (key !== 'description') throw new RetentionError('policy_protected');
    }
  }

  if (typeof clean.hot_retention_days === 'number' && clean.hot_retention_days <= 0) {
    throw new RetentionError('invalid_hot_retention_days');
  }
  if (typeof clean.keep_last_n === 'number' && clean.keep_last_n <= 0) {
    throw new RetentionError('invalid_keep_last_n');
  }
  if (typeof clean.batch_size === 'number' && (clean.batch_size < 100 || clean.batch_size > 50000)) {
    throw new RetentionError('invalid_batch_size');
  }

  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('data_retention_policies')
    .update(clean)
    .eq('policy_key', policyKey)
    .select('*')
    .maybeSingle();
  if (error) throw new RetentionError('update_policy_failed', error.message);
  return data as RetentionPolicy;
}

export interface RunOptions {
  dryRun?: boolean;
  triggeredBy?: string;
  actorUserId?: string | null;
  maxBatches?: number;
}

export interface RunOutcome {
  runId: string | null;
  policyKey: string;
  status: RetentionRunStatus;
  rowsMatched: number;
  rowsArchived: number;
  rowsDeleted: number;
  batches: number;
  error: string | null;
  metadata: Record<string, unknown>;
}

export async function runPolicy(config: ServerConfig, policyKey: string, opts: RunOptions = {}): Promise<RunOutcome> {
  const sb = getServiceClient(config);
  const dryRun = opts.dryRun === true;
  const policy = await getPolicy(config, policyKey);
  if (!policy) throw new RetentionError('policy_not_found');

  const base: RunOutcome = {
    runId: null, policyKey, status: 'skipped', rowsMatched: 0, rowsArchived: 0,
    rowsDeleted: 0, batches: 0, error: null, metadata: {},
  };

  // Layer 1 of the permanent guarantee: never even open a run.
  if (isProtected(policy)) {
    return { ...base, status: 'skipped', metadata: { reason: 'permanent_policy' } };
  }
  if (!policy.enabled) {
    return { ...base, status: 'skipped', metadata: { reason: 'policy_disabled' } };
  }

  const { data: runRow, error: runError } = await sb
    .from('data_retention_runs')
    .insert({
      policy_id: policy.id,
      policy_key: policy.policy_key,
      dry_run: dryRun,
      triggered_by: opts.triggeredBy || 'scheduler',
      actor_user_id: opts.actorUserId ?? null,
      status: 'running',
    })
    .select('id')
    .maybeSingle();
  const runId = (runRow as { id: string } | null)?.id ?? null;
  if (runError || !runId) throw new RetentionError('run_tracking_failed', runError?.message);

  const outcome: RunOutcome = { ...base, runId, status: 'running' };

  try {
    if (policy.retention_mode === 'latest_n_runs') {
      await runLatestNRuns(config, policy, dryRun, outcome);
    } else {
      await runTimeBased(config, policy, dryRun, opts, outcome);
    }
    if (outcome.status === 'running') outcome.status = 'completed';
  } catch (err) {
    outcome.status = 'failed';
    outcome.error = (err as Error)?.message?.slice(0, 1000) || 'unknown_error';
  }

  await finalizeRun(config, runId, policy, dryRun, outcome);
  return outcome;
}

async function runLatestNRuns(
  config: ServerConfig,
  policy: RetentionPolicy,
  dryRun: boolean,
  outcome: RunOutcome,
): Promise<void> {
  const sb = getServiceClient(config);
  const { data, error } = await sb.rpc('seo_retention_prune_crawl_details', {
    _keep: policy.keep_last_n ?? 5,
    _batch_size: policy.batch_size,
    _dry_run: dryRun,
  });
  if (error) throw new RetentionError('prune_failed', error.message);
  const row = (Array.isArray(data) ? data[0] : data) as
    | { crawls_matched: number; rows_matched: number; rows_deleted: number }
    | null;
  outcome.rowsMatched = Number(row?.rows_matched || 0);
  outcome.rowsDeleted = dryRun ? 0 : Number(row?.rows_deleted || 0);
  outcome.metadata = { crawlsMatched: Number(row?.crawls_matched || 0), keepLastN: policy.keep_last_n ?? 5 };
}

async function runTimeBased(
  config: ServerConfig,
  policy: RetentionPolicy,
  dryRun: boolean,
  opts: RunOptions,
  outcome: RunOutcome,
): Promise<void> {
  const sb = getServiceClient(config);
  const days =
    policy.retention_mode === 'archive_then_delete'
      ? policy.archive_after_days
      : policy.hot_retention_days;
  if (!days || days <= 0) throw new RetentionError('invalid_retention_window');

  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  outcome.metadata = { cutoff, mode: policy.retention_mode, table: policy.table_name };

  const { data: matched, error: countError } = await sb.rpc('data_retention_count_expired', {
    _policy_key: policy.policy_key,
    _cutoff: cutoff,
  });
  if (countError) throw new RetentionError('count_failed', countError.message);
  outcome.rowsMatched = Number(matched || 0);
  // A preview must never upload archives or invoke an adapter with side effects.
  if (dryRun) return;

  if (policy.archive_enabled) {
    const adapter = getArchiveAdapter();
    const available = await adapter.isAvailable();
    if (!available) {
      // Refuse to delete anything we could not archive.
      outcome.status = 'partial';
      outcome.error = 'archive_adapter_unavailable';
      outcome.metadata = { ...outcome.metadata, archiveAdapter: adapter.name };
      return;
    }
    const res = await adapter.archiveBatch({ policy, cutoff, batchSize: policy.batch_size });
    outcome.rowsArchived = res.rowsArchived;
    outcome.metadata = { ...outcome.metadata, archiveAdapter: adapter.name, locator: res.locator ?? null, bytesArchived: res.bytesArchived };
    if (!res.supported) {
      outcome.status = 'partial';
      outcome.error = res.reason || 'archive_unsupported';
      return;
    }
    if (policy.delete_after_archive === false) {
      outcome.status = 'completed';
      return;
    }
  }

  if (dryRun || outcome.rowsMatched === 0) return;

  const maxBatches = Math.min(opts.maxBatches ?? MAX_BATCHES_PER_RUN, MAX_BATCHES_PER_RUN);
  for (let i = 0; i < maxBatches; i++) {
    const { data: deleted, error } = await sb.rpc('data_retention_delete_batch', {
      _policy_key: policy.policy_key,
      _cutoff: cutoff,
      _batch_size: policy.batch_size,
    });
    if (error) throw new RetentionError('delete_batch_failed', error.message);
    const n = Number(deleted || 0);
    outcome.rowsDeleted += n;
    outcome.batches += 1;
    if (n === 0) return;
    if (BATCH_PAUSE_MS > 0) await sleep(BATCH_PAUSE_MS);
  }
  // Budget exhausted with work left → partial; the next run resumes.
  outcome.status = 'partial';
}

async function finalizeRun(
  config: ServerConfig,
  runId: string | null,
  policy: RetentionPolicy,
  dryRun: boolean,
  outcome: RunOutcome,
): Promise<void> {
  const sb = getServiceClient(config);
  const finishedAt = new Date().toISOString();
  if (runId) {
    await sb
      .from('data_retention_runs')
      .update({
        finished_at: finishedAt,
        status: outcome.status,
        rows_matched: outcome.rowsMatched,
        rows_archived: outcome.rowsArchived,
        rows_deleted: outcome.rowsDeleted,
        batches: outcome.batches,
        error: outcome.error,
        metadata: outcome.metadata,
      })
      .eq('id', runId);
  }
  if (!dryRun) {
    await sb
      .from('data_retention_policies')
      .update({
        last_run_at: finishedAt,
        last_run_status: outcome.status,
        last_rows_deleted: outcome.rowsDeleted,
        last_error: outcome.error,
      })
      .eq('id', policy.id);
  }
}

/** Runs every enabled, non-permanent policy in sequence. Used by the worker. */
export async function runAllPolicies(config: ServerConfig, opts: RunOptions = {}): Promise<RunOutcome[]> {
  const policies = await listPolicies(config);
  const out: RunOutcome[] = [];
  for (const policy of policies) {
    if (!policy.enabled) continue;
    if (isProtected(policy)) continue;
    out.push(await runPolicy(config, policy.policy_key, { ...opts, triggeredBy: opts.triggeredBy || 'scheduler' }));
  }
  return out;
}
