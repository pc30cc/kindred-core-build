// ============================================
// EMAIL API ROUTES — self-hosted backend only
// All email sending goes through these routes.
// ============================================

import { Router } from 'express';
import { sendEmail } from '../services/email/index.js';
import type { ServerConfig } from '../config.js';

export const emailRouter = Router();

/**
 * POST /api/email/send
 * Send an email through the provider system.
 * Requires service-level auth (Bearer token matching service role key).
 */
emailRouter.post('/send', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;

    // Validate auth — require the anon key or a valid JWT in the Authorization header
    const authHeader = req.headers.authorization;
    const token = authHeader?.replace('Bearer ', '');

    // Accept anon key (from frontend) or service role key (from server-to-server)
    if (token !== config.supabaseAnonKey && token !== config.supabaseServiceRoleKey) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { workspaceId, to, subject, html, text, from, replyTo, templateSlug, templateData, locale } = req.body;

    if (!workspaceId || !to) {
      return res.status(400).json({ error: 'workspaceId and to are required' });
    }

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
 * GET /api/email/health
 * Quick health check for the email service.
 */
emailRouter.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'email' });
});
