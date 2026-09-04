/**
 * Workspace Smart Engagement — server-side publish boundary.
 *
 * Publishing (draft -> live visitor payload) must happen here, not from the
 * browser: the server re-validates the full rule with the shared Zod schema,
 * rejects unsafe URLs / incomplete config / unknown schema versions, and is
 * the only writer of `published_version` and the `published_*` snapshot
 * columns that `loadPublicSmartRules` serves to visitors.
 */
import { Router } from 'express';
import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';
import { authorizeWorkspaceAccess } from '../lib/workspaceAuth.js';
import {
  validateSmartRuleForPublish,
  SMART_SNAPSHOT_CONFIG_KEYS,
} from '../../src/lib/widget/smartRules.js';
import { resolveEffectiveAiNudgePolicy, getWidgetAiNudgeSettings } from '../services/widget/aiNudge/policy.js';
import { evaluateAiProactiveEligibility, type AiJourneyContext, type SmartEvalContext } from '../../src/lib/widget/smartEngine.js';

export const workspaceSmartRulesRouter = Router();

const SELECT = 'id, workspace_id, name, description, status, priority, schema_version, published_version, '
  + 'trigger_config, audience_config, content_config, presentation_config, schedule_config, '
  + 'frequency_config, behavior_config, created_at, updated_at, published_at';

async function loadRule(sb: any, workspaceId: string, ruleId: string) {
  const { data, error } = await sb
    .from('widget_smart_rules')
    .select(SELECT)
    .eq('id', ruleId)
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

// POST /api/workspaces/:workspaceId/smart-rules/:ruleId/publish
workspaceSmartRulesRouter.post('/:workspaceId/smart-rules/:ruleId/publish', async (req, res) => {
  const { workspaceId, ruleId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId, { manage: true });
  if (!auth) return;
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const sb = getServiceClient(config);
    const rule = await loadRule(sb, workspaceId, ruleId);
    if (!rule) return res.status(404).json({ error: 'not_found' });

    const issues = validateSmartRuleForPublish({ ...rule, status: 'active' });
    if (issues.length) return res.status(400).json({ error: 'validation_failed', issues });

    const patch: Record<string, unknown> = {
      status: 'active',
      published_version: (Number(rule.published_version) || 0) + 1,
      published_at: new Date().toISOString(),
      published_priority: rule.priority,
      published_schema_version: rule.schema_version,
    };
    for (const key of SMART_SNAPSHOT_CONFIG_KEYS) {
      patch[`published_${key}`] = (rule as any)[key];
    }

    const { data, error } = await sb
      .from('widget_smart_rules')
      .update(patch)
      .eq('id', ruleId)
      .eq('workspace_id', workspaceId)
      .select(SELECT)
      .single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ rule: data });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'internal_error' });
  }
});

// POST /api/workspaces/:workspaceId/smart-rules/:ruleId/unpublish
workspaceSmartRulesRouter.post('/:workspaceId/smart-rules/:ruleId/unpublish', async (req, res) => {
  const { workspaceId, ruleId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId, { manage: true });
  if (!auth) return;
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const sb = getServiceClient(config);
    const rule = await loadRule(sb, workspaceId, ruleId);
    if (!rule) return res.status(404).json({ error: 'not_found' });

    // Snapshot stays intact — unpublishing only stops new visitor delivery.
    const { data, error } = await sb
      .from('widget_smart_rules')
      .update({ status: 'paused' })
      .eq('id', ruleId)
      .eq('workspace_id', workspaceId)
      .select(SELECT)
      .single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ rule: data });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'internal_error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// CRUD over the Express boundary.
// The browser has no Supabase session in this self-hosted deployment
// (first-party auth), so RLS-scoped direct table reads always returned an
// empty list. All rule reads/writes go through the service client here,
// gated by `authorizeWorkspaceAccess`.
// ─────────────────────────────────────────────────────────────────────────

// GET /api/workspaces/:workspaceId/smart-rules
workspaceSmartRulesRouter.get('/:workspaceId/smart-rules', async (req, res) => {
  const { workspaceId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return;
  try {
    const sb = getServiceClient((req as any).serverConfig as ServerConfig);
    const { data, error } = await sb
      .from('widget_smart_rules')
      .select(SELECT)
      .eq('workspace_id', workspaceId)
      .order('priority', { ascending: false })
      .order('updated_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ rules: data || [] });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'internal_error' });
  }
});

// GET /api/workspaces/:workspaceId/smart-rules/stats
workspaceSmartRulesRouter.get('/:workspaceId/smart-rules/stats', async (req, res) => {
  const { workspaceId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return;
  try {
    const sb = getServiceClient((req as any).serverConfig as ServerConfig);
    const since = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    const { data, error } = await sb
      .from('widget_smart_events')
      .select('rule_id, event_type')
      .eq('workspace_id', workspaceId)
      .gte('created_at', since)
      .limit(5000);
    if (error) return res.status(500).json({ error: error.message });
    const map: Record<string, { shown: number; opened: number; dismissed: number; cta: number; conversations: number }> = {};
    for (const row of (data || []) as any[]) {
      const entry = (map[row.rule_id] ||= { shown: 0, opened: 0, dismissed: 0, cta: 0, conversations: 0 });
      if (row.event_type === 'shown') entry.shown++;
      else if (row.event_type === 'opened' || row.event_type === 'widget_opened') entry.opened++;
      else if (row.event_type === 'dismissed') entry.dismissed++;
      else if (row.event_type === 'cta_clicked') entry.cta++;
      else if (row.event_type === 'conversation_started') entry.conversations++;
    }
    res.json({ stats: map });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'internal_error' });
  }
});

const WRITABLE_KEYS = [
  'name', 'description', 'status', 'priority', 'schema_version',
  'trigger_config', 'audience_config', 'content_config', 'presentation_config',
  'schedule_config', 'frequency_config', 'behavior_config',
] as const;

function pickWritable(body: any): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of WRITABLE_KEYS) {
    if (body && Object.prototype.hasOwnProperty.call(body, key)) out[key] = body[key];
  }
  // `active` is only reachable through the publish endpoint.
  if (out.status === 'active') delete out.status;
  return out;
}

