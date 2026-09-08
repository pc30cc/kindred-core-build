/**
 * ADMIN — SEO RANK TRACKING PROVIDER CONFIGURATION
 *
 * Mirrors server/routes/adminSeoBacklinksProvider.ts exactly. Mounted under
 * the admin router, so `requireAdmin` already gates every route here.
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import {
  getRankTrackingProviderInfo,
  saveRankTrackingProviderConfig,
  deleteRankTrackingProviderConfig,
  testRankTrackingProvider,
  RankTrackingConfigValidationError,
} from '../services/seo/rankTracking/index.js';
import { getRankTrackingPlatformStats, listRecentRankChecksAcrossWorkspaces } from '../services/seo/rankTrackingAdminStats.js';

export const adminSeoRankTrackingProviderRouter = Router();

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

export function __resetSeoRankTrackingTestRateLimit(): void {
  testHits.clear();
}

adminSeoRankTrackingProviderRouter.get('/', async (req: Request, res: Response) => {
  try {
    const info = await getRankTrackingProviderInfo(ctx(req).serverConfig);
    res.json(info);
  } catch {
    res.status(500).json({ error: 'rank_tracking_config_read_failed' });
  }
});

const saveSchema = z
  .object({
    providerName: z.literal('dataforseo'),
    enabled: z.boolean(),
    login: z.string().max(256).optional(),
    password: z.string().max(512).optional(),
  })
  .strict();

adminSeoRankTrackingProviderRouter.put('/', async (req: Request, res: Response) => {
  const parsed = saveSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_rank_tracking_config' });
  const userId = adminId(req);
  if (!userId) return res.status(401).json({ error: 'Missing authorization' });

  try {
    const body = parsed.data;
    const info = await saveRankTrackingProviderConfig(
      ctx(req).serverConfig,
      {
        providerName: body.providerName,
        enabled: body.enabled,
        ...(body.login !== undefined ? { login: body.login } : {}),
        ...(body.password !== undefined ? { password: body.password } : {}),
      },
      userId,
    );
    res.json(info);
  } catch (err) {
    if (err instanceof RankTrackingConfigValidationError) {
      const status = err.reason === 'save_failed' ? 500 : 400;
      return res.status(status).json({ error: err.reason });
    }
    res.status(500).json({ error: 'rank_tracking_config_save_failed' });
  }
});

adminSeoRankTrackingProviderRouter.delete('/', async (req: Request, res: Response) => {
  const userId = adminId(req);
  if (!userId) return res.status(401).json({ error: 'Missing authorization' });
  try {
    const info = await deleteRankTrackingProviderConfig(ctx(req).serverConfig, userId);
    res.json(info);
  } catch {
    res.status(500).json({ error: 'rank_tracking_config_delete_failed' });
  }
});

adminSeoRankTrackingProviderRouter.post('/test', async (req: Request, res: Response) => {
  const userId = adminId(req);
  if (!userId) return res.status(401).json({ error: 'Missing authorization' });
  if (!allowTest(userId)) {
    return res.status(429).json({ error: 'too_many_test_requests' });
  }
  const result = await testRankTrackingProvider(ctx(req).serverConfig);
  if (result.success) {
    return res.json({
      success: true,
      provider: result.provider,
      latencyMs: result.latencyMs,
      balance: result.balance ?? null,
      currency: result.currency ?? 'USD',
    });
  }
  res.json({
    success: false,
    provider: result.provider,
    error: result.error ?? 'Rank tracking provider returned an error',
    errorCode: result.errorCode ?? 'rank_tracking_provider_error',
  });
});

adminSeoRankTrackingProviderRouter.get('/stats', async (req: Request, res: Response) => {
  try {
    const stats = await getRankTrackingPlatformStats(ctx(req).serverConfig);
    res.json(stats);
  } catch {
    res.status(500).json({ error: 'rank_tracking_stats_failed' });
  }
});

adminSeoRankTrackingProviderRouter.get('/checks', async (req: Request, res: Response) => {
  try {
    const limit = parseInt(String(req.query.limit || '20'), 10) || 20;
    const checks = await listRecentRankChecksAcrossWorkspaces(ctx(req).serverConfig, limit);
    res.json({ checks });
  } catch {
    res.status(500).json({ error: 'rank_tracking_checks_failed' });
  }
});
