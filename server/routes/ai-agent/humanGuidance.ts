/**
 * AI Agent router — human guidance domain (vNext).
 *
 * Private operator → AI steering for a single conversation. Everything here
 * is invisible to the visitor: nothing in this file ever writes to
 * conversation_messages or triggers a channel send.
 *
 * Security contract:
 *   - every route resolves workspaceId from the CONVERSATION row, never from
 *     client input, and then authorizes the caller against that workspace's
 *     Inbox (authorizeInboxAccess: the Inbox's roles only, audit ai-2), and a
 *     conversation the plan locked is refused as the Inbox refuses it;
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
import { replyNowWithGuidance, checkReplyNowEligibility } from '../../services/ai-agent/replyNow.js';
import { operatorSayNow, MAX_SAY_NOW_BODY } from '../../services/ai-agent/sayNow.js';
import { authorizeInboxAccess } from '../../lib/inboxAccess.js';
import { conversationLockedBody, conversationLockedNow } from '../../services/contactChatLocks.js';


export const humanGuidanceRouter: Router = express.Router();

type ConfiguredRequest = Request & { serverConfig?: ServerConfig };

/** The conversation's workspace and the dates its plan lock reads (never trust the client). */
async function readConversation(
  config: ServerConfig,
  conversationId: string,
): Promise<{ workspace_id: string; created_at: string | null; updated_at: string | null } | null> {
  const sb = getServiceClient(config);
  const { data } = await sb
    .from('conversations')
    .select('workspace_id, created_at, updated_at')
    .eq('id', conversationId)
    .maybeSingle();
  const row = data as { workspace_id?: string | null; created_at?: string | null; updated_at?: string | null } | null;
  return row?.workspace_id
    ? { workspace_id: row.workspace_id, created_at: row.created_at ?? null, updated_at: row.updated_at ?? null }
    : null;
}

/**
 * The caller may steer the AI in this conversation: they hold the Inbox of
 * its workspace (staff roles without the Inbox, such as viewer or billing,
 * are refused with `inbox_not_allowed`), and the plan has not locked it
 * (conversations.ts's lock: 403 with the lock body; an unreadable lock state
 * refuses nothing).
 */
async function authorizeConversation(
  req: Request,
  res: Response,
  conversationId: string,
): Promise<{ workspaceId: string; userId: string } | null> {
  const config = (req as ConfiguredRequest).serverConfig as ServerConfig;
  const conv = await readConversation(config, conversationId);
  if (!conv) {
    res.status(404).json({ error: 'conversation_not_found' });
    return null;
  }
  const auth = await authorizeInboxAccess(req, res, conv.workspace_id);
  if (!auth) return null;
  const { locked, state } = await conversationLockedNow(config, conv.workspace_id, conv);
  if (locked) {
    res.status(403).json(conversationLockedBody(state));
    return null;
  }
  return { workspaceId: conv.workspace_id, userId: auth.userId };
}

const idSchema = z.string().uuid();

