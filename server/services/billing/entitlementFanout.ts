/**
 * Phase 6-S5-R6 — durable entitlement fan-out.
 *
 * Editing a plan definition or flipping the platform AI kill switch changes
 * the effective entitlements of every workspace on that plan. R5 handled this
 * with an in-process `void (async () => …)` detach, which silently lost all
 * remaining work on deploy/restart/crash.
 *
 * This module replaces that with a real queue:
 *   - work is PERSISTED in public.entitlement_fanout_jobs before the HTTP
 *     request returns,
 *   - a background worker claims a job under an owned, EXPIRING lease,
 *   - progress is checkpointed as a KEYSET cursor (`WHERE id > cursor`), so a
 *     restart resumes exactly where it stopped and no page is ever skipped or
 *     replayed wholesale,
 *   - only the current lease owner may advance, complete or fail a job.
 *
 * Never throws to a billing caller: a queueing failure is reported, not
 * propagated.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import {
  handleWorkspaceEntitlementChanged,
  AI_RELEVANT_LIMIT_KEYS,
  type EntitlementChangeSource,
} from './entitlementChange.js';

/** Workspaces resolved per keyset page. Bounded memory, deterministic order. */
export const FANOUT_KEYSET_PAGE_SIZE = 200;
/** Pages processed per claimed lease before the job is re-queued. */
export const FANOUT_PAGES_PER_LEASE = 10;
export const FANOUT_LEASE_SECONDS = 300;

export type FanoutScope = 'plan' | 'platform';

export interface EnqueueFanoutResult {
  ok: boolean;
  jobId: string | null;
  /** True when nothing was queued because the change cannot affect AI access. */
  skipped: boolean;
  errorCode?: 'fanout_enqueue_failed';
}

// ─────────────────────────────────────────────────────────────
//  AI relevance diff
// ─────────────────────────────────────────────────────────────

/**
 * Entitlement keys whose value decides whether AI indexing may run at all.
 * `knowledge_base` is deliberately absent: the Knowledge Base is a core
 * product and is never plan-gated (Phase 6-S5-R4).
 */
export const AI_RELEVANT_ENTITLEMENT_KEYS = ['ai_assistant', 'ai_kb_builder'] as const;

export interface PlanDefinitionLike {
  is_active?: boolean | null;
  entitlements?: Record<string, unknown> | null;
  limits?: Record<string, unknown> | null;
}

function readFlag(source: Record<string, unknown> | null | undefined, key: string): unknown {
  if (!source) return undefined;
  const raw = source[key];
  if (raw && typeof raw === 'object' && 'enabled' in (raw as Record<string, unknown>)) {
    return (raw as Record<string, unknown>).enabled;
  }
  return raw;
}

/**
 * Pure predicate: does this plan edit have ANY chance of changing whether a
 * workspace may run AI indexing, or how much of it?
 *
 * Unknown previous state (`undefined`) is treated conservatively as relevant —
 * a missed fan-out silently strands the index, a redundant one is idempotent.
 */
