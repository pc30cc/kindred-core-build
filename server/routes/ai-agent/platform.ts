/**
 * AI Agent router — platform domain.
 *
 * Mechanically extracted from the original server/routes/aiAgent.ts (Phase 3
 * router split). Route paths, middleware order, auth, validation, rate
 * limits and response shapes are unchanged from the original file.
 */
import express, { type Request, type Response, type Router } from 'express';
import type { ServerConfig } from '../../config.js';
import {
  getPlatformAiAgentSettings,
  updatePlatformAiAgentSettings,
} from '../../services/ai-agent/platformSettings.js';
import { resolveCurrentUserId } from './shared.js';

export const platformRouter: Router = express.Router();


// ─── E12 Super Admin: GET /platform/settings ───
// Guarded by ADVANCED_PATH_PATTERNS middleware (admin-only).
platformRouter.get('/platform/settings', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  try {
    const settings = await getPlatformAiAgentSettings(config);
    return res.json({ settings });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || 'platform_settings_read_failed' });
  }
});

// ─── E12 Super Admin: PATCH /platform/settings ───
// Guarded by ADVANCED_PATH_PATTERNS middleware (admin-only). Sanitizes
// the patch body to a whitelist; ignores unknown keys.
platformRouter.patch('/platform/settings', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const { userId } = await resolveCurrentUserId(req, config);
  if (!userId) return res.status(401).json({ error: 'unauthenticated' });
  try {
    // Phase 6-S5-R5 — capture the PREVIOUS state so we can detect the real
    // false → true transition instead of fanning out on every patch.
    const previous = await getPlatformAiAgentSettings(config);
    const settings = await updatePlatformAiAgentSettings(
      config,
      (req.body || {}) as Record<string, unknown>,
      userId,
    );
    // Only a genuine OFF → ON transition re-arms deferred indexing for every
    // workspace. ON → ON does nothing; ON → OFF only clears caches implicitly
    // (events stay deferred and retryable on their own backoff).
    const turnedOn =
      previous.ai_agent_enabled === false && settings.ai_agent_enabled === true;
    let fanout: { scheduled: boolean; jobId?: string | null } = { scheduled: false };
    if (turnedOn) {
      const { handlePlatformAiEnabled } = await import(
        '../../services/billing/entitlementChange.js'
      );
      // Phase 6-S5-R6 — durable, restart-safe queue job; the worker walks
      // public.workspaces with a keyset cursor.
      const r = await handlePlatformAiEnabled(config, {
        previousEnabled: previous.ai_agent_enabled === true,
        nextEnabled: settings.ai_agent_enabled === true,
      });
      fanout = { scheduled: r.ok && !r.skipped, jobId: r.jobId };
    }
    return res.json({ settings, entitlement_fanout: fanout });
  } catch (e: any) {
    if (String(e?.message) === 'forbidden') {
      return res.status(403).json({ error: 'forbidden' });
    }
    return res.status(500).json({ error: e?.message || 'platform_settings_update_failed' });
  }
});
