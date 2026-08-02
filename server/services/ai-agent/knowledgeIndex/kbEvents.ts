/**
 * Phase 6-S5-R3 — asynchronous Knowledge Base → AI index bridge.
 *
 * The KB write path emits neutral rows into public.knowledge_base_change_events
 * via a database trigger. This consumer lives entirely on the AI side: it
 * claims those events under an owned, expiring lease and re-indexes affected
 * workspaces only when every required entitlement is satisfied.
 *
 * Direction is strictly one-way (KB → AI). A failure here can never surface
 * in, block, or roll back Knowledge Base CRUD.
 *
 * Durability contract:
 *   - Only the current lease owner (claim_token + worker id) may complete,
 *     defer or fail an event.
 *   - Plan-off / platform-off / provider-off are TEMPORARY conditions: the
 *     event is DEFERRED (processed_at stays NULL, attempts not incremented,
 *     never dead-lettered), not discarded.
 *   - Only real, repeated errors consume attempts and may dead-letter.
 */
import type { ServerConfig } from '../../../config.js';
import { getServiceClient } from '../../../supabase.js';
import { checkModuleAccess } from '../../../middleware/featureGating.js';
import { assertAiAgentPlatformEnabledForWorkspace } from '../platformGuards.js';
import { rebuildWorkspaceIndex } from './sync.js';

/** Canonical, sanitized outcome codes recorded on the outbox row. */
export type KbEventErrorCode =
  | 'ai_assistant_plan_required'
  | 'ai_platform_disabled'
  | 'ai_provider_unavailable'
  | 'entitlement_lookup_failed'
  | 'index_rebuild_failed'
  | 'workspace_deleted'
  | 'malformed_event';

/** Deferral backoff per temporary reason (seconds). */
const DEFER_SECONDS: Record<string, number> = {
  ai_assistant_plan_required: 4 * 60 * 60,
  ai_platform_disabled: 60 * 60,
  ai_provider_unavailable: 15 * 60,
  entitlement_lookup_failed: 5 * 60,
};

export interface KbEventClaim {
  id: string;
  workspaceId: string;
  eventType: string;
  attempts: number;
  claimToken: string;
  claimExpiresAt: string;
}

interface RawClaimRow {
  id: string;
  workspace_id: string;
  event_type: string;
  attempts: number;
  claim_token: string;
  claim_expires_at: string;
}

export interface KbEventDrainSummary {
  claimed: number;
  /** Events transitioned to processed (exact RPC-confirmed count). */
  completed: number;
  reindexedWorkspaces: number;
  deferred: number;
  failed: number;
  leaseLost: number;
  deferralReasons: Partial<Record<KbEventErrorCode, number>>;
}

export interface CatchupResult {
  ok: boolean;
  enqueued: number;
  errorCode?: 'catchup_enqueue_failed';
}

function log(event: string, data: Record<string, unknown>): void {
  try {
    console.warn(`[ai-agent.kbEvents] ${event}`, JSON.stringify(data));
  } catch {
    console.warn(`[ai-agent.kbEvents] ${event}`);
  }
}

// ─── Owned lease transitions ────────────────────────────────

/**
 * Phase 6-S5-R5 — exact partial-transition accounting.
 *
 *   updated === requested        → full success
 *   updated === 0                → every id lost its lease
 *   0 < updated < requested      → partial success, remainder lease-lost
 *   updated > requested          → invariant violation (defensive clamp)
 */
export function accountOwnedTransition(
  requested: number,
  updated: number,
): { succeeded: number; leaseLost: number; invariantViolation: boolean } {
  const safeRequested = Math.max(0, requested);
  const safeUpdated = Math.max(0, updated);
  if (safeUpdated > safeRequested) {
    log('lease_transition_invariant_violation', {
      requested: safeRequested, updated: safeUpdated,
    });
    return { succeeded: safeRequested, leaseLost: 0, invariantViolation: true };
  }
  return {
    succeeded: safeUpdated,
    leaseLost: safeRequested - safeUpdated,
    invariantViolation: false,
  };
}

async function completeOwned(
  config: ServerConfig, token: string, workerId: string, ids: string[],
): Promise<number> {
  if (ids.length === 0) return 0;
  const { data, error } = await getServiceClient(config).rpc('complete_kb_change_events', {
    _claim_token: token, _worker_id: workerId, _ids: ids,
  });
  if (error) { log('complete_failed', { workerId, count: ids.length }); return 0; }
  return typeof data === 'number' ? data : 0;
}

