/**
 * Brand Radar — workspace-scoped API.
 *
 * Every route calls `authorizeWorkspaceAccess` first; writes (settings,
 * topics, "run checks now") additionally require `{ manage: true }`. Reads
 * AND the "run checks now" triggers are gated by `requireModule('brand_radar')`.
 * AI-visibility runs are additionally throttled by
 * `brand_radar_check_frequency_hours` (bounds AI-credit and rank-tracking-
 * provider spend) — each domain (AI / Web) is throttled independently,
 * measured from that domain's own last stored check.
 */
import { Router } from 'express';
import { authorizeWorkspaceAccess } from '../lib/workspaceAuth.js';
import type { ServerConfig } from '../config.js';
import { requireModule } from '../middleware/featureGating.js';
import { getServiceClient } from '../supabase.js';
import { resolveBrandRadarLimits } from '../services/brandRadar/limits.js';
import {
  getSettings, upsertSettings, listTopics, createTopic, deleteTopic, BrandRadarValidationError,
} from '../services/brandRadar/settingsService.js';
import {
  runAllTopicsAiVisibility, getLatestAiChecksByTopic, getAiCheckHistory,
} from '../services/brandRadar/aiVisibilityService.js';
import {
  runAllTermsWebVisibility, getLatestWebChecks, getWebCheckHistory, isWebVisibilityAvailable,
} from '../services/brandRadar/webVisibilityService.js';
import { getSearchDemand } from '../services/brandRadar/searchDemandService.js';
import { getOverview, getCompetitors } from '../services/brandRadar/reportService.js';
import { AiBillingError } from '../services/ai-billing/errors.js';

export const brandRadarRouter = Router();

function configOf(req: any): ServerConfig {
  return req.serverConfig as ServerConfig;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseRange(req: any): { startDate: string; endDate: string } | null {
  const q = req.query as Record<string, string | undefined>;
  if (q.startDate && q.endDate) {
    if (!DATE_RE.test(q.startDate) || !DATE_RE.test(q.endDate)) return null;
    return { startDate: q.startDate, endDate: q.endDate };
  }
  const end = new Date();
  end.setUTCDate(end.getUTCDate() - 1);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 27);
  return { startDate: start.toISOString().slice(0, 10), endDate: end.toISOString().slice(0, 10) };
}

async function lastCheckAt(config: ServerConfig, workspaceId: string, table: 'brand_radar_ai_checks' | 'brand_radar_web_checks'): Promise<string | null> {
  const sb = getServiceClient(config);
  const { data } = await sb.from(table).select('created_at').eq('workspace_id', workspaceId).order('created_at', { ascending: false }).limit(1).maybeSingle();
  return (data as { created_at: string } | null)?.created_at ?? null;
}

function hoursSince(iso: string): number {
  return (Date.now() - new Date(iso).getTime()) / (60 * 60 * 1000);
}

