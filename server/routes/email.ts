// ============================================
// EMAIL API ROUTES — self-hosted backend only
// ============================================
//
// No route here sends mail a caller composes. Every platform mail is sent by
// the server for something that happened (a reset, an invitation, a
// receipt, a visitor's message), through server/services/email; what is
// left here is the offline notice's test button, which mails only the member
// who presses it, at their own verified address.

import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { SendResult } from '../services/email/index.js';
import { takeEmailQuota } from '../services/email/sendQuota.js';
import { sendOfflineNoticeTest } from '../services/widget/offlineNotice.js';
import type { ServerConfig } from '../config.js';
import { authorizeWorkspaceAccess, type WorkspaceAuth } from '../lib/workspaceAuth.js';
import { findIdentityById } from '../services/auth/identity.js';
import { operatorLocale } from '../services/operatorLocale.js';
import { parseEmailAddress } from '../../shared/emailProviders.js';

export const emailRouter = Router();

/** The per-request server config the app middleware attaches. */
function serverConfigOf(req: Request): ServerConfig {
  return (req as Request & { serverConfig: ServerConfig }).serverConfig;
}

/**
 * POST /api/email/send and POST /api/email/send-channel — retired.
 *
 * Both took a recipient, a subject, a body or any platform template with the
 * caller's own values, and sent it From the platform's address through the
 * platform's provider: /send for any member, then /send-channel for any
 * member of a workspace with the email channel. A member could send the
 * platform's real password-reset mail with a link of their choosing, signed
 * with our domain's DKIM key, to any address (and, over SMTP, to several in
 * one `to`). Nothing in the web app, the native and desktop apps or the
 * channels service called /send-channel. Mail to customers goes through the
 * workspace's own connected mailbox (/api/email-inbox), never through the
 * platform sender.
 */
const retired = (_req: Request, res: Response) => res.status(410).json({ error: 'ARBITRARY_EMAIL_RELAY_RETIRED' });
emailRouter.post('/send', retired);
emailRouter.post('/send-channel', retired);

/**
 * POST /api/email/test-send — retired.
 *
 * It sent a workspace owner or admin the template `email_test`, which is
 * Super Admin's test of the platform's provider (Super Admin → Providers →
 * Email, server/routes/adminEmailProviders.ts): it names that menu and the
 * provider the platform uses, neither of which is a workspace's to see. A
 * workspace has no provider of its own to test, and nothing in the web app,
 * the native or desktop apps called this route.
 */
emailRouter.post('/test-send', (_req: Request, res: Response) => res.status(410).json({ error: 'WORKSPACE_EMAIL_TEST_RETIRED' }));

// ─── The offline notice's test button ─────────────────────────────────────

/** Test mails one member may send in ten minutes, and one workspace in a day. */
const TESTS_PER_MEMBER = { windowSeconds: 10 * 60, max: 3 };
const TESTS_PER_WORKSPACE = { windowSeconds: 24 * 60 * 60, max: 10 };

/**
 * `.strict()`: a test goes to the caller's own address, so a `to` (or any
 * other field) in the body is refused with a 400 rather than ignored, which
 * would let a client believe it had been honoured.
 */
const testSchema = z.object({
  workspaceId: z.string().uuid(),
  locale: z.enum(['en', 'fa', 'tr']).optional(),
}).strict();

/**
 * What every test send checks before it sends: an owner or admin of the
 * workspace (or the platform's admin), their own address, verified, and
 * within the test limits (counted per member and per workspace, on top of
 * the per-IP limit in front of this router). Writes the refusal and returns
 * null, or returns who and where.
 */
async function testSender(req: Request, res: Response): Promise<{ auth: WorkspaceAuth; workspaceId: string; to: string; locale?: string } | null> {
  const config = serverConfigOf(req);
  const parsed = testSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_request' });
    return null;
  }
  const { workspaceId, locale } = parsed.data;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId, { manage: true });
  if (!auth) return null;

  const identity = await findIdentityById(config, auth.userId);
  const to = identity?.emailVerifiedAt ? parseEmailAddress(identity.email) : null;
  if (!to) {
    res.status(400).json({ error: 'verified_email_required' });
    return null;
  }

  const member = await takeEmailQuota(config, { scope: 'email_test_member', key: auth.userId, ...TESTS_PER_MEMBER });
  const workspace = member.allowed
    ? await takeEmailQuota(config, { scope: 'email_test_workspace', key: workspaceId, ...TESTS_PER_WORKSPACE })
    : member;
  if (!workspace.allowed) {
    res.setHeader('Retry-After', String(workspace.retryAfterSeconds));
    res.status(429).json({ error: 'test_limit_reached', retry_after_seconds: workspace.retryAfterSeconds });
    return null;
  }
  return { auth, workspaceId, to, locale };
}

/**
 * The provider's real answer: 200 when it took the mail, 502 when it did
 * not, with our "<errorCode>: <reason>" (never the provider's own text).
 */
function answer(res: Response, to: string, result: SendResult) {
  return res.status(result.success ? 200 : 502).json({
    success: result.success,
    sent_to: to,
    ...(result.success ? {} : { error: result.error, error_code: result.errorCode ?? 'provider_error' }),
  });
}

/**
 * POST /api/email/test-offline-notice { workspaceId, locale? }
 * Workspace → Widget → Availability: the owners' "new offline message" mail
 * (template `offline_message_received`) with sample details, to the
 * caller's own address, in the language asked for or the caller's own.
 *
 * It used to be POST /api/widget/admin/test-offline-email, which sat behind
 * the widget's token gate (so the panel, which has no widget token, always
 * got 401), took any recipient from any member, and answered ok whatever the
 * provider said.
 */
emailRouter.post('/test-offline-notice', async (req, res) => {
  try {
    const sender = await testSender(req, res);
    if (!sender) return;
    const config = serverConfigOf(req);
    const result = await sendOfflineNoticeTest(config, {
      workspaceId: sender.workspaceId,
      to: sender.to,
      locale: sender.locale || await operatorLocale(config, sender.auth.userId),
    });
    return answer(res, sender.to, result);
  } catch (err) {
    console.error('[email] test-offline-notice error:', err instanceof Error ? err.message : err);
    return res.status(500).json({ error: 'Internal email error' });
  }
});

/**
 * GET /api/email/health
 * Quick health check for the email service.
 */
emailRouter.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'email' });
});
