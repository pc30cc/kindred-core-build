/**
 * AI Agent router — human guidance domain (vNext).
 *
 * Private operator → AI steering for a single conversation. Everything here
 * is invisible to the visitor: nothing in this file ever writes to
 * conversation_messages or triggers a channel send.
 *
 * Security contract:
 *   - every route resolves workspaceId from the CONVERSATION row, never from
 *     client input, and then authorizes the caller against that workspace;
 *   - guidance bodies are length-clamped and stored as data, never executed;
 *   - guidance can raise the AI's knowledge for one conversation, but it can
 *     never grant a capability the workspace configuration does not allow —
 *     action authorization stays entirely with the deterministic gate.
 */
import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import {
  createGuidance, revokeGuidance, listGuidance,
  listGuidanceRequests, resolveGuidanceRequest,
  MAX_GUIDANCE_BODY,
} from '../../services/ai-agent/guidance.js';
import { authorizeMember } from './shared.js';

export const humanGuidanceRouter: Router = express.Router();

/** Resolve the owning workspace from the conversation itself (never trust the client). */
async function resolveConversationWorkspace(
  config: ServerConfig,
  conversationId: string,
): Promise<string | null> {
  const sb = getServiceClient(config);
  const { data } = await sb
    .from('conversations')
    .select('workspace_id')
    .eq('id', conversationId)
    .maybeSingle();
  return (data as any)?.workspace_id || null;
}

async function authorizeConversation(
  req: Request,
  res: Response,
  conversationId: string,
): Promise<{ workspaceId: string; userId: string } | null> {
  const config = (req as any).serverConfig as ServerConfig;
  const workspaceId = await resolveConversationWorkspace(config, conversationId);
  if (!workspaceId) {
    res.status(404).json({ error: 'conversation_not_found' });
    return null;
  }
  const auth = await authorizeMember(req, res, config, workspaceId);
  if (!auth) return null;
  return { workspaceId, userId: auth.userId };
}

const idSchema = z.string().uuid();

// ─── GET /api/ai-agent/conversations/:id/guidance ──────────────────────
// Operator-only view: active guidance + pending AI questions.
humanGuidanceRouter.get('/conversations/:id/guidance', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const parsedId = idSchema.safeParse(req.params.id);
  if (!parsedId.success) return res.status(400).json({ error: 'invalid_conversation_id' });
  const ctx = await authorizeConversation(req, res, parsedId.data);
  if (!ctx) return;

  const [items, requests] = await Promise.all([
    listGuidance(config, { workspaceId: ctx.workspaceId, conversationId: parsedId.data, status: 'active' }),
    listGuidanceRequests(config, { workspaceId: ctx.workspaceId, conversationId: parsedId.data, status: 'pending' }),
  ]);
  return res.json({ items, requests, maxBody: MAX_GUIDANCE_BODY });
});

// ─── POST /api/ai-agent/conversations/:id/guidance ─────────────────────
// Operator writes a private instruction or fact for the AI.
const createSchema = z.object({
  body: z.string().min(1).max(MAX_GUIDANCE_BODY),
  kind: z.enum(['direction', 'fact']).default('direction'),
  scope: z.enum(['next_turn', 'conversation']).default('conversation'),
  /** Optional: answers a specific AI guidance request. */
  requestId: z.string().uuid().optional(),
});

humanGuidanceRouter.post('/conversations/:id/guidance', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const parsedId = idSchema.safeParse(req.params.id);
  if (!parsedId.success) return res.status(400).json({ error: 'invalid_conversation_id' });
  const ctx = await authorizeConversation(req, res, parsedId.data);
  if (!ctx) return;

  const parsed = createSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_body', details: parsed.error.flatten() });
  }

  const result = await createGuidance(config, {
    workspaceId: ctx.workspaceId,
    conversationId: parsedId.data,
    operatorId: ctx.userId,
    body: parsed.data.body,
    kind: parsed.data.kind,
    scope: parsed.data.scope,
    requestId: parsed.data.requestId || null,
  });
  if (!result.ok) {
    return res.status(400).json({ error: result.error || 'guidance_create_failed' });
  }

  if (parsed.data.requestId) {
    await resolveGuidanceRequest(config, {
      workspaceId: ctx.workspaceId,
      requestId: parsed.data.requestId,
      guidanceId: result.guidance.id,
      resolvedBy: ctx.userId,
    }).catch(() => {});
  }

  return res.status(201).json({ guidance: result.guidance });
});

// ─── DELETE /api/ai-agent/guidance/:guidanceId ─────────────────────────
humanGuidanceRouter.delete('/guidance/:guidanceId', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const parsedId = idSchema.safeParse(req.params.guidanceId);
  if (!parsedId.success) return res.status(400).json({ error: 'invalid_guidance_id' });

  const sb = getServiceClient(config);
  const { data } = await sb
    .from('ai_agent_guidance')
    .select('workspace_id,conversation_id')
    .eq('id', parsedId.data)
    .maybeSingle();
  const workspaceId = (data as any)?.workspace_id;
  if (!workspaceId) return res.status(404).json({ error: 'guidance_not_found' });
  const auth = await authorizeMember(req, res, config, workspaceId);
  if (!auth) return;

  const ok = await revokeGuidance(config, {
    workspaceId,
    conversationId: (data as any).conversation_id,
    guidanceId: parsedId.data,
  });
  if (!ok) return res.status(400).json({ error: 'guidance_revoke_failed' });
  return res.json({ ok: true });
});

// ─── POST /api/ai-agent/guidance-requests/:requestId/dismiss ───────────
// Operator declines to answer the AI's question. The AI must then continue
// with what it already knows (or escalate through the normal policy).
humanGuidanceRouter.post('/guidance-requests/:requestId/dismiss', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const parsedId = idSchema.safeParse(req.params.requestId);
  if (!parsedId.success) return res.status(400).json({ error: 'invalid_request_id' });

  const sb = getServiceClient(config);
  const { data } = await sb
    .from('ai_agent_guidance_requests')
    .select('workspace_id')
    .eq('id', parsedId.data)
    .maybeSingle();
  const workspaceId = (data as any)?.workspace_id;
  if (!workspaceId) return res.status(404).json({ error: 'request_not_found' });
  const auth = await authorizeMember(req, res, config, workspaceId);
  if (!auth) return;

  const ok = await resolveGuidanceRequest(config, {
    workspaceId,
    requestId: parsedId.data,
    guidanceId: null,
    resolvedBy: auth.userId,
    dismissed: true,
  });
  if (!ok) return res.status(400).json({ error: 'request_dismiss_failed' });
  return res.json({ ok: true });
});
