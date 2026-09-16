/**
 * Web Analytics — workspace-scoped API.
 *
 * Every route calls `authorizeWorkspaceAccess` first; write routes (funnel
 * create/delete) additionally require `{ manage: true }`. Reads are gated by
 * `requireModule('web_analytics')` — the underlying tracking data collection
 * itself stays gated by the existing `visitor_tracking` module (this only
 * gates the reporting UI + the two things that write new data: custom
 * events and funnels).
 */
import { Router } from 'express';
import { authorizeWorkspaceAccess } from '../lib/workspaceAuth.js';
import type { ServerConfig } from '../config.js';
import { requireModule } from '../middleware/featureGating.js';
import { resolveWebAnalyticsLimits } from '../services/webAnalytics/limits.js';
import {
  getOverview, getTrafficSources, getGeography, getBrowsersSystems, getPages,
  getClonedPages, getSiteStructure, getPossible404s, getLiveVisitorCount,
  type DateRange, type TrafficSourceDimension, type GeographyDimension, type BrowsersSystemsDimension, type PagesKind,
} from '../services/webAnalytics/reportService.js';
import {
  getTrackedEvents, getEventPropertyKeys, getEventPropertyBreakdown,
  listFunnels, createFunnel, deleteFunnel, computeFunnel, FunnelValidationError,
} from '../services/webAnalytics/eventsService.js';
import { officialStore, shadowCompare } from '../services/webAnalytics/store/index.js';

export const webAnalyticsRouter = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}

