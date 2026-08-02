/**
 * Phase 6-S5-R7 — LOSSLESS durable entitlement fan-out.
 *
 * R6 made the work durable. R7 makes it lossless and honest:
 *
 *   - GENERATIONS: a relevant change arriving while a pass is already
 *     partially consumed increments `requested_generation`. The running pass
 *     may not acknowledge it; completion detects the newer generation and
 *     requeues a full rescan from the beginning.
 *   - SUCCESS-BOUNDARY CURSOR: the cursor is the last workspace whose required
 *     action SUCCEEDED — never the last attempted. A retryable failure stops
 *     the page immediately so nothing after it is skipped.
 *   - ELIGIBILITY FILTERING: catch-up is enqueued only for workspaces with
 *     effective `ai_assistant` access. Knowledge Base and `ai_kb_builder`
 *     never take part in index eligibility.
 *   - EXPLICIT COUNTERS: processed / skipped-ineligible / retryable / permanent
 *     are tracked separately, and the FINAL page is persisted by the same
 *     atomic Complete call.
 *
 * Never throws to a billing caller: a queueing failure is reported, not
 * propagated.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { checkModuleAccess, clearEntitlementCache } from '../../middleware/featureGating.js';
import { enqueueKnowledgeBaseCatchup } from '../ai-agent/knowledgeIndex/kbEvents.js';
import { AI_RELEVANT_LIMIT_KEYS, type EntitlementChangeSource } from './entitlementChange.js';

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
//  AI relevance diff — R7 defect 4
// ─────────────────────────────────────────────────────────────

/**
 * The ONLY entitlement whose value decides whether a workspace may run AI
 * index maintenance.
 *
 * `knowledge_base` is deliberately absent — the Knowledge Base is a core
 * product and is never plan-gated. `ai_kb_builder` is deliberately absent too:
 * it gates AI-assisted CONTENT GENERATION, not the index worker, so granting
 * it must not trigger a workspace-wide re-index (R7 §4.2).
 */
export const AI_INDEX_ENTITLEMENT_KEY = 'ai_assistant' as const;

/**
 * Kept for backwards compatibility with existing imports/tests.
 * @deprecated use AI_INDEX_ENTITLEMENT_KEY.
 */
export const AI_RELEVANT_ENTITLEMENT_KEYS = [AI_INDEX_ENTITLEMENT_KEY] as const;

export interface PlanDefinitionLike {
  is_active?: boolean | null;
  entitlements?: Record<string, unknown> | null;
  limits?: Record<string, unknown> | null;
}

export type AiPlanChangeReason =
  | 'ai_assistant_granted'
  | 'ai_assistant_revoked'
  | 'plan_activated'
  | 'plan_deactivated'
  | 'index_limit_changed'
  | 'unknown_previous_state';

export interface AiPlanChangeImpact {
  changed: boolean;
  accessMayBeGranted: boolean;
  accessRevoked: boolean;
  reindexRequired: boolean;
  reasons: AiPlanChangeReason[];
  changeHash: string;
}

function readFlag(source: Record<string, unknown> | null | undefined, key: string): unknown {
  if (!source) return undefined;
  const raw = source[key];
  if (raw && typeof raw === 'object' && 'enabled' in (raw as Record<string, unknown>)) {
    return (raw as Record<string, unknown>).enabled;
  }
  return raw;
}

