/**
 * AI API Routes — server-side only, all secrets stay on backend.
 * Now with AI credit deduction, module gating, and usage tracking.
 */

import { Router } from 'express';
import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import { executeAICompletion, testAIConnection, resolveAIConfig } from '../services/ai/index.js';
import { logSecurityEvent } from '../middleware/security.js';
import { requireModule, requireAICredits, incrementUsage } from '../middleware/featureGating.js';

export const aiRouter = Router();

// Rate limit tracking per workspace
const wsUsageCounters = new Map<string, { count: number; windowStart: number }>();
const AI_RATE_LIMIT = 60;
const AI_WINDOW = 60_000;

function checkAIRateLimit(workspaceId: string): boolean {
  const now = Date.now();
  const counter = wsUsageCounters.get(workspaceId);
  if (!counter || now - counter.windowStart > AI_WINDOW) {
    wsUsageCounters.set(workspaceId, { count: 1, windowStart: now });
    return true;
  }
  counter.count++;
  return counter.count <= AI_RATE_LIMIT;
}

const completionSchema = z.object({
  workspaceId: z.string().uuid(),
  prompt: z.string().min(1).max(100_000),
  systemPrompt: z.string().max(50_000).optional(),
  model: z.string().max(100).optional(),
  maxTokens: z.number().min(1).max(128_000).optional(),
  temperature: z.number().min(0).max(2).optional(),
});

/**
 * POST /api/ai/complete
 * 1. requireModule('ai_assistant') — checks plan + override
 * 2. requireAICredits(1) — atomically deducts 1 credit, blocks if exhausted
 * 3. rate limit + execution
 */
aiRouter.post('/complete', requireModule('ai_assistant'), requireAICredits(1), async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;

    const authHeader = req.headers.authorization;
    const token = authHeader?.replace('Bearer ', '');
    if (token !== config.supabaseAnonKey && token !== config.supabaseServiceRoleKey) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const parsed = completionSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten().fieldErrors });
    }

    if (!checkAIRateLimit(parsed.data.workspaceId)) {
      await logSecurityEvent(req, 'rate_limited', 'warn', {
        endpoint: '/api/ai/complete',
        workspaceId: parsed.data.workspaceId,
      });
      return res.status(429).json({ error: 'AI rate limit exceeded. Max 60 requests/minute per workspace.' });
    }

    // Build the request explicitly: zod's inferred output marks every property
    // optional under `strictNullChecks: false`, while AIRequest requires
    // workspaceId/prompt. The schema already guarantees both are present.
    const result = await executeAICompletion(config, {
      workspaceId: parsed.data.workspaceId,
      prompt: parsed.data.prompt,
      systemPrompt: parsed.data.systemPrompt,
      model: parsed.data.model,
      maxTokens: parsed.data.maxTokens,
      temperature: parsed.data.temperature,
    });

    // Track usage
    incrementUsage(config.supabaseUrl, config.supabaseServiceRoleKey, parsed.data.workspaceId, 'ai_requests_count');

    return res.json({
      text: result.text,
      model: result.model,
      provider: result.provider,
      usage: {
        promptTokens: result.promptTokens,
        completionTokens: result.completionTokens,
        totalTokens: result.totalTokens,
      },
      latencyMs: result.latencyMs,
      credits: (req as any).aiCredits,
    });
  } catch (err: any) {
    console.error('[ai] Completion error:', err.message);
    return res.status(500).json({ error: err.message || 'AI completion failed' });
  }
});

const testSchema = z.object({
  provider: z.string(),
  apiKey: z.string(),
  model: z.string().optional(),
  baseUrl: z.string().optional(),
  orgId: z.string().optional(),
});

/**
 * POST /api/ai/test — Test AI provider connection.
 */
aiRouter.post('/test', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (token !== config.supabaseServiceRoleKey && token !== config.supabaseAnonKey) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const parsed = testSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid input' });
    }

    const result = await testAIConnection({
      provider: parsed.data.provider,
      apiKey: parsed.data.apiKey,
      model: parsed.data.model || 'gpt-4o-mini',
      baseUrl: parsed.data.baseUrl,
      orgId: parsed.data.orgId,
    });

    return res.json(result);
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/ai/config/:workspaceId — Get resolved AI provider info.
 */
aiRouter.get('/config/:workspaceId', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (token !== config.supabaseAnonKey && token !== config.supabaseServiceRoleKey) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const aiConfig = await resolveAIConfig(config, req.params.workspaceId);
    if (!aiConfig) {
      return res.json({ configured: false });
    }

    return res.json({
      configured: true,
      provider: aiConfig.provider,
      model: aiConfig.model,
      maxTokens: aiConfig.maxTokens,
      temperature: aiConfig.temperature,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});