// ─── GET /api/ai-agent/conversations/:id/guidance ──────────────────────
// Operator-only view: active guidance + pending AI questions.
humanGuidanceRouter.get('/conversations/:id/guidance', async (req: Request, res: Response) => {
  const config = (req as ConfiguredRequest).serverConfig as ServerConfig;
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
  const config = (req as ConfiguredRequest).serverConfig as ServerConfig;
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
  if (result.ok !== true) {
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

// ─── POST /api/ai-agent/conversations/:id/ai-reply-now ─────────────────
// Human Guidance UX: the operator (optionally) writes a private instruction
// and asks the assistant to answer the visitor NOW. The answer is produced by
// the real Core AI Agent pipeline against the latest visitor message — this
// endpoint never renders the guidance text as a reply.
const replyNowSchema = z.object({
  body: z.string().max(MAX_GUIDANCE_BODY).optional(),
  kind: z.enum(['direction', 'fact']).default('direction'),
  scope: z.enum(['next_turn', 'conversation']).default('next_turn'),
  requestId: z.string().uuid().optional(),
  idempotencyKey: z.string().min(8).max(120).optional(),
});

humanGuidanceRouter.post('/conversations/:id/ai-reply-now', async (req: Request, res: Response) => {
  const config = (req as ConfiguredRequest).serverConfig as ServerConfig;
  const parsedId = idSchema.safeParse(req.params.id);
  if (!parsedId.success) return res.status(400).json({ error: 'invalid_conversation_id' });
  const ctx = await authorizeConversation(req, res, parsedId.data);
  if (!ctx) return;

  const parsed = replyNowSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_body', details: parsed.error.flatten() });
  }

  const sb = getServiceClient(config);
  const { data: profile } = await sb
    .from('profiles')
    .select('full_name')
    .eq('id', ctx.userId)
    .maybeSingle();

  const result = await replyNowWithGuidance(config, {
    workspaceId: ctx.workspaceId,
    conversationId: parsedId.data,
    operatorId: ctx.userId,
    operatorName: (profile as { full_name?: string | null } | null)?.full_name || null,
    body: parsed.data.body || null,
    kind: parsed.data.kind,
    scope: parsed.data.scope,
    requestId: parsed.data.requestId || null,
    idempotencyKey: parsed.data.idempotencyKey || null,
  });

  if (result.ok !== true) {
    return res.status(409).json({ error: result.reason, detail: result.detail });
  }
  return res.json({
    guidance: result.guidance,
    visitorMessageId: result.visitorMessageId,
    deduplicated: result.deduplicated,
    action: result.run.action,
    reason: result.run.reason || null,
    messageId: result.run.messageId || null,
    runId: result.run.runId || null,
  });
});

// ─── GET /api/ai-agent/conversations/:id/ai-reply-now/eligibility ──────
humanGuidanceRouter.get('/conversations/:id/ai-reply-now/eligibility', async (req: Request, res: Response) => {
  const config = (req as ConfiguredRequest).serverConfig as ServerConfig;
  const parsedId = idSchema.safeParse(req.params.id);
  if (!parsedId.success) return res.status(400).json({ error: 'invalid_conversation_id' });
  const ctx = await authorizeConversation(req, res, parsedId.data);
  if (!ctx) return;
  const eligibility = await checkReplyNowEligibility(config, {
    workspaceId: ctx.workspaceId,
    conversationId: parsedId.data,
  });
  return res.json({
    eligible: eligibility.eligible,
    reason: eligibility.reason,
    visitorMessageId: eligibility.visitorMessage?.id || null,
  });
});

// ─── POST /api/ai-agent/conversations/:id/ai-say-now ───────────────────
// Operator dictation → the AI rewrites it in the assistant's voice and
// delivers it to the visitor immediately. Unlike guidance this is NOT stored
// as an instruction, and unlike "AI Reply Now" it does not need a pending
// visitor message: the operator decides the content of this very message.
const sayNowSchema = z.object({
  body: z.string().min(1).max(MAX_SAY_NOW_BODY),
  attribution: z.enum(['specialist', 'assistant']).optional(),
  locale: z.string().max(10).optional(),
});

humanGuidanceRouter.post('/conversations/:id/ai-say-now', async (req: Request, res: Response) => {
  const config = (req as ConfiguredRequest).serverConfig as ServerConfig;
  const parsedId = idSchema.safeParse(req.params.id);
  if (!parsedId.success) return res.status(400).json({ error: 'invalid_conversation_id' });
  const ctx = await authorizeConversation(req, res, parsedId.data);
  if (!ctx) return;

  const parsed = sayNowSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body' });

  const sb = getServiceClient(config);
  const { data: profile } = await sb
    .from('profiles')
    .select('full_name')
    .eq('id', ctx.userId)
    .maybeSingle();

  const result = await operatorSayNow(config, {
    workspaceId: ctx.workspaceId,
    conversationId: parsedId.data,
    operatorId: ctx.userId,
    operatorName: (profile as { full_name?: string | null } | null)?.full_name || null,
    body: parsed.data.body,
    attribution: parsed.data.attribution,
    locale: parsed.data.locale || null,
  });
  if (result.ok !== true) {
    return res.status(result.httpStatus || 400).json({ error: result.reason, detail: result.detail });
  }
  return res.json({ ok: true, messageId: result.messageId, text: result.text, runId: result.runId });
});

// ─── DELETE /api/ai-agent/guidance/:guidanceId ─────────────────────────
humanGuidanceRouter.delete('/guidance/:guidanceId', async (req: Request, res: Response) => {
  const config = (req as ConfiguredRequest).serverConfig as ServerConfig;
  const parsedId = idSchema.safeParse(req.params.guidanceId);
  if (!parsedId.success) return res.status(400).json({ error: 'invalid_guidance_id' });

  const sb = getServiceClient(config);
  const { data } = await sb
    .from('ai_agent_guidance')
    .select('workspace_id,conversation_id')
    .eq('id', parsedId.data)
    .maybeSingle();
  const guidance = data as { workspace_id?: string | null; conversation_id?: string } | null;
  const workspaceId = guidance?.workspace_id;
  if (!workspaceId) return res.status(404).json({ error: 'guidance_not_found' });
  const auth = await authorizeInboxAccess(req, res, workspaceId);
  if (!auth) return;

  const ok = await revokeGuidance(config, {
    workspaceId,
    conversationId: guidance?.conversation_id as string,
    guidanceId: parsedId.data,
  });
  if (!ok) return res.status(400).json({ error: 'guidance_revoke_failed' });
  return res.json({ ok: true });
});

// ─── POST /api/ai-agent/guidance-requests/:requestId/dismiss ───────────
// Operator declines to answer the AI's question. The AI must then continue
// with what it already knows (or escalate through the normal policy).
humanGuidanceRouter.post('/guidance-requests/:requestId/dismiss', async (req: Request, res: Response) => {
  const config = (req as ConfiguredRequest).serverConfig as ServerConfig;
  const parsedId = idSchema.safeParse(req.params.requestId);
  if (!parsedId.success) return res.status(400).json({ error: 'invalid_request_id' });

  const sb = getServiceClient(config);
  const { data } = await sb
    .from('ai_agent_guidance_requests')
    .select('workspace_id')
    .eq('id', parsedId.data)
    .maybeSingle();
  const workspaceId = (data as { workspace_id?: string | null } | null)?.workspace_id;
  if (!workspaceId) return res.status(404).json({ error: 'request_not_found' });
  const auth = await authorizeInboxAccess(req, res, workspaceId);
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