function stableHash(input: string): string {
  let h = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Classify a plan-definition edit. Display-only and billing-only fields
 * (name, description, localized copy, price, currency, sort order, provider
 * price ids, trial copy) are structurally absent from this calculation, so
 * they can never produce a fan-out.
 */
export function classifyAiPlanChange(
  previous: PlanDefinitionLike | null | undefined,
  next: PlanDefinitionLike | null | undefined,
): AiPlanChangeImpact {
  const reasons: AiPlanChangeReason[] = [];
  let accessMayBeGranted = false;
  let accessRevoked = false;
  let reindexRequired = false;

  if (!previous || !next) {
    // Unknown state: conservative. A missed grant silently strands the index.
    return {
      changed: true,
      accessMayBeGranted: true,
      accessRevoked: false,
      reindexRequired: true,
      reasons: ['unknown_previous_state'],
      changeHash: stableHash('unknown'),
    };
  }

  const prevActive = previous.is_active !== false;
  const nextActive = next.is_active !== false;
  if (!prevActive && nextActive) {
    accessMayBeGranted = true; reindexRequired = true; reasons.push('plan_activated');
  } else if (prevActive && !nextActive) {
    accessRevoked = true; reasons.push('plan_deactivated');
  }

  const prevAi = !!readFlag(previous.entitlements, AI_INDEX_ENTITLEMENT_KEY);
  const nextAi = !!readFlag(next.entitlements, AI_INDEX_ENTITLEMENT_KEY);
  if (!prevAi && nextAi) {
    accessMayBeGranted = true; reindexRequired = true; reasons.push('ai_assistant_granted');
  } else if (prevAi && !nextAi) {
    accessRevoked = true; reasons.push('ai_assistant_revoked');
  }

  const limitParts: string[] = [];
  for (const key of AI_RELEVANT_LIMIT_KEYS) {
    const a = previous.limits?.[key];
    const b = next.limits?.[key];
    if (a === undefined && b === undefined) continue;
    if (a !== b) {
      limitParts.push(`${key}:${String(a)}>${String(b)}`);
      if (!reasons.includes('index_limit_changed')) reasons.push('index_limit_changed');
      reindexRequired = true;
    }
  }

  // A pure revocation never needs a rebuild sweep.
  if (accessRevoked && !accessMayBeGranted) reindexRequired = false;

  return {
    changed: reasons.length > 0,
    accessMayBeGranted,
    accessRevoked,
    reindexRequired,
    reasons,
    changeHash: stableHash(
      `${prevActive}>${nextActive}|${prevAi}>${nextAi}|${limitParts.sort().join(',')}`,
    ),
  };
}

/**
 * Backwards-compatible boolean predicate. Prefer `classifyAiPlanChange`.
 * A fan-out job is only ever needed when a rebuild is required.
 */
export function planChangeAffectsAiEntitlements(
  previous: PlanDefinitionLike | null | undefined,
  next: PlanDefinitionLike | null | undefined,
): boolean {
  return classifyAiPlanChange(previous, next).reindexRequired;
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
 * Only a change that can GRANT access or move an AI index limit queues a job.
 * A revocation, a deactivation or a price/description edit clears caches
 * (handled by the caller) and queues nothing.
 */
export async function enqueuePlanEntitlementFanout(
  config: ServerConfig,
  planId: string,
  diff: { previous?: PlanDefinitionLike | null; next?: PlanDefinitionLike | null } = {},
  source: EntitlementChangeSource = 'plan_definition_updated',
): Promise<EnqueueFanoutResult & { impact?: AiPlanChangeImpact }> {
  if (!planId) {
    return { ok: false, jobId: null, skipped: false, errorCode: 'fanout_enqueue_failed' };
  }
  if (diff.previous !== undefined && diff.next !== undefined) {
    const impact = classifyAiPlanChange(diff.previous, diff.next);
    if (!impact.reindexRequired) {
      return { ok: true, jobId: null, skipped: true, impact };
    }
    return { ...(await enqueue(config, 'plan', source, planId)), impact };
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
  requested_generation: number | string;
  processing_generation: number | string;
  claim_token: string;
  claim_expires_at: string;
}

export interface FanoutDrainSummary {
  claimed: number;
  /** Workspaces whose catch-up was enqueued successfully. */
  processed: number;
  /** Workspaces deliberately skipped: no effective ai_assistant access. */
  skippedIneligible: number;
  /** Workspaces left ahead of the cursor for a later retry. */
  retryableFailures: number;
  /** Workspaces skipped permanently after durable recording. */
  permanentFailures: number;
  completed: number;
  requeuedNewGeneration: number;
  requeued: number;
  leaseLost: number;
  lookupFailures: number;
  /** @deprecated ambiguous; kept so existing dashboards keep parsing. */
  failed: number;
}

export type WorkspaceEligibility =
  | { kind: 'eligible' }
  | { kind: 'ineligible'; reason: string }
  | { kind: 'lookup_failed'; reason: string };

/**
 * Canonical eligibility resolution for AI INDEX MAINTENANCE.
 *
 * Requires effective `ai_assistant` only. It deliberately does NOT consult
 * `knowledge_base` (always available), `ai_kb_builder` (content generation
 * only) or `customer_ai_agent_visible` (customer UI surface only).
 */
export async function resolveFanoutEligibility(
  config: ServerConfig,
  workspaceId: string,
): Promise<WorkspaceEligibility> {
  // The change that triggered this fan-out invalidates any cached verdict.
  clearEntitlementCache(workspaceId);
  let access: { allowed?: boolean; reason?: string };
  try {
    access = await checkModuleAccess(
      config.supabaseUrl,
      config.supabaseServiceRoleKey,
      workspaceId,
      'ai_assistant',
    );
  } catch {
    return { kind: 'lookup_failed', reason: 'exception' };
  }
  if (!access || typeof access.allowed !== 'boolean') {
    return { kind: 'lookup_failed', reason: 'invalid_entitlement_response' };
  }
  // `rpc_error` / `exception` are transport failures, NOT normal denials.
  if (!access.allowed && (access.reason === 'rpc_error' || access.reason === 'exception')) {
    return { kind: 'lookup_failed', reason: access.reason };
  }
  return access.allowed
    ? { kind: 'eligible' }
    : { kind: 'ineligible', reason: access.reason || 'not_entitled' };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface FanoutDrainOptions {
  workerId?: string;
  limit?: number;
  leaseSeconds?: number;
  /** Test seam: smaller pages make final-page accounting observable. */
  pageSize?: number;
  pagesPerLease?: number;
  /** Test seam: injectable eligibility resolution. */
  resolveEligibility?: (workspaceId: string) => Promise<WorkspaceEligibility>;
  /** Test seam: injectable catch-up handler. */
  enqueueCatchup?: (workspaceId: string) => Promise<{ ok: boolean }>;
}

/**
 * Deterministic keyset page. Ordering is by primary key so the cursor is
 * total, stable and immune to concurrent inserts/deletes.
 */
async function readKeysetPage(
  config: ServerConfig,
  job: ClaimRow,
  cursor: string | null,
  pageSize: number,
): Promise<{ ids: string[]; error: boolean }> {
  const sb = getServiceClient(config);
  try {
    if (job.scope === 'plan') {
      let q = sb
        .from('workspace_subscriptions')
        .select('workspace_id')
        .eq('plan_id', job.plan_id as string)
        .order('workspace_id', { ascending: true })
        .limit(pageSize);
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
      .limit(pageSize);
    if (cursor) q = q.gt('id', cursor);
    const { data, error } = await q;
    if (error) return { ids: [], error: true };
    return { ids: (data || []).map((r) => (r as { id: string }).id), error: false };
  } catch {
    return { ids: [], error: true };
  }
}

/** Per-page outcome accounting that has not yet been persisted. */
interface PendingProgress {
  processed: number;
  skippedIneligible: number;
  retryableFailures: number;
  permanentFailures: number;
}

const zeroProgress = (): PendingProgress => ({
  processed: 0, skippedIneligible: 0, retryableFailures: 0, permanentFailures: 0,
});

/**
 * Drains claimable fan-out jobs. Never throws.
 */
export async function drainEntitlementFanoutJobs(
  config: ServerConfig,
  opts: FanoutDrainOptions = {},
): Promise<FanoutDrainSummary> {
  const summary: FanoutDrainSummary = {
    claimed: 0, processed: 0, skippedIneligible: 0, retryableFailures: 0,
    permanentFailures: 0, completed: 0, requeuedNewGeneration: 0, requeued: 0,
    leaseLost: 0, lookupFailures: 0, failed: 0,
  };
  const workerId = opts.workerId ?? process.env.WORKER_ID ?? 'entitlement-fanout';
  const leaseSeconds = Math.max(opts.leaseSeconds ?? FANOUT_LEASE_SECONDS, 30);
  const pageSize = Math.max(opts.pageSize ?? FANOUT_KEYSET_PAGE_SIZE, 1);
  const pagesPerLease = Math.max(opts.pagesPerLease ?? FANOUT_PAGES_PER_LEASE, 1);
  const sb = getServiceClient(config);

  const resolveEligibility =
    opts.resolveEligibility ?? ((id: string) => resolveFanoutEligibility(config, id));
  const enqueueCatchup =
    opts.enqueueCatchup ?? (async (id: string) => enqueueKnowledgeBaseCatchup(config, id));

  const { data, error } = await sb.rpc('claim_entitlement_fanout_jobs', {
    _worker_id: workerId,
    _limit: Math.min(Math.max(opts.limit ?? 1, 1), 5),
    _lease_seconds: leaseSeconds,
  });
  if (error || !data) return summary;

  const jobs = data as unknown as ClaimRow[];
  summary.claimed = jobs.length;

  for (const job of jobs) {
    const generation = Number(job.processing_generation ?? job.requested_generation ?? 1);

    const release = async (code: string, retrySeconds: number, maxAttempts: number) => {
      const { data: released } = await sb.rpc('fail_entitlement_fanout', {
        _id: job.id, _claim_token: job.claim_token, _worker_id: workerId,
        _generation: generation, _error_code: code,
        _retry_seconds: retrySeconds, _max_attempts: maxAttempts,
      });
      if (released !== true) summary.leaseLost += 1;
    };

    if (job.scope === 'plan' && !job.plan_id) {
      await release('malformed_job', 3600, 1);
      summary.permanentFailures += 1;
      summary.failed += 1;
      continue;
    }

    // Cursor semantics (R7 §2): the last workspace whose required action
    // SUCCEEDED. Never the last attempted.
    let lastSuccessfulCursor: string | null = job.cursor_workspace_id;
    let pending = zeroProgress();
    let pages = 0;
    let done = false;
    let aborted = false;
    let retryableStop = false;

    /** Persist the successful prefix. Returns false when the lease is gone. */
    const checkpoint = async (): Promise<boolean> => {
      const hasProgress =
        pending.processed || pending.skippedIneligible ||
        pending.retryableFailures || pending.permanentFailures ||
        lastSuccessfulCursor !== job.cursor_workspace_id;
      if (!hasProgress) return true;
      const { data: advanced, error: advErr } = await sb.rpc('advance_entitlement_fanout', {
        _id: job.id, _claim_token: job.claim_token, _worker_id: workerId,
        _generation: generation,
        _cursor_workspace_id: lastSuccessfulCursor,
        _processed: pending.processed,
        _skipped_ineligible: pending.skippedIneligible,
        _retryable_failures: pending.retryableFailures,
        _permanent_failures: pending.permanentFailures,
        _lease_seconds: leaseSeconds,
      });
      if (advErr || advanced !== true) return false;
      pending = zeroProgress();
      return true;
    };

    while (pages < pagesPerLease) {
      const page = await readKeysetPage(config, job, lastSuccessfulCursor, pageSize);
      if (page.error) {
        summary.lookupFailures += 1;
        await checkpoint();
        await release('fanout_lookup_failed', 300, 10);
        aborted = true;
        break;
      }
      pages += 1;

      for (const workspaceId of page.ids) {
        if (!workspaceId || !UUID_RE.test(workspaceId)) {
          // Genuinely permanent: a malformed reference can never succeed.
          pending.permanentFailures += 1;
          summary.permanentFailures += 1;
          continue;
        }

        const eligibility = await resolveEligibility(workspaceId);
        if (eligibility.kind === 'lookup_failed') {
          // NOT a denial and NOT permanent — leave this workspace ahead of
          // the cursor and stop the page immediately.
          pending.retryableFailures += 1;
          summary.retryableFailures += 1;
          retryableStop = true;
          break;
        }
        if (eligibility.kind === 'ineligible') {
          pending.skippedIneligible += 1;
          summary.skippedIneligible += 1;
          lastSuccessfulCursor = workspaceId;
          continue;
        }

        const r = await enqueueCatchup(workspaceId);
        if (!r.ok) {
          pending.retryableFailures += 1;
          summary.retryableFailures += 1;
          retryableStop = true;
          break;
        }
        pending.processed += 1;
        summary.processed += 1;
        lastSuccessfulCursor = workspaceId;
      }

      if (retryableStop) {
        if (!(await checkpoint())) { summary.leaseLost += 1; aborted = true; break; }
        await release('fanout_workspace_retryable', 30, 1000000);
        aborted = true;
        break;
      }

      if (page.ids.length < pageSize) { done = true; break; }

      if (!(await checkpoint())) { summary.leaseLost += 1; aborted = true; break; }
    }

    if (aborted) continue;

    if (done) {
      // R7 §5 — the FINAL page's cursor and counters are persisted by the same
      // atomic Complete call, so a short last page can never lose progress.
      const { data: outcome, error: completeErr } = await sb.rpc('complete_entitlement_fanout', {
        _id: job.id, _claim_token: job.claim_token, _worker_id: workerId,
        _generation: generation,
        _cursor_workspace_id: lastSuccessfulCursor,
        _processed: pending.processed,
        _skipped_ineligible: pending.skippedIneligible,
        _retryable_failures: pending.retryableFailures,
        _permanent_failures: pending.permanentFailures,
      });
      if (completeErr) { summary.leaseLost += 1; continue; }
      if (outcome === 'completed') summary.completed += 1;
      else if (outcome === 'requeued_new_generation') summary.requeuedNewGeneration += 1;
      else summary.leaseLost += 1;
      continue;
    }

    // Lease budget exhausted with work remaining: checkpoint and re-queue.
    if (!(await checkpoint())) { summary.leaseLost += 1; continue; }
    const { data: released } = await sb.rpc('fail_entitlement_fanout', {
      _id: job.id, _claim_token: job.claim_token, _worker_id: workerId,
      _generation: generation, _error_code: 'fanout_requeued',
      _retry_seconds: 5, _max_attempts: 1000000,
    });
    if (released === true) summary.requeued += 1;
    else summary.leaseLost += 1;
  }

  return summary;
}
