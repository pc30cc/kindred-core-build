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
import { getServiceClient } from '../../supabase.js';
import { getMonitoringCollector } from '../../services/observability/collector/index.js';

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

// ─── E12 Super Admin: GET /platform/ai-proactive-stats ───
// Guarded by ADVANCED_PATH_PATTERNS middleware (admin-only). Bounded,
// aggregate-only cross-workspace view — reuses the same tables the
// workspace-level stats endpoint reads (widget_ai_nudge_settings,
// widget_smart_events, ai_runs) plus the existing in-memory observability
// collector for failure/suppression counts. No raw per-evaluation table.
platformRouter.get('/platform/ai-proactive-stats', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  try {
    const sb = getServiceClient(config);
    const since = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    const [{ count: workspacesUsing }, { data: events }, { data: runs }] = await Promise.all([
      sb.from('widget_ai_nudge_settings' as any).select('workspace_id', { count: 'exact', head: true }).eq('enabled', true),
      sb.from('widget_smart_events').select('event_type').eq('source', 'ai_proactive').gte('created_at', since).limit(20000),
      sb.from('ai_runs' as any).select('customer_charge_irr, provider_cost_usd').eq('entry_point', 'proactive_nudge').gte('created_at', since).limit(20000),
    ]);
    const counters = { shown: 0, dismissed: 0, cta_clicked: 0, widget_opened: 0, conversation_started: 0 };
    for (const row of (events || []) as any[]) {
      if (row.event_type in counters) (counters as any)[row.event_type]++;
    }
    let costUsd = 0;
    let chargeIrr = 0;
    for (const r of (runs || []) as any[]) {
      costUsd += Number(r.provider_cost_usd) || 0;
      chargeIrr += Number(r.customer_charge_irr) || 0;
    }
    const collector = getMonitoringCollector();
    const windowSeconds = 24 * 3600;
    const failures = {
      evaluated: collector.queryRealtimeCount('ai_nudge.evaluated', windowSeconds),
      suppressed: collector.queryRealtimeCount('ai_nudge.suppressed', windowSeconds),
      shown: collector.queryRealtimeCount('ai_nudge.shown', windowSeconds),
      timeout: collector.queryRealtimeCount('ai_nudge.timeout', windowSeconds),
      invalid_response: collector.queryRealtimeCount('ai_nudge.invalid_response', windowSeconds),
      billing_denied: collector.queryRealtimeCount('ai_nudge.billing_denied', windowSeconds),
      provider_unavailable: collector.queryRealtimeCount('ai_nudge.provider_unavailable', windowSeconds),
    };
    return res.json({
      workspacesUsing: workspacesUsing || 0,
      counters,
      aiUsage: { costUsd, chargeIrr, runs: (runs || []).length },
      last24h: failures,
    });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || 'ai_proactive_stats_failed' });
  }
});