function configOf(req: any): ServerConfig {
  return req.serverConfig as ServerConfig;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Defaults to the last 28 days (ending "yesterday", matching the GSC Insights convention) when not given. */
function parseRange(req: any): DateRange | null {
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

webAnalyticsRouter.get('/:workspaceId/limits', async (req, res) => {
  const { workspaceId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return;
  const resolved = await resolveWebAnalyticsLimits(configOf(req), workspaceId);
  res.json(resolved);
});

webAnalyticsRouter.get('/:workspaceId/live-visitors', requireModule('web_analytics'), async (req, res) => {
  const { workspaceId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return;
  const count = await getLiveVisitorCount(configOf(req), workspaceId);
  res.json({ count });
});

webAnalyticsRouter.get('/:workspaceId/overview', requireModule('web_analytics'), async (req, res) => {
  const { workspaceId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return;
  const range = parseRange(req);
  if (!range) return res.status(400).json({ error: 'invalid_date_range' });
  // The store's PostgreSQL backing delegates to the very same function,
  // so this is the identical answer — routed through the abstraction so the
  // source becomes swappable without the route changing.
  const stats = await officialStore(configOf(req)).getOverview(workspaceId, range);
  res.json(stats);
  // Shadow read: the same question is put to the S3 store and the answers
  // compared. Never awaited, never able to affect what was just sent.
  shadowCompare(configOf(req), workspaceId, range);
});

const TRAFFIC_SOURCE_DIMENSIONS = new Set(['channel', 'source', 'campaign']);
webAnalyticsRouter.get('/:workspaceId/traffic-sources', requireModule('web_analytics'), async (req, res) => {
  const { workspaceId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return;
  const range = parseRange(req);
  const dimension = String(req.query.dimension || 'channel');
  if (!range || !TRAFFIC_SOURCE_DIMENSIONS.has(dimension)) return res.status(400).json({ error: 'invalid_query_params' });
  const result = await officialStore(configOf(req)).getTrafficSources(workspaceId, range, dimension as TrafficSourceDimension);
  res.json(result);
});

const GEOGRAPHY_DIMENSIONS = new Set(['continent', 'country', 'city', 'language']);
webAnalyticsRouter.get('/:workspaceId/geography', requireModule('web_analytics'), async (req, res) => {
  const { workspaceId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return;
  const range = parseRange(req);
  const dimension = String(req.query.dimension || 'country');
  if (!range || !GEOGRAPHY_DIMENSIONS.has(dimension)) return res.status(400).json({ error: 'invalid_query_params' });
  const result = await officialStore(configOf(req)).getGeography(workspaceId, range, dimension as GeographyDimension);
  res.json(result);
});

const BROWSERS_SYSTEMS_DIMENSIONS = new Set(['browser', 'os', 'device']);
webAnalyticsRouter.get('/:workspaceId/browsers-systems', requireModule('web_analytics'), async (req, res) => {
  const { workspaceId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return;
  const range = parseRange(req);
  const dimension = String(req.query.dimension || 'browser');
  if (!range || !BROWSERS_SYSTEMS_DIMENSIONS.has(dimension)) return res.status(400).json({ error: 'invalid_query_params' });
  const result = await officialStore(configOf(req)).getBrowsersSystems(workspaceId, range, dimension as BrowsersSystemsDimension);
  res.json(result);
});

const PAGES_KINDS = new Set(['top', 'entry', 'exit', 'new']);
webAnalyticsRouter.get('/:workspaceId/pages', requireModule('web_analytics'), async (req, res) => {
  const { workspaceId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return;
  const range = parseRange(req);
  const kind = String(req.query.kind || 'top');
  if (!range || !PAGES_KINDS.has(kind)) return res.status(400).json({ error: 'invalid_query_params' });
  const result = await officialStore(configOf(req)).getPages(workspaceId, range, kind as PagesKind);
  res.json(result);
});

webAnalyticsRouter.get('/:workspaceId/pages/cloned', requireModule('web_analytics'), async (req, res) => {
  const { workspaceId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return;
  const range = parseRange(req);
  if (!range) return res.status(400).json({ error: 'invalid_date_range' });
  const result = await getClonedPages(configOf(req), workspaceId, range);
  res.json(result);
});

webAnalyticsRouter.get('/:workspaceId/pages/site-structure', requireModule('web_analytics'), async (req, res) => {
  const { workspaceId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return;
  const range = parseRange(req);
  if (!range) return res.status(400).json({ error: 'invalid_date_range' });
  const result = await getSiteStructure(configOf(req), workspaceId, range);
  res.json(result);
});

webAnalyticsRouter.get('/:workspaceId/pages/possible-404', requireModule('web_analytics'), async (req, res) => {
  const { workspaceId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return;
  const range = parseRange(req);
  if (!range) return res.status(400).json({ error: 'invalid_date_range' });
  const result = await getPossible404s(configOf(req), workspaceId, range);
  res.json(result);
});

webAnalyticsRouter.get('/:workspaceId/events', requireModule('web_analytics'), async (req, res) => {
  const { workspaceId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return;
  const range = parseRange(req);
  if (!range) return res.status(400).json({ error: 'invalid_date_range' });
  const result = await getTrackedEvents(configOf(req), workspaceId, range);
  res.json(result);
});

webAnalyticsRouter.get('/:workspaceId/events/properties', requireModule('web_analytics'), async (req, res) => {
  const { workspaceId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return;
  const range = parseRange(req);
  const eventName = typeof req.query.eventName === 'string' ? req.query.eventName : '';
  if (!range || !eventName) return res.status(400).json({ error: 'invalid_query_params' });
  const keys = await getEventPropertyKeys(configOf(req), workspaceId, range, eventName);
  res.json({ keys });
});

webAnalyticsRouter.get('/:workspaceId/events/properties/values', requireModule('web_analytics'), async (req, res) => {
  const { workspaceId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return;
  const range = parseRange(req);
  const eventName = typeof req.query.eventName === 'string' ? req.query.eventName : '';
  const propertyKey = typeof req.query.propertyKey === 'string' ? req.query.propertyKey : '';
  if (!range || !eventName || !propertyKey) return res.status(400).json({ error: 'invalid_query_params' });
  const result = await getEventPropertyBreakdown(configOf(req), workspaceId, range, eventName, propertyKey);
  res.json(result);
});

webAnalyticsRouter.get('/:workspaceId/funnels', requireModule('web_analytics'), async (req, res) => {
  const { workspaceId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return;
  const funnels = await listFunnels(configOf(req), workspaceId);
  res.json({ funnels });
});

webAnalyticsRouter.post('/:workspaceId/funnels', requireModule('web_analytics'), async (req, res) => {
  const { workspaceId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId, { manage: true });
  if (!auth) return;
  const name = typeof req.body?.name === 'string' ? req.body.name : '';
  const steps = Array.isArray(req.body?.steps) ? req.body.steps : [];
  try {
    const { limits } = await resolveWebAnalyticsLimits(configOf(req), workspaceId);
    const funnel = await createFunnel(configOf(req), { workspaceId, name, steps, userId: auth.userId, maxFunnels: limits.web_analytics_max_funnels });
    res.status(201).json({ funnel });
  } catch (err) {
    if (err instanceof FunnelValidationError) {
      const status = err.reason === 'limit_reached' ? 403 : 400;
      return res.status(status).json({ error: err.reason, upgrade_required: err.reason === 'limit_reached' });
    }
    res.status(500).json({ error: 'create_funnel_failed', detail: (err as Error)?.message });
  }
});

webAnalyticsRouter.delete('/:workspaceId/funnels/:funnelId', requireModule('web_analytics'), async (req, res) => {
  const { workspaceId, funnelId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId, { manage: true });
  if (!auth) return;
  if (!isUuid(funnelId)) return res.status(400).json({ error: 'invalid_funnel_id' });
  await deleteFunnel(configOf(req), workspaceId, funnelId);
  res.json({ ok: true });
});

webAnalyticsRouter.get('/:workspaceId/funnels/:funnelId/results', requireModule('web_analytics'), async (req, res) => {
  const { workspaceId, funnelId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return;
  if (!isUuid(funnelId)) return res.status(400).json({ error: 'invalid_funnel_id' });
  const range = parseRange(req);
  if (!range) return res.status(400).json({ error: 'invalid_date_range' });
  const result = await computeFunnel(configOf(req), workspaceId, funnelId, range);
  if (!result) return res.status(404).json({ error: 'funnel_not_found' });
  res.json(result);
  // Shadow the funnel with the SAME step list, so the comparison proves the
  // two engines answered the same question rather than each loading their
  // own copy of the definition.
  shadowCompare(configOf(req), workspaceId, range, { funnelSteps: result.funnel.steps as never });
});
