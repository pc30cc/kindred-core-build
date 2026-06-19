/**
 * Conversation limit enforcement helper.
 *
 * Phase 5 — widget-aware rollout of `max_conversations`.
 *
 * The shared `requireLimit('max_conversations', usageFnForLimit('max_conversations'))`
 * middleware is invoked **inline**, only on actual conversation-creation
 * branches (widget first-message, widget offline-message capture, and
 * operator-initiated outreach). It MUST NOT be attached to:
 *
 *   - `POST /api/conversations/send-message` (replies, not creation)
 *   - the existing-conversation branch of `POST /api/widget/message`
 *   - any non-creation widget endpoint
 *
 * The middleware reads `workspace_id` from the request body via the
 * generic `extractWorkspaceId` path, so callers must ensure
 * `req.body.workspace_id` is the verified workspace at call time. For
 * widget routes that means after the widget token / workspace
 * resolution has already produced a trusted `workspaceId`.
 *
 * Returns `true` when the request may proceed, `false` when the
 * middleware has already written its 403 (cap reached / not in plan /
 * RPC error). Callers must `return` immediately when `false`.
 */

import type { Request, Response } from 'express';
import { requireLimit } from '../../middleware/featureGating.js';
import { usageFnForLimit } from './usageResolvers.js';

const conversationLimitMiddleware = requireLimit(
  'max_conversations',
  usageFnForLimit('max_conversations'),
);

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