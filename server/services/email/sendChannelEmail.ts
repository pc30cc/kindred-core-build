// ============================================================
// Channel-email server helper.
//
// Wraps sendEmail() with the canonical email channel entitlement
// check. Use this for in-process workspace channel-email sends
// (customer-facing communication on the email channel).
//
// Do NOT use for auth, password reset, verification, team invites,
// or platform/operational notifications — those must keep going
// through sendEmail() directly so they remain reachable regardless
// of the workspace plan.
// ============================================================

import type { ServerConfig } from '../../config.js';
import { sendEmail } from './index.js';
import { checkChannelAccess } from '../../middleware/featureGating.js';

export interface ChannelEmailRequest {
  workspaceId: string;
  to: string;
  subject?: string;
  html?: string;
  text?: string;
  // No `from` / `replyTo` — see EmailRequest in ./index.ts. Transport identity
  // is the platform provider's, never a caller's.
  templateSlug?: string;
  templateData?: Record<string, string>;
  locale?: string;
}

export interface ChannelEmailResult {
  success: boolean;
  provider?: string;
  error?: string;
  reason?: string;
  upgrade_required?: boolean;
}

export async function sendChannelEmail(
  config: ServerConfig,
  request: ChannelEmailRequest,
): Promise<ChannelEmailResult> {
  const access = await checkChannelAccess(
    config.supabaseUrl,
    config.supabaseServiceRoleKey,
    request.workspaceId,
    'email',
  );
  if (!access.allowed) {
    return {
      success: false,
      error: "Channel 'email' is not available on your plan",
      reason: access.reason,
      upgrade_required: true,
    };
  }
  return sendEmail(config, request);
}