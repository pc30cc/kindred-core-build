/**
 * ADMIN — SMS PROVIDER CONFIGURATION
 *
 * Mounted under the admin router, so `requireAdmin` (global admin role verified
 * against a real Supabase JWT) already gates every route here. No config is
 * read, no config is written, and no provider SDK is initialized before that
 * gate has passed.
 *
 * Responses are always redacted: the stored credential never leaves the server.
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import {
  getSmsProviderInfo,
  saveSmsProviderConfig,
  deleteSmsProviderConfig,
  testSmsProvider,
  SmsConfigValidationError,
  VERIFY_TEMPLATE_PATTERN,
} from '../services/sms/index.js';

export const adminSmsProvidersRouter = Router();

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

// ─── Test-connection rate limit: 5 per minute per super admin ────
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

/** Exposed for tests. */
export function __resetSmsTestRateLimit(): void {
  testHits.clear();
}

// ─── GET — redacted status ───────────────────────────────────────
adminSmsProvidersRouter.get('/', async (req: Request, res: Response) => {
  try {
    const info = await getSmsProviderInfo(ctx(req).serverConfig);
    res.json(info);
  } catch {
    res.status(500).json({ error: 'sms_config_read_failed' });
  }
});

// ─── PUT — save config ───────────────────────────────────────────
const saveSchema = z
  .object({
    providerName: z.literal('kavenegar'),
    enabled: z.boolean(),
    apiKey: z.string().max(512).optional(),
    sender: z.string().max(64).optional(),
    verifyTemplate: z.string().regex(VERIFY_TEMPLATE_PATTERN),
  })
  .strict();

adminSmsProvidersRouter.put('/', async (req: Request, res: Response) => {
  const parsed = saveSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_sms_config' });
  }
  const userId = adminId(req);
  if (!userId) return res.status(401).json({ error: 'Missing authorization' });

  try {
    const { providerName, enabled, apiKey, sender, verifyTemplate } = parsed.data;
    const info = await saveSmsProviderConfig(
      ctx(req).serverConfig,
      {
        providerName,
        enabled,
        verifyTemplate,
        ...(apiKey !== undefined ? { apiKey } : {}),
        ...(sender !== undefined ? { sender } : {}),
      },
      userId,
    );
    res.json(info);
  } catch (err) {
    if (err instanceof SmsConfigValidationError) {
      const status = err.reason === 'save_failed' ? 500 : 400;
      return res.status(status).json({ error: err.reason });
    }
    res.status(500).json({ error: 'sms_config_save_failed' });
  }
});

// ─── DELETE — disable and wipe credential ────────────────────────
adminSmsProvidersRouter.delete('/', async (req: Request, res: Response) => {
  const userId = adminId(req);
  if (!userId) return res.status(401).json({ error: 'Missing authorization' });
  try {
    const info = await deleteSmsProviderConfig(ctx(req).serverConfig, userId);
    res.json(info);
  } catch {
    res.status(500).json({ error: 'sms_config_delete_failed' });
  }
});

// ─── POST /test — account info only, never sends an SMS ──────────
adminSmsProvidersRouter.post('/test', async (req: Request, res: Response) => {
  const userId = adminId(req);
  if (!userId) return res.status(401).json({ error: 'Missing authorization' });
  if (!allowTest(userId)) {
    return res.status(429).json({ error: 'too_many_test_requests' });
  }
  const result = await testSmsProvider(ctx(req).serverConfig);
  if (result.success) {
    return res.json({
      success: true,
      provider: result.provider,
      latencyMs: result.latencyMs,
      balance: result.balance ?? null,
      currency: result.currency ?? 'IRR',
      accountType: result.accountType ?? null,
    });
  }
  res.json({
    success: false,
    provider: result.provider,
    error: result.error ?? 'SMS provider returned an error',
    errorCode: result.errorCode ?? 'sms_provider_error',
  });
});