export function planChangeAffectsAiEntitlements(
  previous: PlanDefinitionLike | null | undefined,
  next: PlanDefinitionLike | null | undefined,
): boolean {
  if (!previous || !next) return true;

  // Deactivating (or reactivating) a plan changes every subscriber's access.
  if ((previous.is_active !== false) !== (next.is_active !== false)) return true;

  for (const key of AI_RELEVANT_ENTITLEMENT_KEYS) {
    const a = readFlag(previous.entitlements, key);
    const b = readFlag(next.entitlements, key);
    if (a === undefined && b === undefined) continue;
    if (!!a !== !!b) return true;
  }
  for (const key of AI_RELEVANT_LIMIT_KEYS) {
    const a = previous.limits?.[key];
    const b = next.limits?.[key];
    if (a === undefined && b === undefined) continue;
    if (a !== b) return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────
//  Producers
// ─────────────────────────────────────────────────────────────

async function enqueue(
  config: ServerConfig,
  scope: FanoutScope,
  source: EntitlementChangeSource,
  planId: string | null,
): Promise<EnqueueFanoutResult> {
  try {
    const { data, error } = await getServiceClient(config).rpc('enqueue_entitlement_fanout', {
      _scope: scope,
      _source: source,
      _plan_id: planId,
    });
    if (error || !data) {
      console.error(
        '[billing.entitlementFanout] enqueue failed',
        JSON.stringify({ scope, source, planId }),
      );
      return { ok: false, jobId: null, skipped: false, errorCode: 'fanout_enqueue_failed' };
    }
    return { ok: true, jobId: String(data), skipped: false };
  } catch {
    return { ok: false, jobId: null, skipped: false, errorCode: 'fanout_enqueue_failed' };
  }
}

/**
 * Queue a durable fan-out for a plan-definition edit.
 *
 * The caller passes the plan row BEFORE and AFTER the write. When neither
 * AI entitlement nor any AI-relevant limit moved, nothing is queued — a price
 * or description edit must not trigger a workspace-wide re-index sweep.
 */
export async function enqueuePlanEntitlementFanout(
  config: ServerConfig,
  planId: string,
  diff: { previous?: PlanDefinitionLike | null; next?: PlanDefinitionLike | null } = {},
  source: EntitlementChangeSource = 'plan_definition_updated',
): Promise<EnqueueFanoutResult> {
  if (!planId) {
    return { ok: false, jobId: null, skipped: false, errorCode: 'fanout_enqueue_failed' };
  }
  if (
    diff.previous !== undefined &&
    diff.next !== undefined &&
    !planChangeAffectsAiEntitlements(diff.previous, diff.next)
  ) {
    return { ok: true, jobId: null, skipped: true };
  }
  return enqueue(config, 'plan', source, planId);
}

/**
 * Queue a durable platform-wide fan-out. Call ONLY on a genuine
 * OFF → ON transition of the platform AI switch: turning AI off can never
 * grant access, so it needs no catch-up.
 */
export async function enqueuePlatformEntitlementFanout(
  config: ServerConfig,
  transition: { previousEnabled?: boolean; nextEnabled?: boolean } = {},
): Promise<EnqueueFanoutResult> {
  const { previousEnabled, nextEnabled } = transition;
  if (previousEnabled !== undefined && nextEnabled !== undefined) {
    if (!(previousEnabled === false && nextEnabled === true)) {
      return { ok: true, jobId: null, skipped: true };
    }
  }
  return enqueue(config, 'platform', 'platform_ai_toggle', null);
}

// ─────────────────────────────────────────────────────────────
//  Consumer (worker)
// ─────────────────────────────────────────────────────────────

interface ClaimRow {
  id: string;
  scope: FanoutScope;
  source: string;
  plan_id: string | null;
  cursor_workspace_id: string | null;
  attempts: number;
  claim_token: string;
  claim_expires_at: string;
}

export interface FanoutDrainSummary {
  claimed: number;
  processed: number;
  failed: number;
  completed: number;
  requeued: number;
  leaseLost: number;
  lookupFailures: number;
}

/**
 * Deterministic keyset page. Ordering is by primary key so the cursor is
 * total, stable and immune to concurrent inserts/deletes.
 */
async function readKeysetPage(
  config: ServerConfig,
  job: ClaimRow,
  cursor: string | null,
): Promise<{ ids: string[]; error: boolean }> {
  const sb = getServiceClient(config);
  try {
    if (job.scope === 'plan') {
      let q = sb
        .from('workspace_subscriptions')
        .select('workspace_id')
        .eq('plan_id', job.plan_id as string)
        .order('workspace_id', { ascending: true })
        .limit(FANOUT_KEYSET_PAGE_SIZE);
      if (cursor) q = q.gt('workspace_id', cursor);
      const { data, error } = await q;
      if (error) return { ids: [], error: true };
      return {
        ids: (data || []).map((r) => (r as { workspace_id: string }).workspace_id),
        error: false,
      };
    }
    let q = sb
      .from('workspaces')
      .select('id')
      .order('id', { ascending: true })
      .limit(FANOUT_KEYSET_PAGE_SIZE);
    if (cursor) q = q.gt('id', cursor);
    const { data, error } = await q;
    if (error) return { ids: [], error: true };
    return { ids: (data || []).map((r) => (r as { id: string }).id), error: false };
  } catch {
    return { ids: [], error: true };
  }
}

/**
 * Drains claimable fan-out jobs. Never throws.
 *
 * Restart safety: every page is checkpointed with `advance_entitlement_fanout`
 * BEFORE the next page is read, and the checkpoint only succeeds while this
 * worker still owns an unexpired lease. Losing the lease aborts the job
 * immediately so two workers can never double-drive the same cursor.
 */
export async function drainEntitlementFanoutJobs(
  config: ServerConfig,
  opts: { workerId?: string; limit?: number; leaseSeconds?: number } = {},
): Promise<FanoutDrainSummary> {
  const summary: FanoutDrainSummary = {
    claimed: 0, processed: 0, failed: 0, completed: 0,
    requeued: 0, leaseLost: 0, lookupFailures: 0,
  };
  const workerId = opts.workerId ?? process.env.WORKER_ID ?? 'entitlement-fanout';
  const leaseSeconds = Math.max(opts.leaseSeconds ?? FANOUT_LEASE_SECONDS, 30);
  const sb = getServiceClient(config);

  const { data, error } = await sb.rpc('claim_entitlement_fanout_jobs', {
    _worker_id: workerId,
    _limit: Math.min(Math.max(opts.limit ?? 1, 1), 5),
    _lease_seconds: leaseSeconds,
  });
  if (error || !data) return summary;

  const jobs = data as unknown as ClaimRow[];
  summary.claimed = jobs.length;

  for (const job of jobs) {
    if (job.scope === 'plan' && !job.plan_id) {
      await sb.rpc('fail_entitlement_fanout', {
        _id: job.id, _claim_token: job.claim_token, _worker_id: workerId,
        _error_code: 'malformed_job', _retry_seconds: 3600, _max_attempts: 1,
      });
      summary.failed += 1;
      continue;
    }

    let cursor = job.cursor_workspace_id;
    let pages = 0;
    let done = false;
    let aborted = false;

    while (pages < FANOUT_PAGES_PER_LEASE) {
      const page = await readKeysetPage(config, job, cursor);
      if (page.error) {
        summary.lookupFailures += 1;
        await sb.rpc('fail_entitlement_fanout', {
          _id: job.id, _claim_token: job.claim_token, _worker_id: workerId,
          _error_code: 'fanout_lookup_failed', _retry_seconds: 300, _max_attempts: 10,
        });
        aborted = true;
        break;
      }
      pages += 1;

      let processed = 0;
      let failed = 0;
      for (const workspaceId of page.ids) {
        if (!workspaceId) continue;
        const r = await handleWorkspaceEntitlementChanged(config, {
          workspaceId,
          source: job.source as EntitlementChangeSource,
        });
        processed += 1;
        if (!r.ok) failed += 1;
        cursor = workspaceId;
      }
      summary.processed += processed;
      summary.failed += failed;

      if (page.ids.length < FANOUT_KEYSET_PAGE_SIZE) { done = true; break; }

      const { data: advanced, error: advErr } = await sb.rpc('advance_entitlement_fanout', {
        _id: job.id, _claim_token: job.claim_token, _worker_id: workerId,
        _cursor_workspace_id: cursor, _processed: processed, _failed: failed,
        _lease_seconds: leaseSeconds,
      });
      if (advErr || advanced !== true) {
        // Lease expired or stolen — stop touching this job immediately.
        summary.leaseLost += 1;
        aborted = true;
        break;
      }
    }

    if (aborted) continue;

    if (done) {
      const { data: ok } = await sb.rpc('complete_entitlement_fanout', {
        _id: job.id, _claim_token: job.claim_token, _worker_id: workerId,
        _processed: 0, _failed: 0,
      });
      if (ok === true) summary.completed += 1;
      else summary.leaseLost += 1;
      continue;
    }

    // Lease budget exhausted with work remaining: checkpoint and re-queue.
    const { data: advanced } = await sb.rpc('advance_entitlement_fanout', {
      _id: job.id, _claim_token: job.claim_token, _worker_id: workerId,
      _cursor_workspace_id: cursor, _processed: 0, _failed: 0,
      _lease_seconds: leaseSeconds,
    });
    if (advanced !== true) { summary.leaseLost += 1; continue; }
    const { data: released } = await sb.rpc('fail_entitlement_fanout', {
      _id: job.id, _claim_token: job.claim_token, _worker_id: workerId,
      _error_code: 'fanout_requeued', _retry_seconds: 5, _max_attempts: 1000000,
    });
    if (released === true) summary.requeued += 1;
    else summary.leaseLost += 1;
  }

  return summary;
}