async function deferOwned(
  config: ServerConfig, token: string, workerId: string, ids: string[],
  code: KbEventErrorCode,
): Promise<number> {
  if (ids.length === 0) return 0;
  const { data, error } = await getServiceClient(config).rpc('defer_kb_change_events', {
    _claim_token: token,
    _worker_id: workerId,
    _ids: ids,
    _error_code: code,
    _retry_seconds: DEFER_SECONDS[code] ?? 300,
  });
  if (error) { log('defer_failed', { workerId, code }); return 0; }
  return typeof data === 'number' ? data : 0;
}

async function failOwned(
  config: ServerConfig, token: string, workerId: string, ids: string[],
  code: KbEventErrorCode, detail: string, permanent: boolean,
): Promise<number> {
  if (ids.length === 0) return 0;
  const { data, error } = await getServiceClient(config).rpc('fail_kb_change_events', {
    _claim_token: token,
    _worker_id: workerId,
    _ids: ids,
    _error_code: code,
    _error_detail: detail.slice(0, 500),
    _retry_seconds: 60,
    _permanent: permanent,
  });
  if (error) { log('fail_failed', { workerId, code }); return 0; }
  return typeof data === 'number' ? data : 0;
}

function classifyRebuildError(error: unknown): { code: KbEventErrorCode; permanent: boolean } {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (message.includes('workspace') && message.includes('not found')) {
    return { code: 'workspace_deleted', permanent: true };
  }
  if (message.includes('invalid input syntax for type uuid')) {
    return { code: 'malformed_event', permanent: true };
  }
  return { code: 'index_rebuild_failed', permanent: false };
}

/**
 * Drains one batch of pending KB change events. Never throws.
 */