// POST /api/workspaces/:workspaceId/smart-rules  (create draft)
workspaceSmartRulesRouter.post('/:workspaceId/smart-rules', async (req, res) => {
  const { workspaceId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId, { manage: true });
  if (!auth) return;
  try {
    const sb = getServiceClient((req as any).serverConfig as ServerConfig);
    const payload = pickWritable(req.body);
    const { data, error } = await sb
      .from('widget_smart_rules')
      .insert({ ...payload, workspace_id: workspaceId })
      .select(SELECT)
      .single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ rule: data });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'internal_error' });
  }
});

// PATCH /api/workspaces/:workspaceId/smart-rules/:ruleId
workspaceSmartRulesRouter.patch('/:workspaceId/smart-rules/:ruleId', async (req, res) => {
  const { workspaceId, ruleId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId, { manage: true });
  if (!auth) return;
  try {
    const sb = getServiceClient((req as any).serverConfig as ServerConfig);
    const { data, error } = await sb
      .from('widget_smart_rules')
      .update(pickWritable(req.body))
      .eq('id', ruleId)
      .eq('workspace_id', workspaceId)
      .select(SELECT)
      .single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ rule: data });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'internal_error' });
  }
});

// DELETE /api/workspaces/:workspaceId/smart-rules/:ruleId
workspaceSmartRulesRouter.delete('/:workspaceId/smart-rules/:ruleId', async (req, res) => {
  const { workspaceId, ruleId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId, { manage: true });
  if (!auth) return;
  try {
    const sb = getServiceClient((req as any).serverConfig as ServerConfig);
    const { error } = await sb
      .from('widget_smart_rules')
      .delete()
      .eq('id', ruleId)
      .eq('workspace_id', workspaceId);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'internal_error' });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// AI Proactive Nudge — workspace configuration, stats, preview.
// Additive to the Smart Engagement surface above; not a second engine.
// ═══════════════════════════════════════════════════════════════════════
const AI_NUDGE_WRITABLE_KEYS = [
  'enabled', 'mode', 'include_paths', 'exclude_paths', 'guidance',
  'use_kb', 'use_journey', 'use_returning_visitor',
  'max_per_session', 'cooldown_seconds',
  'stop_after_dismiss', 'stop_after_widget_open', 'stop_after_conversation',
  'mobile_enabled',
] as const;

function pickAiNudgeWritable(body: any): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of AI_NUDGE_WRITABLE_KEYS) {
    if (body && Object.prototype.hasOwnProperty.call(body, key)) out[key] = body[key];
  }
  if (Array.isArray(out.include_paths)) out.include_paths = out.include_paths.slice(0, 50).map((v: any) => String(v).slice(0, 300));
  if (Array.isArray(out.exclude_paths)) out.exclude_paths = out.exclude_paths.slice(0, 50).map((v: any) => String(v).slice(0, 300));
  if (typeof out.guidance === 'string') out.guidance = out.guidance.slice(0, 500);
  return out;
}

// GET /api/workspaces/:workspaceId/ai-nudge-settings — raw row + platform-clamped effective policy.
workspaceSmartRulesRouter.get('/:workspaceId/ai-nudge-settings', async (req, res) => {
  const { workspaceId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return;
  try {
    const config = (req as any).serverConfig as ServerConfig;
    const [settings, effective] = await Promise.all([
      getWidgetAiNudgeSettings(config, workspaceId),
      resolveEffectiveAiNudgePolicy(config, workspaceId),
    ]);
    res.json({ settings, effective });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'internal_error' });
  }
});

// PATCH /api/workspaces/:workspaceId/ai-nudge-settings
workspaceSmartRulesRouter.patch('/:workspaceId/ai-nudge-settings', async (req, res) => {
  const { workspaceId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId, { manage: true });
  if (!auth) return;
  try {
    const config = (req as any).serverConfig as ServerConfig;
    const sb = getServiceClient(config);
    const patch = pickAiNudgeWritable(req.body);
    const { data, error } = await sb
      .from('widget_ai_nudge_settings' as any)
      .upsert({ workspace_id: workspaceId, ...patch }, { onConflict: 'workspace_id' })
      .select('*')
      .single();
    if (error) return res.status(500).json({ error: error.message });
    const effective = await resolveEffectiveAiNudgePolicy(config, workspaceId);
    res.json({ settings: data, effective });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'internal_error' });
  }
});

