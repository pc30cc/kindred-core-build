/**
 * Conversation limit enforcement.
 *
 * Two entry points over ONE decision:
 *
 *   checkMaxConversationsAllowance(config, workspaceId)
 *     Pure, transport-free. Returns the decision so non-HTTP callers
 *     (the AI intro service, workers) can respect the cap without an
 *     Express req/res pair. No ad-hoc counting: it reuses the same
 *     entitlement RPC and the same `usage_counters` resolver the
 *     middleware uses.
 *
 *   enforceMaxConversationsLimit(req, res)
 *     The Express wrapper around that decision, used on actual
 *     conversation-creation branches (widget first-message, widget
 *     offline-message capture, operator-initiated outreach). It MUST NOT
 *     be attached to:
 *
 *       - `POST /api/conversations/send-message` (replies, not creation)
 *       - the existing-conversation branch of `POST /api/widget/message`
 *       - any non-creation widget endpoint
 *
 * Both are fail-closed: an unreadable entitlement or unreadable usage
 * denies the creation (as a retryable condition), it never silently
 * allows it.
 *
 * `enforceMaxConversationsLimit` returns `true` when the request may
 * proceed, `false` when the middleware has already written its response.
 * Callers must `return` immediately when `false`.
 */

import type { Request, Response } from 'express';
import type { ServerConfig } from '../../config.js';
import { requireLimit, checkEntitlementFromDB } from '../../middleware/featureGating.js';
import { isUnreadableEntitlementReason } from './entitlementParse.js';
import { usageFnForLimit, resolveUsage } from './usageResolvers.js';

const LIMIT_KEY = 'max_conversations';

const conversationLimitMiddleware = requireLimit(
  LIMIT_KEY,
  usageFnForLimit(LIMIT_KEY),
);

export interface ConversationAllowance {
  allowed: boolean;
  /** 'ok' | 'not_in_plan' | 'limit_reached' | 'entitlement_unavailable' | 'usage_unavailable' */
  reason: 'ok' | 'not_in_plan' | 'limit_reached' | 'entitlement_unavailable' | 'usage_unavailable';
  /** True when denial is a transient/unknown state rather than a plan verdict. */
  retryable: boolean;
  plan?: string;
  limit?: number;
  used?: number;
}

/**
 * Transport-free conversation-cap decision. Same entitlement + usage
 * sources as the middleware, so the two can never disagree.
 */
export async function checkMaxConversationsAllowance(
  config: ServerConfig,
  workspaceId: string,
): Promise<ConversationAllowance> {
  let result;
  try {
    result = await checkEntitlementFromDB(
      config.supabaseUrl,
      config.supabaseServiceRoleKey,
      workspaceId,
      LIMIT_KEY,
      { numeric: true, selfHostBillingUnlimited: (config as any).selfHostBillingUnlimited === true },
    );
  } catch {
    return { allowed: false, reason: 'entitlement_unavailable', retryable: true };
  }

  if (isUnreadableEntitlementReason(result.reason)) {
    return { allowed: false, reason: 'entitlement_unavailable', retryable: true };
  }
  if (!result.allowed) {
    return { allowed: false, reason: 'not_in_plan', retryable: false, plan: result.plan };
  }
  // -1 = unlimited on this plan.
  if (result.limit === -1) {
    return { allowed: true, reason: 'ok', retryable: false, plan: result.plan, limit: -1 };
  }

  let used: number;
  try {
    const usage = await resolveUsage(config, workspaceId, LIMIT_KEY);
    used = usage.value;
  } catch {
    return { allowed: false, reason: 'usage_unavailable', retryable: true, plan: result.plan };
  }


  if (typeof result.limit === 'number' && used >= result.limit) {
    return {
      allowed: false,
      reason: 'limit_reached',
      retryable: false,
      plan: result.plan,
      limit: result.limit,
      used,
    };
  }
  return { allowed: true, reason: 'ok', retryable: false, plan: result.plan, limit: result.limit, used };
}

export async function enforceMaxConversationsLimit(
  req: Request,
  res: Response,
): Promise<boolean> {
  let proceeded = false;
  await conversationLimitMiddleware(req, res, () => {
    proceeded = true;
  });
  return proceeded;
}
