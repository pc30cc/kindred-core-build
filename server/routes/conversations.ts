/**
 * Conversations API — backend-mediated agent reply send.
 *
 * Flow (POST /api/conversations/send-message):
 *   1. Verify the caller is an authenticated workspace member.
 *   2. Insert into conversation_messages.
 *   3. Bump conversations.updated_at.
 *   4. Publish a `message` event to the Centrifugo conversation channel
 *      (ws:<workspace_id>:conv:<conversation_id>) so the visitor widget
 *      receives the agent reply live without polling/refresh.
 *   5. Return the inserted row + a `realtime` flag indicating whether the
 *      live publish actually went out (so the inbox UI can show a hint).
 *
 * Auth model:
 *   • Bearer = Supabase user access token (same as src/lib/realtime-admin-api.ts).
 *   • We resolve the user, then verify membership via is_workspace_member RPC.
 *   • All DB writes go through the service-role client — RLS is enforced
 *     at the route layer, not via the user's JWT (matches the admin pattern
 *     already used by /api/realtime/admin and /api/admin).
 */

import { Router } from 'express';
import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';
import {
  publishConversationEvent,
  buildMessageEnvelope,
} from '../services/realtime/publish.js';
import {
  attachUploadedFileToMessage,
  enrichMessagesWithAttachments,
} from './widgetAttachments.js';

export const conversationsRouter = Router();

const sendMessageSchema = z.object({
  conversation_id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  body: z.string().max(50_000).optional().default(''),
  metadata: z.record(z.unknown()).optional(),
  attachment_id: z.string().uuid().nullable().optional(),
}).refine(
  d => (d.body && d.body.trim().length > 0) || !!d.attachment_id,
  { message: 'body or attachment_id required' }
);

/**
 * Authenticate the request as a workspace member.
 * Returns { userId, workspaceId } on success, sends 401/403 on failure.
 */
async function authorizeWorkspaceMember(
  req: any,
  res: any,
  config: ServerConfig,
  workspaceId: string,
): Promise<{ userId: string } | null> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing authorization' });
    return null;
  }
  const token = authHeader.replace('Bearer ', '');
  const sb = getServiceClient(config);
  const {
    data: { user },
    error,
  } = await sb.auth.getUser(token);
  if (error || !user) {
    res.status(401).json({ error: 'Invalid token' });
    return null;
  }

  // Membership check via the same RPC used by RLS policies.
  const { data: isMember, error: memErr } = await sb.rpc('is_workspace_member', {
    _workspace_id: workspaceId,
    _user_id: user.id,
  });
  if (memErr) {
    res.status(500).json({ error: 'Membership check failed' });
    return null;
  }
  if (!isMember) {
    res.status(403).json({ error: 'Not a workspace member' });
    return null;
  }
  return { userId: user.id };
}

/**
 * Operator typing — ephemeral realtime-only event.
 *
 * Phase 1 contract:
 *   - No DB write. The server simply publishes an ephemeral
 *     `{ type: 'typing', payload: { actor: 'agent', conversation_id, ts } }`
 *     envelope on the conversation channel using the active realtime publisher.
 *   - On polling deployments the publish becomes a no-op and typing is silently
 *     not delivered (by design — typing is best-effort).
 *   - Caller must be an authenticated workspace member of the conversation.
 *   - Returns `{ ok, published }` so clients can throttle accordingly.
 */
const typingSchema = z.object({
  conversation_id: z.string().uuid(),
  workspace_id: z.string().uuid(),
});

conversationsRouter.post('/typing', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const parsed = typingSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid payload' });
    }
    const auth = await authorizeWorkspaceMember(req, res, config, parsed.data.workspace_id);
    if (!auth) return;

    // Verify the conversation belongs to this workspace.
    const sb = getServiceClient(config);
    const { data: conv } = await sb
      .from('conversations')
      .select('id, workspace_id')
      .eq('id', parsed.data.conversation_id)
      .maybeSingle();
    if (!conv || conv.workspace_id !== parsed.data.workspace_id) {
      return res.status(404).json({ error: 'Conversation not found in workspace' });
    }

    const pub = await publishConversationEvent(
      config,
      parsed.data.workspace_id,
      parsed.data.conversation_id,
      {
        type: 'typing',
        payload: {
          actor: 'agent',
          conversation_id: parsed.data.conversation_id,
          ts: Date.now(),
        },
      },
    );
    return res.json({ ok: true, published: pub.ok });
  } catch (err: any) {
    console.error('[conversations/typing] error:', err);
    return res.status(500).json({ error: err?.message || 'Internal error' });
  }
});

conversationsRouter.post('/send-message', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const parsed = sendMessageSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'Invalid payload',
        details: parsed.error.flatten().fieldErrors,
      });
    }

    const auth = await authorizeWorkspaceMember(req, res, config, parsed.data.workspace_id);
    if (!auth) return; // response already sent

    const sb = getServiceClient(config);

    // Verify the conversation belongs to this workspace.
    const { data: conv, error: convErr } = await sb
      .from('conversations')
      .select('id, workspace_id')
      .eq('id', parsed.data.conversation_id)
      .maybeSingle();
    if (convErr) return res.status(500).json({ error: convErr.message });
    if (!conv || conv.workspace_id !== parsed.data.workspace_id) {
      return res.status(404).json({ error: 'Conversation not found in workspace' });
    }

    // Insert message. body may be empty when only an attachment is sent.
    const messageBody = parsed.data.body || '';
    const baseMetadata: Record<string, unknown> = {
      ...(parsed.data.metadata ?? {}),
      source: (parsed.data.metadata as any)?.source ?? 'inbox',
    };
    if (parsed.data.attachment_id) baseMetadata.attachment_id = parsed.data.attachment_id;

    const { data: inserted, error: insErr } = await sb
      .from('conversation_messages')
      .insert({
        conversation_id: parsed.data.conversation_id,
        body: messageBody,
        sender_type: 'agent',
        sender_id: auth.userId,
        metadata: baseMetadata,
      })
      .select('id, conversation_id, sender_type, sender_id, body, created_at, metadata, seen_at')
      .single();
    if (insErr || !inserted) {
      return res.status(500).json({ error: insErr?.message || 'Insert failed' });
    }

    // Phase 2 — Bind operator-uploaded attachment to this message + conversation.
    if (parsed.data.attachment_id && inserted?.id) {
      const ok = await attachUploadedFileToMessage(
        config,
        parsed.data.attachment_id,
        parsed.data.workspace_id,
        parsed.data.conversation_id,
        inserted.id,
      );
      if (!ok) {
        console.warn('[conversations/send-message] failed to attach',
          parsed.data.attachment_id, 'to', inserted.id);
      }
    }

    // Bump conversation timestamp (and reopen if needed).
    await sb
      .from('conversations')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', parsed.data.conversation_id);

    // Enrich envelope with public-safe attachment metadata so the visitor
    // widget renders the file via its proxy route. Same shape as visitor flow.
    const [enriched] = await enrichMessagesWithAttachments(
      config, parsed.data.workspace_id, [inserted as any]
    );

    // Publish to realtime — fire-and-forget semantics.
    const pub = await publishConversationEvent(
      config,
      parsed.data.workspace_id,
      parsed.data.conversation_id,
      buildMessageEnvelope(enriched as any),
    );

    return res.json({
      ok: true,
      message: enriched,
      realtime: { published: pub.ok, reason: pub.reason ?? null },
    });
  } catch (err: any) {
    console.error('[conversations/send-message] error:', err);
    return res.status(500).json({ error: err?.message || 'Internal error' });
  }
});
