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
 * Resolves every workspace currently subscribed to a plan, then funnels the
 * change. Used when a plan's modules/features/limits are edited.
 */

/** Page size for every fan-out cursor. Bounded memory, deterministic order. */
export const FANOUT_PAGE_SIZE = 500;
/**
 * Above this many affected workspaces the fan-out is detached from the HTTP
 * request so an admin save never blocks on thousands of catch-up enqueues.
 */
export const FANOUT_INLINE_THRESHOLD = 200;

export interface FanoutResult {
  ok: boolean;
  processed: number;
  failed: number;
  /** True when the remaining work was detached to a background task. */
  backgrounded: boolean;
  pages: number;
  errorCode?: 'fanout_lookup_failed';
}

type PageReader = (
  offset: number,
  limit: number,
) => Promise<{ ids: string[]; error: boolean }>;

/**
 * Shared paginated fan-out driver. Pages with a deterministic order until a
 * short page is returned; deduplicates ids; never loads an unbounded set into
 * memory; detaches to the background once the inline threshold is exceeded.
 */
async function runPaginatedFanout(
  config: ServerConfig,
  readPage: PageReader,
  source: EntitlementChangeSource,
  opts: { inlineThreshold?: number } = {},
): Promise<FanoutResult> {
  const inlineThreshold = opts.inlineThreshold ?? FANOUT_INLINE_THRESHOLD;
  const seen = new Set<string>();
  const result: FanoutResult = {
    ok: true, processed: 0, failed: 0, backgrounded: false, pages: 0,
  };

  let offset = 0;
  for (;;) {
    const page = await readPage(offset, FANOUT_PAGE_SIZE);
    if (page.error) {
      console.error(
        '[billing.entitlementChange] fan-out lookup failed',
        JSON.stringify({ source, offset }),
      );
      return { ...result, ok: false, errorCode: 'fanout_lookup_failed' };
    }
    result.pages += 1;
    const fresh = page.ids.filter((id) => id && !seen.has(id));
    for (const id of fresh) seen.add(id);

    if (result.processed + fresh.length > inlineThreshold) {
      // Detach the remainder — including this page — from the caller.
      result.backgrounded = true;
      const startOffset = offset;
      void (async () => {
        try {
          await drainRemainder(config, readPage, source, seen, startOffset);
        } catch (error: unknown) {
          console.error(
            '[billing.entitlementChange] background fan-out crashed',
            JSON.stringify({ source, message: safeMessage(error) }),
          );
        }
      })();
      return result;
    }

    for (const workspaceId of fresh) {
      const r = await handleWorkspaceEntitlementChanged(config, { workspaceId, source });
      result.processed += 1;
      if (!r.ok) result.failed += 1;
    }

    if (page.ids.length < FANOUT_PAGE_SIZE) break;
    offset += FANOUT_PAGE_SIZE;
  }

  result.ok = result.failed === 0;
  return result;
}

async function drainRemainder(
  config: ServerConfig,
  readPage: PageReader,
  source: EntitlementChangeSource,
  seen: Set<string>,
  startOffset: number,
): Promise<void> {
  let offset = startOffset;
  let processed = 0;
  let failed = 0;
  for (;;) {
    const page = await readPage(offset, FANOUT_PAGE_SIZE);
    if (page.error) {
      console.error(
        '[billing.entitlementChange] background fan-out page failed',
        JSON.stringify({ source, offset }),
      );
      return;
    }
    for (const workspaceId of page.ids) {
      if (!workspaceId) continue;
      const first = !seen.has(workspaceId);
      seen.add(workspaceId);
      if (!first && offset !== startOffset) continue;
      const r = await handleWorkspaceEntitlementChanged(config, { workspaceId, source });
      processed += 1;
      if (!r.ok) failed += 1;
    }
    if (page.ids.length < FANOUT_PAGE_SIZE) break;
    offset += FANOUT_PAGE_SIZE;
  }
  console.warn(
    '[billing.entitlementChange] background fan-out finished',
    JSON.stringify({ source, processed, failed }),
  );
}

function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 200);
}

/**
 * Fan-out for a plan-definition edit: every workspace currently assigned to
 * the plan. Paginated, deduplicated, backgrounded above the inline threshold.
 */
export async function handlePlanDefinitionChanged(
  config: ServerConfig,
  planId: string,
): Promise<FanoutResult> {
  if (!planId) {
    return { ok: false, processed: 0, failed: 0, backgrounded: false, pages: 0 };
  }
  const { getServiceClient } = await import('../../supabase.js');
  const sb = getServiceClient(config);
  const readPage: PageReader = async (offset, limit) => {
    try {
      const { data, error } = await sb
        .from('workspace_subscriptions')
        .select('workspace_id')
        .eq('plan_id', planId)
        .order('workspace_id', { ascending: true })
        .range(offset, offset + limit - 1);
      if (error) return { ids: [], error: true };
      return {
        ids: (data || []).map((r) => (r as { workspace_id: string }).workspace_id),
        error: false,
      };
    } catch {
      return { ids: [], error: true };
    }
  };
  return runPaginatedFanout(config, readPage, 'plan_definition_updated');
}

/**
 * Fan-out for the platform AI kill switch turning back ON.
 *
 * The authoritative source is `public.workspaces` — a workspace may have no
 * `ai_agent_settings` row yet and would otherwise be silently skipped.
 */
export async function handlePlatformAiEnabled(
  config: ServerConfig,
): Promise<FanoutResult> {
  const { getServiceClient } = await import('../../supabase.js');
  const sb = getServiceClient(config);
  const readPage: PageReader = async (offset, limit) => {
    try {
      const { data, error } = await sb
        .from('workspaces')
        .select('id')
        .order('id', { ascending: true })
        .range(offset, offset + limit - 1);
      if (error) return { ids: [], error: true };
      return { ids: (data || []).map((r) => (r as { id: string }).id), error: false };
    } catch {
      return { ids: [], error: true };
    }
  };
  // Platform-wide fan-out is always detached from the admin HTTP request.
  return runPaginatedFanout(config, readPage, 'platform_ai_toggle', {
    inlineThreshold: 0,
  });
}