brandRadarRouter.get('/:workspaceId/limits', async (req, res) => {
  const { workspaceId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return;
  const resolved = await resolveBrandRadarLimits(configOf(req), workspaceId);
  res.json(resolved);
});

// ─── Settings ───────────────────────────────────────────────────────────

brandRadarRouter.get('/:workspaceId/settings', requireModule('brand_radar'), async (req, res) => {
  const { workspaceId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return;
  const settings = await getSettings(configOf(req), workspaceId);
  res.json({ settings });
});

brandRadarRouter.put('/:workspaceId/settings', requireModule('brand_radar'), async (req, res) => {
  const { workspaceId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId, { manage: true });
  if (!auth) return;
  const { brandName, competitorNames, siteId } = req.body as { brandName?: string; competitorNames?: string[]; siteId?: string | null };
  if (typeof brandName !== 'string' || !Array.isArray(competitorNames)) return res.status(400).json({ error: 'invalid_body' });

  const { limits } = await resolveBrandRadarLimits(configOf(req), workspaceId);
  try {
    const settings = await upsertSettings(configOf(req), {
      workspaceId, brandName, competitorNames: competitorNames.filter((c) => typeof c === 'string'),
      siteId: siteId || null, maxCompetitors: limits.brand_radar_max_competitors,
    });
    res.json({ settings });
  } catch (err) {
    if (err instanceof BrandRadarValidationError) return res.status(400).json({ error: err.reason });
    console.error('[BrandRadar] settings save failed:', (err as Error)?.message);
    res.status(500).json({ error: 'brand_radar_settings_save_failed' });
  }
});

// ─── Topics ─────────────────────────────────────────────────────────────

brandRadarRouter.get('/:workspaceId/topics', requireModule('brand_radar'), async (req, res) => {
  const { workspaceId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return;
  const topics = await listTopics(configOf(req), workspaceId);
  res.json({ topics });
});

brandRadarRouter.post('/:workspaceId/topics', requireModule('brand_radar'), async (req, res) => {
  const { workspaceId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId, { manage: true });
  if (!auth) return;
  const { label, prompt } = req.body as { label?: string; prompt?: string };
  if (typeof label !== 'string' || typeof prompt !== 'string') return res.status(400).json({ error: 'invalid_body' });

  const { limits } = await resolveBrandRadarLimits(configOf(req), workspaceId);
  try {
    const topic = await createTopic(configOf(req), { workspaceId, label, prompt, userId: auth.userId, maxTopics: limits.brand_radar_max_topics });
    res.json({ topic });
  } catch (err) {
    if (err instanceof BrandRadarValidationError) return res.status(400).json({ error: err.reason, upgrade_required: err.reason === 'topic_limit_reached' });
    console.error('[BrandRadar] topic create failed:', (err as Error)?.message);
    res.status(500).json({ error: 'brand_radar_topic_create_failed' });
  }
});

brandRadarRouter.delete('/:workspaceId/topics/:topicId', requireModule('brand_radar'), async (req, res) => {
  const { workspaceId, topicId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId, { manage: true });
  if (!auth) return;
  await deleteTopic(configOf(req), workspaceId, topicId);
  res.json({ ok: true });
});

// ─── AI Visibility ──────────────────────────────────────────────────────

brandRadarRouter.get('/:workspaceId/ai-visibility', requireModule('brand_radar'), async (req, res) => {
  const { workspaceId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return;
  const rows = await getLatestAiChecksByTopic(configOf(req), workspaceId);
  res.json({ rows });
});

brandRadarRouter.get('/:workspaceId/ai-visibility/history', requireModule('brand_radar'), async (req, res) => {
  const { workspaceId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return;
  const topicId = typeof req.query.topicId === 'string' ? req.query.topicId : undefined;
  const rows = await getAiCheckHistory(configOf(req), workspaceId, topicId);
  res.json({ rows });
});

brandRadarRouter.post('/:workspaceId/ai-visibility/run', requireModule('brand_radar'), async (req, res) => {
  const { workspaceId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId, { manage: true });
  if (!auth) return;

  const config = configOf(req);
  const [settings, topics, { limits }] = await Promise.all([
    getSettings(config, workspaceId),
    listTopics(config, workspaceId),
    resolveBrandRadarLimits(config, workspaceId),
  ]);
  if (!settings) return res.status(400).json({ error: 'brand_radar_settings_required' });
  if (topics.length === 0) return res.status(400).json({ error: 'no_topics_configured' });

  try {
    const { results, errors } = await runAllTopicsAiVisibility(config, { workspaceId, topics, settings, userId: auth.userId });
    res.json({ results, errors });
  } catch (err) {
    if (err instanceof AiBillingError) return res.status(err.httpStatus).json({ error: err.code, upgrade_required: err.code === 'ai_allowance_exhausted' });
    console.error('[BrandRadar] AI visibility run failed:', (err as Error)?.message);
    res.status(500).json({ error: 'brand_radar_ai_run_failed' });
  }
});

// ─── Web Visibility ─────────────────────────────────────────────────────

brandRadarRouter.get('/:workspaceId/web-visibility', requireModule('brand_radar'), async (req, res) => {
  const { workspaceId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return;
  const [rows, available] = await Promise.all([getLatestWebChecks(configOf(req), workspaceId), isWebVisibilityAvailable(configOf(req))]);
  res.json({ available, rows });
});

brandRadarRouter.get('/:workspaceId/web-visibility/history', requireModule('brand_radar'), async (req, res) => {
  const { workspaceId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return;
  const term = typeof req.query.term === 'string' ? req.query.term : undefined;
  const rows = await getWebCheckHistory(configOf(req), workspaceId, term);
  res.json({ rows });
});

brandRadarRouter.post('/:workspaceId/web-visibility/run', requireModule('brand_radar'), async (req, res) => {
  const { workspaceId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId, { manage: true });
  if (!auth) return;

  const config = configOf(req);
  const [settings, { limits }, available] = await Promise.all([
    getSettings(config, workspaceId),
    resolveBrandRadarLimits(config, workspaceId),
    isWebVisibilityAvailable(config),
  ]);
  if (!settings) return res.status(400).json({ error: 'brand_radar_settings_required' });
  if (!settings.siteId) return res.status(400).json({ error: 'brand_radar_site_required' });
  if (!available) return res.status(503).json({ error: 'rank_tracking_provider_not_configured' });

  const sb = getServiceClient(config);
  const { data: site } = await sb.from('workspace_domains').select('domain').eq('id', settings.siteId).maybeSingle();
  if (!site) return res.status(400).json({ error: 'brand_radar_site_required' });

  try {
    const { results, errors } = await runAllTermsWebVisibility(config, {
      workspaceId, brandName: settings.brandName, competitorNames: settings.competitorNames,
      targetHost: (site as { domain: string }).domain, userId: auth.userId,
    });
    res.json({ results, errors });
  } catch (err) {
    console.error('[BrandRadar] Web visibility run failed:', (err as Error)?.message);
    res.status(500).json({ error: 'brand_radar_web_run_failed' });
  }
});

// ─── Search Demand ──────────────────────────────────────────────────────

brandRadarRouter.get('/:workspaceId/search-demand', requireModule('brand_radar'), async (req, res) => {
  const { workspaceId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return;
  const range = parseRange(req);
  if (!range) return res.status(400).json({ error: 'invalid_date_range' });
  const settings = await getSettings(configOf(req), workspaceId);
  if (!settings) return res.json({ available: false, propertyUrl: null, rows: [] });
  const result = await getSearchDemand(configOf(req), { workspaceId, brandName: settings.brandName, competitorNames: settings.competitorNames, ...range });
  res.json(result);
});

// ─── Overview / Competitors ─────────────────────────────────────────────

brandRadarRouter.get('/:workspaceId/overview', requireModule('brand_radar'), async (req, res) => {
  const { workspaceId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return;
  const range = parseRange(req);
  if (!range) return res.status(400).json({ error: 'invalid_date_range' });
  const config = configOf(req);
  const [settings, topics] = await Promise.all([getSettings(config, workspaceId), listTopics(config, workspaceId)]);
  const overview = await getOverview(config, { workspaceId, settings, topicCount: topics.length, ...range });
  res.json(overview);
});

brandRadarRouter.get('/:workspaceId/competitors', requireModule('brand_radar'), async (req, res) => {
  const { workspaceId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return;
  const range = parseRange(req);
  if (!range) return res.status(400).json({ error: 'invalid_date_range' });
  const settings = await getSettings(configOf(req), workspaceId);
  if (!settings) return res.json({ rows: [], webAvailable: false, searchDemand: { available: false, propertyUrl: null, rows: [] } });
  const result = await getCompetitors(configOf(req), { workspaceId, settings, ...range });
  res.json(result);
});
