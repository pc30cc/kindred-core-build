// ============================================
// EMAIL API ROUTES — self-hosted backend only
// All email sending goes through these routes.
// ============================================

import { Router } from 'express';
import { sendEmail } from '../services/email/index.js';
import { requireChannel } from '../middleware/featureGating.js';
import type { ServerConfig } from '../config.js';
import { authorizeWorkspaceAccess } from '../lib/workspaceAuth.js';

export const emailRouter = Router();

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
emailRouter.post('/send', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;

    const { workspaceId, to, subject, html, text, from, replyTo, templateSlug, templateData, locale } = req.body;

    if (!workspaceId || !to) {
      return res.status(400).json({ error: 'workspaceId and to are required' });
    }

    // Identity must be a real Supabase user JWT with membership of the target
    // workspace. The publishable anon key is public and would turn this route
    // into an open mail relay. In-process auth/transactional callers use
    // sendEmail() directly and never traverse HTTP.
    if (!(await authorizeWorkspaceAccess(req, res, workspaceId))) return;

    const result = await sendEmail(config, {
      workspaceId,
      to,
      subject,
      html,
      text,
      from,
      replyTo,
      templateSlug,
      templateData,
      locale,
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
emailRouter.post('/send-channel', requireChannel('email'), async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;

    const { workspaceId, to, subject, html, text, from, replyTo, templateSlug, templateData, locale } = req.body;
    if (!workspaceId || !to) {
      return res.status(400).json({ error: 'workspaceId and to are required' });
    }
    if (!(await authorizeWorkspaceAccess(req, res, workspaceId))) return;

    const result = await sendEmail(config, {
      workspaceId, to, subject, html, text, from, replyTo, templateSlug, templateData, locale,
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
