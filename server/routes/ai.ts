/**
 * AI API Routes — server-side only, all secrets stay on backend: the
 * provider connection test (platform admin) and a workspace's resolved AI
 * provider info.
 */

import { Router } from 'express';
import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import { resolveAIConfig } from '../services/ai/index.js';
import { runtimeTestConnection, AiRuntimeError } from '../services/ai/runtimeClient.js';
import {
  authorizeWorkspaceAccess,
  requirePlatformAdmin,
} from '../lib/workspaceAuth.js';
import { checkWorkspaceProviderBaseUrl } from '../../shared/ai/endpointPolicy.js';


export const aiRouter = Router();

/** Fields the server attaches to every request before route handlers run. */
interface AiRouteRequestExtras {
  serverConfig: ServerConfig;
}

/** Reads `.message` exactly like the untyped handlers did (no normalisation). */
function messageOf(err: unknown): string | undefined {
  return (err as { message?: string }).message;
}

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
    const config: ServerConfig = (req as typeof req & AiRouteRequestExtras).serverConfig;
    // Provider connection testing is a platform-admin operation: it makes the
    // AI Runtime issue an outbound request with operator-supplied parameters.
    if (!(await requirePlatformAdmin(req, res))) return;


    const parsed = testSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid input' });
    }

    // SSRF pre-check in Core (fail-closed) on the operator-supplied endpoint.
    // The connection itself is made by the AI Runtime, which re-validates and
    // pins DNS inside its own transport — Core never opens the socket.
    // Same policy as workspace endpoints: public https, or a host explicitly
    // allow-listed by the operator in AI_PROVIDER_PRIVATE_HOSTS.
    if (parsed.data.baseUrl) {
      const urlCheck = await checkWorkspaceProviderBaseUrl(parsed.data.baseUrl);
      if (!urlCheck.ok) {
        return res.status(400).json({ success: false, error: 'baseUrl is not an allowed https endpoint' });
      }
    }

    const result = await runtimeTestConnection(config, {
      provider: parsed.data.provider,
      apiKey: parsed.data.apiKey,
      model: parsed.data.model || 'gpt-4o-mini',
      baseUrl: parsed.data.baseUrl,
      orgId: parsed.data.orgId,
    });

    return res.json(result);
  } catch (err: unknown) {
    // A runtime-boundary failure is surfaced verbatim (with its stable code) so
    // operators see "AI runtime not configured/unreachable" instead of a
    // misleading "provider rejected your key".
    if (err instanceof AiRuntimeError) {
      return res.status(502).json({ success: false, error: err.message, code: err.code });
    }
    return res.status(500).json({ success: false, error: messageOf(err) });
  }
});


/**
 * GET /api/ai/config/:workspaceId — Get resolved AI provider info.
 */
aiRouter.get('/config/:workspaceId', async (req, res) => {
  try {
    const config: ServerConfig = (req as typeof req & AiRouteRequestExtras).serverConfig;
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
  } catch (err: unknown) {
    return res.status(500).json({ error: messageOf(err) });
  }
});
