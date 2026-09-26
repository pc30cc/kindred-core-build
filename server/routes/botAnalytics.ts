/**
 * Bot Analytics — workspace-scoped API.
 *
 * Every route calls `authorizeWorkspaceAccess` first; the import endpoints
 * additionally require `{ manage: true }`. All reads AND the log upload are
 * gated by `requireModule('bot_analytics')` — unlike Web Analytics, there is
 * no separate always-on collection module to gate independently, since
 * nothing is collected until a workspace uploads a log (see
 * server/services/botAnalytics/importService.ts).
 */
import { Router, type Request } from 'express';
import { authorizeWorkspaceAccess } from '../lib/workspaceAuth.js';
import type { ServerConfig } from '../config.js';
import { requireModule } from '../middleware/featureGating.js';
import { resolveBotAnalyticsLimits } from '../services/botAnalytics/limits.js';
import { createImport, listImports, deleteImport, BotImportError } from '../services/botAnalytics/importService.js';
import { getOverview, getCategories, getCrawledPages, getAiBots, type DateRange } from '../services/botAnalytics/reportService.js';
import { isValidYmdDate } from '../lib/dateInput.js';

export const botAnalyticsRouter = Router();

function configOf(req: Request): ServerConfig {
  return (req as Request & { serverConfig?: ServerConfig }).serverConfig as ServerConfig;
}

/** Defaults to the last 28 days (ending "yesterday"), matching Web Analytics' convention. */
function parseRange(req: Request): DateRange | null {
  const q = req.query as Record<string, string | undefined>;
  if (q.startDate && q.endDate) {
    // Real calendar dates only: the report service calls toISOString() on
    // them, which throws for e.g. 2024-13-01 (the old regex let that through).
    if (!isValidYmdDate(q.startDate) || !isValidYmdDate(q.endDate)) return null;
    return { startDate: q.startDate, endDate: q.endDate };
  }
  const end = new Date();
  end.setUTCDate(end.getUTCDate() - 1);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 27);
  return { startDate: start.toISOString().slice(0, 10), endDate: end.toISOString().slice(0, 10) };
}

botAnalyticsRouter.get('/:workspaceId/limits', async (req, res) => {
  const { workspaceId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return;
  const resolved = await resolveBotAnalyticsLimits(configOf(req), workspaceId);
  res.json(resolved);
});

botAnalyticsRouter.get('/:workspaceId/overview', requireModule('bot_analytics'), async (req, res) => {
  const { workspaceId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return;
  const range = parseRange(req);
  if (!range) return res.status(400).json({ error: 'invalid_date_range' });
  const stats = await getOverview(configOf(req), workspaceId, range);
  res.json(stats);
});

botAnalyticsRouter.get('/:workspaceId/categories', requireModule('bot_analytics'), async (req, res) => {
  const { workspaceId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return;
  const range = parseRange(req);
  if (!range) return res.status(400).json({ error: 'invalid_date_range' });
  const result = await getCategories(configOf(req), workspaceId, range);
  res.json(result);
});

botAnalyticsRouter.get('/:workspaceId/crawled-pages', requireModule('bot_analytics'), async (req, res) => {
  const { workspaceId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return;
  const range = parseRange(req);
  if (!range) return res.status(400).json({ error: 'invalid_date_range' });
  const result = await getCrawledPages(configOf(req), workspaceId, range);
  res.json(result);
});

botAnalyticsRouter.get('/:workspaceId/ai-bots', requireModule('bot_analytics'), async (req, res) => {
  const { workspaceId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return;
  const range = parseRange(req);
  if (!range) return res.status(400).json({ error: 'invalid_date_range' });
  const result = await getAiBots(configOf(req), workspaceId, range);
  res.json(result);
});

botAnalyticsRouter.get('/:workspaceId/imports', requireModule('bot_analytics'), async (req, res) => {
  const { workspaceId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return;
  const imports = await listImports(configOf(req), workspaceId);
  res.json({ imports });
});

const MAX_UPLOAD_BASE64_LEN = 21 * 1024 * 1024; // ~15MB raw content, base64-inflated

botAnalyticsRouter.post('/:workspaceId/imports', requireModule('bot_analytics'), async (req, res) => {
  const { workspaceId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId, { manage: true });
  if (!auth) return;

  const { filename, data } = req.body as { filename?: string; data?: string };
  if (!filename || typeof filename !== 'string' || !data || typeof data !== 'string') {
    return res.status(400).json({ error: 'filename_and_data_required' });
  }
  if (data.length > MAX_UPLOAD_BASE64_LEN) {
    return res.status(413).json({ error: 'file_too_large' });
  }

  let content: string;
  try {
    content = Buffer.from(data, 'base64').toString('utf-8');
  } catch {
    return res.status(400).json({ error: 'invalid_base64' });
  }

  const { limits } = await resolveBotAnalyticsLimits(configOf(req), workspaceId);
  if (limits.bot_analytics_max_log_lines <= 0) {
    return res.status(403).json({ error: 'Log import not available on your current plan', upgrade_required: true });
  }

  try {
    const summary = await createImport(configOf(req), {
      workspaceId,
      userId: auth.userId,
      filename,
      content,
      maxLines: limits.bot_analytics_max_log_lines,
    });
    res.json({ import: summary });
  } catch (err) {
    if (err instanceof BotImportError) {
      const status = err.reason === 'too_large' ? 413 : 400;
      return res.status(status).json({ error: `bot_import_${err.reason}` });
    }
    console.error('[BotAnalytics] import failed:', (err as Error)?.message);
    res.status(500).json({ error: 'bot_import_failed' });
  }
});

botAnalyticsRouter.delete('/:workspaceId/imports/:importId', requireModule('bot_analytics'), async (req, res) => {
  const { workspaceId, importId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId, { manage: true });
  if (!auth) return;
  await deleteImport(configOf(req), workspaceId, importId);
  res.json({ ok: true });
});