// GET /api/workspaces/:workspaceId/ai-nudge-settings/stats — 30-day lifecycle counters + AI usage/cost.
workspaceSmartRulesRouter.get('/:workspaceId/ai-nudge-settings/stats', async (req, res) => {
  const { workspaceId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return;
  try {
    const config = (req as any).serverConfig as ServerConfig;
    const sb = getServiceClient(config);
    const since = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    const [{ data: events }, { data: nudges }, { data: runs }] = await Promise.all([
      sb.from('widget_smart_events').select('event_type, ai_nudge_id').eq('workspace_id', workspaceId).eq('source', 'ai_proactive').gte('created_at', since).limit(5000),
      sb.from('widget_ai_nudges' as any).select('id, topic, page_path, status').eq('workspace_id', workspaceId).gte('created_at', since).limit(2000),
      sb.from('ai_runs' as any).select('customer_charge_irr, provider_cost_usd').eq('workspace_id', workspaceId).eq('entry_point', 'proactive_nudge').gte('created_at', since).limit(5000),
    ]);
    const counters = { shown: 0, dismissed: 0, cta_clicked: 0, widget_opened: 0, conversation_started: 0 };
    for (const row of (events || []) as any[]) {
      if (row.event_type in counters) (counters as any)[row.event_type]++;
    }
    const topicCounts: Record<string, number> = {};
    const pageCounts: Record<string, number> = {};
    for (const n of (nudges || []) as any[]) {
      if (n.topic) topicCounts[n.topic] = (topicCounts[n.topic] || 0) + 1;
      if (n.page_path) pageCounts[n.page_path] = (pageCounts[n.page_path] || 0) + 1;
    }
    let costUsd = 0;
    let chargeIrr = 0;
    for (const r of (runs || []) as any[]) {
      costUsd += Number(r.provider_cost_usd) || 0;
      chargeIrr += Number(r.customer_charge_irr) || 0;
    }
    res.json({
      counters,
      nudgesGenerated: (nudges || []).length,
      topTopics: Object.entries(topicCounts).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([topic, count]) => ({ topic, count })),
      topPages: Object.entries(pageCounts).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([page, count]) => ({ page, count })),
      aiUsage: { costUsd, chargeIrr, runs: (runs || []).length },
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'internal_error' });
  }
});

const previewSignalsSchema = {
  path: '/',
  title: '',
} as const;

// POST /api/workspaces/:workspaceId/ai-nudge-settings/preview — deterministic gate only (no AI call, no cost, no impression).
workspaceSmartRulesRouter.post('/:workspaceId/ai-nudge-settings/preview', async (req, res) => {
  const { workspaceId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId, { manage: true });
  if (!auth) return;
  try {
    const config = (req as any).serverConfig as ServerConfig;
    const effective = await resolveEffectiveAiNudgePolicy(config, workspaceId);
    if (!effective.available) {
      return res.json({ eligible: false, reasons: [effective.unavailableReason || 'unavailable'], effective });
    }
    const body = req.body || {};
    const path = String(body.path || previewSignalsSchema.path).slice(0, 500);
    const journey: AiJourneyContext = {
      current: { path, title: String(body.title || previewSignalsSchema.title).slice(0, 300), ts: Date.now() },
      recentPages: Array.isArray(body.recentPages) ? body.recentPages.slice(0, 12) : [],
      sessionPageCount: Number(body.sessionPageCount) || 1,
      returning: !!body.returning,
      previousNudge: body.previousNudge || null,
    };
    const ctx: SmartEvalContext = {
      masterEnabled: true,
      mode: 'preview',
      page: { url: path, path, hostname: '' },
      device: body.device === 'mobile' ? 'mobile' : 'desktop',
      locale: body.locale || 'en',
      visitor: { isReturning: journey.returning, sessionPageCount: journey.sessionPageCount },
      availability: { online: true },
      interaction: {},
      signals: {
        elapsedMs: Number(body.elapsedMs) || 0,
        scrollPercent: Number(body.scrollPercent) || 0,
        inactiveMs: 0,
        exitIntent: false,
      },
    };
    const result = evaluateAiProactiveEligibility(
      {
        mode: effective.mode,
        includePaths: effective.includePaths,
        excludePaths: effective.excludePaths,
        maxPerSession: effective.maxPerSession,
        cooldownSeconds: effective.cooldownSeconds,
        stopAfterDismiss: effective.stopAfterDismiss,
        stopAfterWidgetOpen: effective.stopAfterWidgetOpen,
        stopAfterConversation: effective.stopAfterConversation,
        mobileEnabled: effective.mobileEnabled,
      },
      ctx,
      journey,
      {},
      new Date(),
    );
    res.json({ ...result, effective });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'internal_error' });
  }
});
