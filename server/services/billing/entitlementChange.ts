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

export async function handleWorkspaceEntitlementChanged(
  config: ServerConfig,
  input: EntitlementChangeInput,
): Promise<EntitlementChangeResult> {
  const { workspaceId, source } = input;
  if (!workspaceId) return { ok: false, cacheCleared: false, catchupEnqueued: 0 };

  // 1. Entitlement cache must never outlive the change.
  clearEntitlementCache(workspaceId);

  // 2. Skip catch-up only for pure revocations, or when the caller explicitly
  //    says access did not transition false → true.
  const explicitNoGrant =
    input.previousEffectiveAccess === true && input.nextEffectiveAccess === true;
  if (REVOCATION_SOURCES.has(source) || explicitNoGrant) {
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
