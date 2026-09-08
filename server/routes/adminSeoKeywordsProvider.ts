/**
 * ADMIN — SEO KEYWORDS PROVIDER CONFIGURATION
 *
 * Mirrors server/routes/adminSeoBacklinksProvider.ts exactly. Mounted under
 * the admin router, so `requireAdmin` already gates every route here.
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import {
  getKeywordsProviderInfo,
  saveKeywordsProviderConfig,
  deleteKeywordsProviderConfig,
  testKeywordsProvider,
  KeywordsConfigValidationError,
} from '../services/seo/keywords/index.js';
import { getKeywordsPlatformStats, listRecentKeywordRunsAcrossWorkspaces } from '../services/seo/keywordAdminStats.js';

export const adminSeoKeywordsProviderRouter = Router();

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

export function __resetSeoKeywordsTestRateLimit(): void {
  testHits.clear();
}

adminSeoKeywordsProviderRouter.get('/', async (req: Request, res: Response) => {
  try {
    const info = await getKeywordsProviderInfo(ctx(req).serverConfig);
    res.json(info);
  } catch {
    res.status(500).json({ error: 'keywords_config_read_failed' });
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

adminSeoKeywordsProviderRouter.put('/', async (req: Request, res: Response) => {
  const parsed = saveSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_keywords_config' });
  const userId = adminId(req);
  if (!userId) return res.status(401).json({ error: 'Missing authorization' });

  try {
    const body = parsed.data;
    const info = await saveKeywordsProviderConfig(
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
    if (err instanceof KeywordsConfigValidationError) {
      const status = err.reason === 'save_failed' ? 500 : 400;
      return res.status(status).json({ error: err.reason });
    }
    res.status(500).json({ error: 'keywords_config_save_failed' });
  }
});

adminSeoKeywordsProviderRouter.delete('/', async (req: Request, res: Response) => {
  const userId = adminId(req);
  if (!userId) return res.status(401).json({ error: 'Missing authorization' });
  try {
    const info = await deleteKeywordsProviderConfig(ctx(req).serverConfig, userId);
    res.json(info);
  } catch {
    res.status(500).json({ error: 'keywords_config_delete_failed' });
  }
});

adminSeoKeywordsProviderRouter.post('/test', async (req: Request, res: Response) => {
  const userId = adminId(req);
  if (!userId) return res.status(401).json({ error: 'Missing authorization' });
  if (!allowTest(userId)) {
    return res.status(429).json({ error: 'too_many_test_requests' });
  }
  const result = await testKeywordsProvider(ctx(req).serverConfig);
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
    error: result.error ?? 'Keyword data provider returned an error',
    errorCode: result.errorCode ?? 'keywords_provider_error',
  });
});

adminSeoKeywordsProviderRouter.get('/stats', async (req: Request, res: Response) => {
  try {
    const stats = await getKeywordsPlatformStats(ctx(req).serverConfig);
    res.json(stats);
  } catch {
    res.status(500).json({ error: 'keywords_stats_failed' });
  }
});

adminSeoKeywordsProviderRouter.get('/runs', async (req: Request, res: Response) => {
  try {
    const limit = parseInt(String(req.query.limit || '20'), 10) || 20;
    const runs = await listRecentKeywordRunsAcrossWorkspaces(ctx(req).serverConfig, limit);
    res.json({ runs });
  } catch {
    res.status(500).json({ error: 'keywords_runs_failed' });
  }
});