export async function drainKnowledgeBaseChangeEvents(
  config: ServerConfig,
  opts: { batchSize?: number; workerId?: string; leaseSeconds?: number } = {},
): Promise<KbEventDrainSummary> {
  const summary: KbEventDrainSummary = {
    claimed: 0, completed: 0, reindexedWorkspaces: 0, deferred: 0, failed: 0, leaseLost: 0,
    deferralReasons: {},
  };
  const workerId = opts.workerId ?? process.env.WORKER_ID ?? 'kb-drain';
  const sb = getServiceClient(config);

  const { data, error } = await sb.rpc('claim_kb_change_events', {
    _worker_id: workerId,
    _limit: Math.min(Math.max(opts.batchSize ?? 100, 1), 500),
    _lease_seconds: Math.max(opts.leaseSeconds ?? 300, 30),
  });
  if (error || !data || (data as RawClaimRow[]).length === 0) return summary;

  const claims: KbEventClaim[] = (data as unknown as RawClaimRow[]).map((row) => ({
    id: row.id,
    workspaceId: row.workspace_id,
    eventType: row.event_type,
    attempts: row.attempts,
    claimToken: row.claim_token,
    claimExpiresAt: row.claim_expires_at,
  }));
  summary.claimed = claims.length;

  // Phase 6-S5-R5 — group by (workspace_id, claim_token). The claim RPC may
  // return rows carrying DIFFERENT tokens; completing an id with a token that
  // did not claim it would silently lose the event. Each token is its own
  // owned group, even for the same workspace.
  const byOwnedGroup = new Map<
    string,
    { workspaceId: string; token: string; ids: string[] }
  >();
  for (const claim of claims) {
    const key = `${claim.workspaceId}::${claim.claimToken}`;
    const entry = byOwnedGroup.get(key)
      ?? { workspaceId: claim.workspaceId, token: claim.claimToken, ids: [] };
    entry.ids.push(claim.id);
    byOwnedGroup.set(key, entry);
  }

  const defer = async (
    workspaceId: string, token: string, ids: string[], code: KbEventErrorCode,
  ) => {
    const n = await deferOwned(config, token, workerId, ids, code);
    const acct = accountOwnedTransition(ids.length, n);
    summary.leaseLost += acct.leaseLost;
    if (acct.succeeded === 0) return;
    summary.deferred += acct.succeeded;
    summary.deferralReasons[code] =
      (summary.deferralReasons[code] ?? 0) + acct.succeeded;
    log('event_deferred', {
      workspaceId, code, count: acct.succeeded, leaseLost: acct.leaseLost,
    });
  };

  for (const { workspaceId, token, ids } of byOwnedGroup.values()) {
    // 1. Module — `ai_assistant` ONLY. Phase 6-S5-R4: the Knowledge Base itself
    //    is never plan-gated; only AI indexing of it is. Fail closed, and defer
    //    (never discard) on lookup error.
    let moduleDenial: KbEventErrorCode | null = null;
    let lookupFailed = false;
    try {
      const r = await checkModuleAccess(
        config.supabaseUrl, config.supabaseServiceRoleKey, workspaceId, 'ai_assistant',
      );
      if (r.reason === 'rpc_error' || r.reason === 'exception') lookupFailed = true;
      else if (r.allowed !== true) moduleDenial = 'ai_assistant_plan_required';
    } catch {
      lookupFailed = true;
    }
    if (lookupFailed) { await defer(workspaceId, token, ids, 'entitlement_lookup_failed'); continue; }
    if (moduleDenial) { await defer(workspaceId, token, ids, moduleDenial); continue; }

    // 2. Platform AI kill switch / per-workspace AI source disabled.
    const platform = await assertAiAgentPlatformEnabledForWorkspace(config, workspaceId);
    if (!platform.ok) { await defer(workspaceId, token, ids, 'ai_platform_disabled'); continue; }

    // 3. Rebuild with full reconciliation.
    try {
      const result = await rebuildWorkspaceIndex(config, workspaceId);
      if (!result.ok || result.terminalState !== 'completed') {
        // A skipped reconciliation sweep is a real (retryable) failure, not a
        // provider outage: it consumes attempts so it stays observable.
        if (result.terminalState === 'failed') {
          const n = await failOwned(
            config, token, workerId, ids, 'index_rebuild_failed',
            result.errorCode ?? 'rebuild prerequisites unavailable', false,
          );
          const acct = accountOwnedTransition(ids.length, n);
          summary.leaseLost += acct.leaseLost;
          summary.failed += acct.succeeded;
          if (acct.succeeded > 0) {
            log('event_failed', {
              workspaceId,
              code: 'index_rebuild_failed',
              rebuildErrorCode: result.errorCode ?? null,
              count: acct.succeeded,
              leaseLost: acct.leaseLost,
            });
          }
          continue;
        }
        await defer(workspaceId, token, ids, 'ai_provider_unavailable');
        continue;
      }
      const n = await completeOwned(config, token, workerId, ids);
      const acct = accountOwnedTransition(ids.length, n);
      summary.leaseLost += acct.leaseLost;
      summary.completed += acct.succeeded;
      // A workspace counts as reindexed ONLY when every claimed id in this
      // owned group was actually completed.
      if (acct.succeeded === ids.length && ids.length > 0) {
        summary.reindexedWorkspaces += 1;
      }
    } catch (error: unknown) {
      const { code, permanent } = classifyRebuildError(error);
      const detail = error instanceof Error ? error.message : String(error);
      const n = await failOwned(config, token, workerId, ids, code, detail, permanent);
      const acct = accountOwnedTransition(ids.length, n);
      summary.leaseLost += acct.leaseLost;
      summary.failed += acct.succeeded;
      if (acct.succeeded > 0) {
        log('event_failed', {
          workspaceId, code, permanent, count: acct.succeeded, leaseLost: acct.leaseLost,
        });
      }
    }
  }

  return summary;
}

/**
 * Deterministic catch-up after an entitlement change: enqueues a single
 * idempotent `catchup` outbox event and makes deferred events for the
 * workspace immediately eligible again.
 *
 * Never throws — indexing must not be able to fail a billing/plan operation —
 * but the failure IS surfaced in the return value and logged, so callers can
 * audit and retry.
 */
export async function enqueueKnowledgeBaseCatchup(
  config: ServerConfig,
  workspaceId: string,
): Promise<CatchupResult> {
  try {
    const { data, error } = await getServiceClient(config)
      .rpc('enqueue_kb_catchup', { _workspace_id: workspaceId });
    if (error) {
      log('catchup_enqueue_failed', { workspaceId, code: error.code ?? 'rpc_error' });
      return { ok: false, enqueued: 0, errorCode: 'catchup_enqueue_failed' };
    }
    return { ok: true, enqueued: typeof data === 'number' ? data : 0 };
  } catch (error: unknown) {
    log('catchup_enqueue_exception', {
      workspaceId,
      message: (error instanceof Error ? error.message : String(error)).slice(0, 200),
    });
    return { ok: false, enqueued: 0, errorCode: 'catchup_enqueue_failed' };
  }
}
