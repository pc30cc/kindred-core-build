/**
 * Phase 6-S5-R3 — single entry point for "this workspace's entitlements
 * may have changed".
 *
 * Every real transition path (admin assign/revoke, payment success,
 * subscription create/upgrade/renew, provider webhook, workspace module or
 * channel override) funnels through here so deterministic catch-up is a
 * property of the system, not of individual call sites.
 *
 * Contract: NEVER throws. A billing/plan operation must not fail because the
 * AI index queue is unavailable — but the failure is returned and logged so
 * it stays observable, retryable and auditable.
 */
import type { ServerConfig } from '../../config.js';
import { clearEntitlementCache } from '../../middleware/featureGating.js';
import { enqueueKnowledgeBaseCatchup } from '../ai-agent/knowledgeIndex/kbEvents.js';

export type EntitlementChangeSource =
  | 'admin_assign'
  | 'admin_revoke'
  | 'admin_grant'
  | 'payment_succeeded'
  | 'subscription_created'
  | 'subscription_renewed'
  | 'subscription_canceled'
  | 'provider_webhook'
  | 'workspace_module_override'
  | 'workspace_channel_override'
  | 'workspace_limit_override'
  | 'plan_definition_updated'
  | 'trial_expired'
  | 'platform_ai_toggle';

export interface EntitlementChangeInput {
  workspaceId: string;
  source: EntitlementChangeSource;
  /** Optional hints; when omitted, catch-up is enqueued conservatively. */
  previousEffectiveAccess?: boolean;
  nextEffectiveAccess?: boolean;
}

export interface EntitlementChangeResult {
  ok: boolean;
  cacheCleared: boolean;
  catchupEnqueued: number;
  errorCode?: 'catchup_enqueue_failed';
}

/**
 * Sources that can only reduce access never need a catch-up enqueue —
 * the drain loop already defers their events.
 */
const REVOCATION_SOURCES = new Set<EntitlementChangeSource>([
  'admin_revoke',
  'subscription_canceled',
]);

/**
 * Phase 6-S5-R5 — sources that can never affect AI indexing eligibility,
 * provider execution or AI knowledge limits. Documented policy: a channel
 * override (widget/email/sms/voice availability) does not change whether the
 * `ai_assistant` module is entitled, so it must not schedule index catch-up.
 * Limit overrides only matter when the limit key feeds the AI index budget;
 * callers pass `limitKey` so this module can decide.
 */
const NON_AI_SOURCES = new Set<EntitlementChangeSource>([
  'workspace_channel_override',
]);

/** Limit keys that genuinely affect AI indexing eligibility/budget. */
export const AI_RELEVANT_LIMIT_KEYS = new Set<string>([
  'ai_knowledge_chunks_embedded',
  'ai_knowledge_sources',
  'ai_credits_monthly',
  'ai_kb_max_articles',
  'ai_kb_max_pages',
  'ai_kb_jobs_per_month',
]);

/**
 * Pure, exhaustively tested transition rule.
 *
 *   false → true   enqueue (access was just granted)
 *   true  → true   no enqueue for the transition alone
 *   true  → false  no enqueue (cache clear only; events defer naturally)
 *   false → false  no enqueue
 *   unknown        conservative idempotent enqueue when the source may grant
 *   pure revoke    never
 */
export function shouldEnqueueEntitlementCatchup(input: {
  previousEffectiveAccess?: boolean;
  nextEffectiveAccess?: boolean;
  source: EntitlementChangeSource;
  /** Only meaningful for `workspace_limit_override`. */
  limitKey?: string;
}): boolean {
  const { previousEffectiveAccess: prev, nextEffectiveAccess: next, source } = input;

  // A pure revocation source can never grant access.
  if (REVOCATION_SOURCES.has(source)) return false;

  // Sources structurally unrelated to AI indexing.
  if (NON_AI_SOURCES.has(source)) return false;
  if (source === 'workspace_limit_override') {
    if (!input.limitKey || !AI_RELEVANT_LIMIT_KEYS.has(input.limitKey)) return false;
  }

  // Known transition states.
  if (prev === false && next === true) return true;
  if (prev === true && next === true) return false;
  if (prev === true && next === false) return false;
  if (prev === false && next === false) return false;

  // Unknown / partially-known state: conservative idempotent enqueue.
  // `enqueue_kb_catchup` is idempotent, so a redundant call is harmless while
  // a missed one would silently strand the index.
  return true;
}

