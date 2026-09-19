// ============================================
// EMAIL API ROUTES — self-hosted backend only
// All email sending goes through these routes.
// ============================================

import { Router } from 'express';
import type { Request } from 'express';
import { z } from 'zod';
import { sendEmail } from '../services/email/index.js';
import { requireChannel } from '../middleware/featureGating.js';
import type { ServerConfig } from '../config.js';
import { authorizeWorkspaceAccess } from '../lib/workspaceAuth.js';
import { getServiceClient } from '../supabase.js';

export const emailRouter = Router();

/** The per-request server config the app middleware attaches. */
function serverConfigOf(req: Request): ServerConfig {
  return (req as Request & { serverConfig: ServerConfig }).serverConfig;
}

/**
 * POST /api/email/send
 * PLATFORM / AUTH / TRANSACTIONAL email surface.
 *
 * This route is intentionally NOT plan-gated — it is shared by:
 *   - in-process auth flows (verify, password reset) via server/services/auth-email.ts
 *     (those callers invoke sendEmail() directly and never traverse HTTP, but the
 *      route is still classified as platform email so its contract stays stable),
 *   - workspace team invitations (TeamPage, TeamDepartmentsPage),
 *   - workspace operational notifications (offline-message admin test, etc.).
 *
 * For true workspace channel-email sending (customer-facing communication that
 * should disappear when the email channel is not on the workspace plan) callers
 * MUST use POST /api/email/send-channel below, which is gated with
 * requireChannel('email'). See docs/EMAIL_SURFACE_SPLIT.md.
 */
emailRouter.post('/send', (_req, res) => res.status(410).json({
  error: 'ARBITRARY_EMAIL_RELAY_RETIRED',
  replacement: '/api/email/send-channel',
}));

emailRouter.post('/test-send', async (req, res) => {
  try {
    const config = serverConfigOf(req);
    const workspaceId = String(req.body?.workspaceId || '');
    const auth = await authorizeWorkspaceAccess(req, res, workspaceId, { manage: true });
    if (!auth) return;
    const { data: profile } = await getServiceClient(config)
      .from('profiles').select('email').eq('id', auth.userId).maybeSingle();
    if (!profile?.email) return res.status(400).json({ error: 'verified_email_required' });

    const result = await sendEmail(config, {
      workspaceId,
      to: profile.email,
      subject: 'Email provider test',
      text: 'Your workspace email provider is configured correctly.',
      html: '<p>Your workspace email provider is configured correctly.</p>',
    });

    return res.status(result.success ? 200 : 500).json(result);
  } catch (err) {
    console.error('[email] Send error:', err);
    return res.status(500).json({ error: 'Internal email error' });
  }
});

/**
 * POST /api/email/send-channel
 * CHANNEL email surface — customer-facing workspace email sending.
 *
 * This is the only email route gated by the email channel entitlement.
 * Platform/auth/transactional traffic MUST NOT use this route.
 *
 * Reuses the canonical entitlement stack via requireChannel('email'):
 * a workspace whose plan does not include the email channel (or whose
 * admin override disables it) receives 403 here while /api/email/send
 * remains reachable for auth and platform notifications.
 */
/**
 * The only fields a workspace may send.
 *
 * `.strict()` on purpose. This route used to pull `from` and `replyTo` off the
 * body and hand them to `sendEmail()`, which meant a workspace with the email
 * channel could put any address it liked in the From header of mail sent
 * through the PLATFORM's Resend account — spoofing, not just a config
 * override. Transport identity belongs to
 * Super Admin → Providers → Email and to nothing else.
 *
 * Dropping unknown keys silently would close the hole but keep the
 * misunderstanding: a client would go on sending `from`, see 200, and believe
 * it was honoured. A 400 that names the field says what the rule is.
 */
const sendChannelSchema = z.object({
  workspaceId: z.string().min(1),
  to: z.string().min(1).max(320),
  subject: z.string().max(1000).optional(),
  html: z.string().optional(),
  text: z.string().optional(),
  templateSlug: z.string().max(200).optional(),
  templateData: z.record(z.string(), z.string()).optional(),
  locale: z.string().min(2).max(10).optional(),
}).strict();

emailRouter.post('/send-channel', requireChannel('email'), async (req, res) => {
  try {
    const config = serverConfigOf(req);

    const parsed = sendChannelSchema.safeParse(req.body);
    if (!parsed.success) {
      const rejected = parsed.error.issues
        .filter((i) => i.code === 'unrecognized_keys')
        .flatMap((i) => (i as unknown as { keys: string[] }).keys ?? []);
      if (rejected.length) {
        return res.status(400).json({
          error: 'UNSUPPORTED_FIELDS',
          fields: rejected,
          detail:
            'The sender identity is set by the platform in Super Admin → Providers → Email and cannot be supplied per request.',
        });
      }
      return res.status(400).json({ error: 'Invalid input' });
    }

    const { workspaceId, to, subject, html, text, templateSlug, templateData, locale } = parsed.data;
    if (!(await authorizeWorkspaceAccess(req, res, workspaceId))) return;

    // Forwarded field by field rather than spread, so the set that reaches the
    // send path is visible here and a future addition to the schema cannot
    // reach it by accident.
    const result = await sendEmail(config, {
      workspaceId, to, subject, html, text, templateSlug, templateData, locale,
    });
    return res.status(result.success ? 200 : 500).json(result);
  } catch (err) {
    console.error('[email] send-channel error:', err);
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
