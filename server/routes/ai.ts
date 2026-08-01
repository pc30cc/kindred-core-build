/**
 * AI API Routes — server-side only, all secrets stay on backend.
 * Now with AI credit deduction, module gating, and usage tracking.
 */

import { Router } from 'express';
import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import { executeAICompletion, testAIConnection, resolveAIConfig } from '../services/ai/index.js';
import { logSecurityEvent } from '../middleware/security.js';
import { checkModuleAccess, deductAICredits, incrementUsage } from '../middleware/featureGating.js';
import {
  authorizeWorkspaceAccess,
  requirePlatformAdmin,
  checkOutboundUrl,
} from '../lib/workspaceAuth.js';

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
 * Strict order (no workspace-scoped service-role work before authorization):
 * 1. parse + validate body
 * 2. real user JWT + workspace membership
 * 3. module entitlement ('ai_assistant')
 * 4. AI credit reservation (atomic deduct — unchanged semantics)
 * 5. rate limit
 * 6. provider execution + usage increment
 */
aiRouter.post('/complete', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;

    const parsed = completionSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten().fieldErrors });
    }

    // Identity comes from a real user JWT; the publishable key is not identity.
    if (!(await authorizeWorkspaceAccess(req, res, parsed.data.workspaceId))) return;

    // Module gate (plan + admin override) — after authorization.
    const moduleAccess = await checkModuleAccess(
      config.supabaseUrl,
      config.supabaseServiceRoleKey,
      parsed.data.workspaceId,
      'ai_assistant',
    );
    if (!moduleAccess.allowed) {
      return res.status(403).json({
        error: "Module 'ai_assistant' is not enabled",
        module: 'ai_assistant',
        plan: moduleAccess.plan,
        upgrade_required: true,
      });
    }

    // Credit reservation keeps its existing semantics (deduct before provider call).
    const credits = await deductAICredits(
      config.supabaseUrl,
      config.supabaseServiceRoleKey,
      parsed.data.workspaceId,
      1,
    );
    if (!credits.success) {
      return res.status(403).json({
        error: 'AI credits exhausted or AI not available on your plan',
        reason: credits.reason,
        credits_used: credits.credits_used,
        credits_limit: credits.credits_limit,
        upgrade_required: true,
      });
    }
    (req as any).aiCredits = credits;

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
      credits,
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
    // Provider connection testing is a platform-admin operation: it makes the
    // server issue an outbound request with operator-supplied parameters.
    if (!(await requirePlatformAdmin(req, res))) return;

    const parsed = testSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid input' });
    }

    // SSRF guard: syntactic checks + DNS resolution of every answer (fail-closed).
    if (parsed.data.baseUrl) {
      const urlCheck = await checkOutboundUrl(parsed.data.baseUrl);
      if (!urlCheck.ok) {
        return res.status(400).json({ success: false, error: 'baseUrl is not an allowed https endpoint' });
      }
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
    if (!(await authorizeWorkspaceAccess(req, res, req.params.workspaceId))) return;

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