export async function handleWorkspaceEntitlementChanged(
  config: ServerConfig,
  input: EntitlementChangeInput & { limitKey?: string },
): Promise<EntitlementChangeResult> {
  const { workspaceId, source } = input;
  if (!workspaceId) return { ok: false, cacheCleared: false, catchupEnqueued: 0 };

  // 1. Entitlement cache must never outlive the change.
  clearEntitlementCache(workspaceId);

  // 2. Apply the pure transition rule.
  if (!shouldEnqueueEntitlementCatchup({
    previousEffectiveAccess: input.previousEffectiveAccess,
    nextEffectiveAccess: input.nextEffectiveAccess,
    source,
    limitKey: input.limitKey,
  })) {
    return { ok: true, cacheCleared: true, catchupEnqueued: 0 };
  }

  // 3. Idempotent catch-up; also re-arms deferred outbox events immediately.
  const catchup = await enqueueKnowledgeBaseCatchup(config, workspaceId);
  if (!catchup.ok) {
    console.error(
      '[billing.entitlementChange] catchup enqueue failed',
      JSON.stringify({ workspaceId, source }),
    );
    return {
      ok: false,
      cacheCleared: true,
      catchupEnqueued: 0,
      errorCode: 'catchup_enqueue_failed',
    };
  }
  return { ok: true, cacheCleared: true, catchupEnqueued: catchup.enqueued };
}

/**
 * Fan-out variant for changes that are NOT scoped to one workspace — editing
 * a plan definition or flipping a platform-level AI switch changes the
 * effective entitlements of every workspace on that plan at once.
 *
 * Never throws. Failures are counted and logged, not propagated.
 */
export async function handleBulkEntitlementChanged(
  config: ServerConfig,
  workspaceIds: string[],
  source: EntitlementChangeSource,
): Promise<{ ok: boolean; processed: number; failed: number }> {
  const unique = Array.from(new Set(workspaceIds.filter(Boolean)));
  let failed = 0;
  for (const workspaceId of unique) {
    const r = await handleWorkspaceEntitlementChanged(config, { workspaceId, source });
    if (!r.ok) failed += 1;
  }
  if (failed > 0) {
    console.error(
      '[billing.entitlementChange] bulk change partially failed',
      JSON.stringify({ source, total: unique.length, failed }),
    );
  }
  return { ok: failed === 0, processed: unique.length, failed };
}

/**
 * Phase 6-S5-R6 — non-workspace-scoped changes (plan definition edits, the
 * platform AI kill switch) are no longer fanned out in-process. They are
 * queued as DURABLE background jobs in `public.entitlement_fanout_jobs` and
 * drained by a lease-owning worker, so a deploy or crash can never lose the
 * remaining workspaces. See ./entitlementFanout.ts.
 */
export interface FanoutResult {
  ok: boolean;
  /** Durable job id, or null when nothing needed queueing. */
  jobId: string | null;
  /** True when the change provably cannot affect AI entitlements. */
  skipped: boolean;
  /** Always true now: fan-out never runs inside the HTTP request. */
  backgrounded: boolean;
  errorCode?: 'fanout_enqueue_failed';
}

/**
 * Fan-out for a plan-definition edit. Pass the plan row before and after the
 * write so a price/description-only edit is skipped.
 */
export async function handlePlanDefinitionChanged(
  config: ServerConfig,
  planId: string,
  diff: {
    previous?: import('./entitlementFanout.js').PlanDefinitionLike | null;
    next?: import('./entitlementFanout.js').PlanDefinitionLike | null;
  } = {},
): Promise<FanoutResult> {
  if (!planId) {
    return { ok: false, jobId: null, skipped: false, backgrounded: true, errorCode: 'fanout_enqueue_failed' };
  }
  const { enqueuePlanEntitlementFanout } = await import('./entitlementFanout.js');
  const r = await enqueuePlanEntitlementFanout(config, planId, diff);
  return { ...r, backgrounded: true };
}

/**
 * Fan-out for the platform AI kill switch. Only a genuine OFF → ON transition
 * can grant access, so the caller passes the transition and everything else is
 * skipped.
 */
export async function handlePlatformAiEnabled(
  config: ServerConfig,
  transition: { previousEnabled?: boolean; nextEnabled?: boolean } = {},
): Promise<FanoutResult> {
  const { enqueuePlatformEntitlementFanout } = await import('./entitlementFanout.js');
  const r = await enqueuePlatformEntitlementFanout(config, transition);
  return { ...r, backgrounded: true };
}
