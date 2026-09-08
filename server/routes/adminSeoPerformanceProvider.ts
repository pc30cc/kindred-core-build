/**
 * ADMIN — SEO PERFORMANCE PROVIDER CONFIGURATION
 *
 * Mirrors server/routes/adminSeoBacklinksProvider.ts's shape, adapted for a
 * single optional `apiKey` credential instead of login+password. Mounted
 * under the admin router, so `requireAdmin` already gates every route here.
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import {
  getPerformanceProviderInfo,
  savePerformanceProviderConfig,
  deletePerformanceProviderConfig,
  testPerformanceProvider,
  PerformanceConfigValidationError,
} from '../services/seo/performance/index.js';
import { getPerformancePlatformStats, listRecentPerformanceAuditsAcrossWorkspaces } from '../services/seo/performanceAdminStats.js';

export const adminSeoPerformanceProviderRouter = Router();

interface AdminRequestContext {
  serverConfig: ServerConfig;
  adminUser?: { id: string };
}

function ctx(req: Request): AdminRequestContext {
  return req as Request & AdminRequestContext;
}

function adminId(req: Request): string | null {
  return ctx(req).adminUser?.id ?? null;
}

const TEST_WINDOW_MS = 60_000;
const TEST_MAX = 5;
const testHits = new Map<string, number[]>();

function allowTest(key: string, now = Date.now()): boolean {
  const hits = (testHits.get(key) ?? []).filter((t) => now - t < TEST_WINDOW_MS);
  if (hits.length >= TEST_MAX) {
    testHits.set(key, hits);
    return false;
  }
  hits.push(now);
  testHits.set(key, hits);
  return true;
}

export function __resetSeoPerformanceTestRateLimit(): void {
  testHits.clear();
}

adminSeoPerformanceProviderRouter.get('/', async (req: Request, res: Response) => {
  try {
    const info = await getPerformanceProviderInfo(ctx(req).serverConfig);
    res.json(info);
  } catch {
    res.status(500).json({ error: 'performance_config_read_failed' });
  }
});

const saveSchema = z
  .object({
    providerName: z.literal('pagespeed'),
    enabled: z.boolean(),
    apiKey: z.string().max(256).optional(),
  })
  .strict();

adminSeoPerformanceProviderRouter.put('/', async (req: Request, res: Response) => {
  const parsed = saveSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_performance_config' });
  const userId = adminId(req);
  if (!userId) return res.status(401).json({ error: 'Missing authorization' });

  try {
    const body = parsed.data;
    const info = await savePerformanceProviderConfig(
      ctx(req).serverConfig,
      {
        providerName: body.providerName,
        enabled: body.enabled,
        ...(body.apiKey !== undefined ? { apiKey: body.apiKey } : {}),
      },
      userId,
    );
    res.json(info);
  } catch (err) {
    if (err instanceof PerformanceConfigValidationError) {
      const status = err.reason === 'save_failed' ? 500 : 400;
      return res.status(status).json({ error: err.reason });
    }
    res.status(500).json({ error: 'performance_config_save_failed' });
  }
});

adminSeoPerformanceProviderRouter.delete('/', async (req: Request, res: Response) => {
  const userId = adminId(req);
  if (!userId) return res.status(401).json({ error: 'Missing authorization' });
  try {
    const info = await deletePerformanceProviderConfig(ctx(req).serverConfig, userId);
    res.json(info);
  } catch {
    res.status(500).json({ error: 'performance_config_delete_failed' });
  }
});

adminSeoPerformanceProviderRouter.post('/test', async (req: Request, res: Response) => {
  const userId = adminId(req);
  if (!userId) return res.status(401).json({ error: 'Missing authorization' });
  if (!allowTest(userId)) {
    return res.status(429).json({ error: 'too_many_test_requests' });
  }
  const result = await testPerformanceProvider(ctx(req).serverConfig);
  if (result.success) {
    return res.json({ success: true, provider: result.provider, latencyMs: result.latencyMs });
  }
  res.json({
    success: false,
    provider: result.provider,
    error: result.error ?? 'Performance provider returned an error',
    errorCode: result.errorCode ?? 'performance_provider_error',
  });
});

adminSeoPerformanceProviderRouter.get('/stats', async (req: Request, res: Response) => {
  try {
    const stats = await getPerformancePlatformStats(ctx(req).serverConfig);
    res.json(stats);
  } catch {
    res.status(500).json({ error: 'performance_stats_failed' });
  }
});

adminSeoPerformanceProviderRouter.get('/audits', async (req: Request, res: Response) => {
  try {
    const limit = parseInt(String(req.query.limit || '20'), 10) || 20;
    const audits = await listRecentPerformanceAuditsAcrossWorkspaces(ctx(req).serverConfig, limit);
    res.json({ audits });
  } catch {
    res.status(500).json({ error: 'performance_audits_failed' });
  }
});
