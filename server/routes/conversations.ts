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
  publishOperatorEvent,
  type OperatorEventPayload,
} from '../services/realtime/publish.js';
import {
  attachUploadedFileToMessage,
  enrichMessagesWithAttachments,
} from './widgetAttachments.js';
import {
  recordConversationEvent,
  recordAuditAndEvent,
} from '../services/conversationEvents.js';
import { isActionActive } from '../services/observability/autoActionsCache.js';
import { emitLog } from '../services/observability/metrics.js';
import { markHumanTakeover } from '../services/ai-agent/handoffState.js';
import { maybeCreateLearningCandidateFromOperatorReply } from '../services/ai-agent/learning/candidates.js';
import { markSpam, unmarkSpam } from '../services/spam/state.js';
import { enforceMaxConversationsLimit } from '../services/billing/conversationLimit.js';
import { authorizeWorkspaceAccess } from '../lib/workspaceAuth.js';
import { dispatchOutboundIfChannelConversation } from '../services/channels/outbound.js';

export const conversationsRouter = Router();

const ALLOWED_STATUSES = ['open', 'pending', 'resolved', 'closed'] as const;
const ALLOWED_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;

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
 * Schema for starting a proactive conversation from the Visitors page.
 * The operator targets a visitor_session; we either reuse the most-recent
 * open conversation tied to that session, or create a new one.
 */
const startFromVisitorSchema = z.object({
  workspace_id: z.string().uuid(),
  visitor_session_id: z.string().uuid(),
});

/**
 * Authenticate the request as a workspace member.
 * Returns { userId } on success, sends 401/403 on failure. Delegates to the
 * central first-party session helper (server/lib/workspaceAuth.ts).
 */
async function authorizeWorkspaceMember(
  req: any,
  res: any,
  _config: ServerConfig,
  workspaceId: string,
): Promise<{ userId: string } | null> {
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return null;
  return { userId: auth.userId };
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

    // Phase 5C.1 — server-side typing suppression while the
    // disable_typing_temporarily auto-action is active. Drop without
    // touching the realtime publisher. Message send is unaffected.
    if (isActionActive('disable_typing_temporarily')) {
      emitLog(config, 'info', 'auto_action_effect_applied', {
        action_type: 'disable_typing_temporarily',
        workspace_id: parsed.data.workspace_id,
        conversation_id: parsed.data.conversation_id,
        surface: 'operator',
        ts: Date.now(),
      });
      return res.json({ ok: true, published: false, reason: 'auto_action_suppressed' });
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

    // Channel bridge: if this conversation came from a plugin channel
    // (Telegram, …), queue durable delivery back to the provider. No-op for
    // widget conversations.
    void dispatchOutboundIfChannelConversation(config, {
      workspaceId: parsed.data.workspace_id,
      conversationId: parsed.data.conversation_id,
      messageId: inserted.id,
      body: messageBody,
    });


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

    // Phase 3 — record attachment_added event (timeline-only) when applicable.
    if (parsed.data.attachment_id) {
      void recordConversationEvent(config, {
        workspaceId: parsed.data.workspace_id,
        conversationId: parsed.data.conversation_id,
        eventType: 'attachment_added',
        actorType: 'agent',
        actorId: auth.userId,
        payload: {
          message_id: inserted.id,
          attachment_id: parsed.data.attachment_id,
        },
      });
    }

    // AI Agent — explicit human takeover marker. Once an operator replies,
    // the conversation leaves the Automated inbox and the AI must back off
    // (in `auto_reply_until_human_joins` and, by default, also in
    // `auto_reply_always` via pause_auto_reply_after_human_reply=true).
    void markHumanTakeover(config, {
      workspaceId: parsed.data.workspace_id,
      conversationId: parsed.data.conversation_id,
      operatorId: auth.userId,
      reason: 'operator_replied',
    }).catch((e: any) =>
      console.warn('[conversations/send-message] markHumanTakeover failed:', e?.message),
    );

    // AI Agent — learning candidate v1. Pair this operator reply with the
    // visitor's last question if the AI recently bailed out. Best-effort.
    if (inserted?.id && (parsed.data.body || '').trim().length > 0) {
      void maybeCreateLearningCandidateFromOperatorReply(config, {
        workspaceId: parsed.data.workspace_id,
        conversationId: parsed.data.conversation_id,
        operatorMessageId: inserted.id,
        operatorMessageBody: parsed.data.body || '',
        operatorId: auth.userId,
      }).catch((e: any) =>
        console.warn('[conversations/send-message] learning candidate hook failed:', e?.message),
      );
    }

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

// ═══════════════════════════════════════════════════════════════════
// POST /api/conversations/start-from-visitor
//
// Operator-initiated outreach from the Visitors page. Given a visitor
// session, returns an existing open conversation (most-recent) or
// creates a fresh one tied to that session + its contact (if any).
// Idempotent for repeated clicks: an open conversation is reused.
// ═══════════════════════════════════════════════════════════════════
conversationsRouter.post('/start-from-visitor', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const parsed = startFromVisitorSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'Invalid payload',
        details: parsed.error.flatten().fieldErrors,
      });
    }
    const auth = await authorizeWorkspaceMember(req, res, config, parsed.data.workspace_id);
    if (!auth) return;

    const sb = getServiceClient(config);

    // Verify the visitor session belongs to this workspace.
    const { data: session, error: sessErr } = await sb
      .from('visitor_sessions')
      .select('id, workspace_id, contact_id, visitor_id')
      .eq('id', parsed.data.visitor_session_id)
      .eq('workspace_id', parsed.data.workspace_id)
      .maybeSingle();
    if (sessErr) return res.status(500).json({ error: sessErr.message });
    if (!session) return res.status(404).json({ error: 'Visitor session not found' });

    // Reuse the most-recent NON-resolved/closed conversation for this
    // visitor session if one exists — avoids spawning duplicates when
    // operators click the button multiple times.
    const { data: existing } = await sb
      .from('conversations')
      .select('id, status')
      .eq('workspace_id', parsed.data.workspace_id)
      .eq('visitor_session_id', parsed.data.visitor_session_id)
      .in('status', ['open', 'pending'])
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (existing?.id) {
      return res.json({ ok: true, conversation_id: existing.id, created: false });
    }

    // Phase 5 — enforce max_conversations only on the actual creation
    // branch. Reuse of an existing open/pending conversation above does
    // not count. workspace_id is already verified via authorizeWorkspaceMember.
    {
      const ok = await enforceMaxConversationsLimit(req, res);
      if (!ok) return;
    }

    // Create a new conversation. We do NOT seed a message — the operator
    // composes their first message in the inbox, which routes through the
    // existing /send-message endpoint (carrying realtime publish, attachments,
    // and timeline events for free).
    const { data: created, error: createErr } = await sb
      .from('conversations')
      .insert({
        workspace_id: parsed.data.workspace_id,
        visitor_session_id: parsed.data.visitor_session_id,
        contact_id: session.contact_id ?? null,
        status: 'open',
        priority: 'normal',
      })
      .select('id')
      .single();

    if (createErr || !created) {
      return res.status(500).json({ error: createErr?.message || 'Create failed' });
    }

    // Timeline event so the inbox shows where this conversation came from.
    void recordConversationEvent(config, {
      workspaceId: parsed.data.workspace_id,
      conversationId: created.id,
      eventType: 'conversation_started',
      actorType: 'agent',
      actorId: auth.userId,
      payload: {
        source: 'visitor_outreach',
        visitor_session_id: parsed.data.visitor_session_id,
        visitor_id: session.visitor_id,
      },
    });

    return res.json({ ok: true, conversation_id: created.id, created: true });
  } catch (err: any) {
    console.error('[conversations/start-from-visitor] error:', err);
    return res.status(500).json({ error: err?.message || 'Internal error' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// Phase 3 — PATCH /api/conversations/:id
// Editable fields: status, priority, assigned_to, tags
// Each change records a normalized conversation_events row + audit_log.
// We intentionally do NOT add a new realtime envelope type — the
// 'message'|'typing'|'seen' contract stays untouched. Inbox refreshes
// via React Query invalidation on the success response. Widget is unaffected.
// ═══════════════════════════════════════════════════════════════════
const patchConversationSchema = z.object({
  workspace_id: z.string().uuid(),
  status: z.enum(ALLOWED_STATUSES).optional(),
  priority: z.enum(ALLOWED_PRIORITIES).optional(),
  assigned_to: z.string().uuid().nullable().optional(),
  tags: z.array(z.string().min(1).max(50)).max(20).optional(),
}).refine(
  d => d.status !== undefined || d.priority !== undefined
    || d.assigned_to !== undefined || d.tags !== undefined,
  { message: 'No editable field provided' }
);

conversationsRouter.patch('/:id', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const parsed = patchConversationSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'Invalid payload',
        details: parsed.error.flatten().fieldErrors,
      });
    }
    const auth = await authorizeWorkspaceMember(req, res, config, parsed.data.workspace_id);
    if (!auth) return;

    const sb = getServiceClient(config);
    const conversationId = req.params.id;

    // Load current row to verify workspace ownership AND compute the diff.
    const { data: before, error: loadErr } = await sb
      .from('conversations')
      .select('id, workspace_id, status, priority, assigned_to, tags')
      .eq('id', conversationId)
      .maybeSingle();
    if (loadErr) return res.status(500).json({ error: loadErr.message });
    if (!before || before.workspace_id !== parsed.data.workspace_id) {
      return res.status(404).json({ error: 'Conversation not found in workspace' });
    }

    // Verify the assignee (if any) is also a workspace member.
    if (parsed.data.assigned_to) {
      const { data: targetIsMember } = await sb.rpc('is_workspace_member', {
        _workspace_id: parsed.data.workspace_id,
        _user_id: parsed.data.assigned_to,
      });
      if (!targetIsMember) {
        return res.status(400).json({ error: 'Assignee is not a workspace member' });
      }
    }

    // Build the update set. Tags are normalized (trim, dedupe, lowercase).
    const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (parsed.data.status !== undefined) update.status = parsed.data.status;
    if (parsed.data.priority !== undefined) update.priority = parsed.data.priority;
    if (parsed.data.assigned_to !== undefined) update.assigned_to = parsed.data.assigned_to;
    let normalizedTags: string[] | undefined;
    if (parsed.data.tags !== undefined) {
      const seen = new Set<string>();
      normalizedTags = [];
      for (const raw of parsed.data.tags) {
        const tag = String(raw).trim().toLowerCase();
        if (!tag || seen.has(tag)) continue;
        seen.add(tag);
        normalizedTags.push(tag);
      }
      update.tags = normalizedTags;
    }

    const { data: after, error: updErr } = await sb
      .from('conversations')
      .update(update)
      .eq('id', conversationId)
      .select('id, workspace_id, status, priority, assigned_to, tags, updated_at')
      .single();
    if (updErr || !after) {
      return res.status(500).json({ error: updErr?.message || 'Update failed' });
    }

    // ─── Record events + audit per changed field ───
    const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim()
      || req.socket?.remoteAddress
      || null;

    const eventBase = {
      workspaceId: parsed.data.workspace_id,
      conversationId,
      actorType: 'agent' as const,
      actorId: auth.userId,
      ipAddress: ip,
    };

    // Build a single `conversation_updated` payload describing every field
    // that actually changed. Used for the realtime `event` envelope below.
    const changes: Record<string, { from: unknown; to: unknown } | { added: string[]; removed: string[] }> = {};
    let statusEvType: 'status_changed' | 'resolved' | 'reopened' | null = null;

    if (parsed.data.status !== undefined && before.status !== parsed.data.status) {
      const wasResolved = before.status === 'resolved' || before.status === 'closed';
      const nowResolved = parsed.data.status === 'resolved' || parsed.data.status === 'closed';
      statusEvType = 'status_changed';
      if (!wasResolved && nowResolved) statusEvType = 'resolved';
      else if (wasResolved && !nowResolved) statusEvType = 'reopened';
      changes.status = { from: before.status, to: parsed.data.status };
      void recordAuditAndEvent(config, {
        ...eventBase,
        eventType: statusEvType,
        auditAction: 'conversation.status_changed',
        oldValue: { status: before.status },
        newValue: { status: parsed.data.status },
        payload: { from: before.status, to: parsed.data.status },
      });
    }

    if (parsed.data.priority !== undefined && before.priority !== parsed.data.priority) {
      changes.priority = { from: before.priority, to: parsed.data.priority };
      void recordAuditAndEvent(config, {
        ...eventBase,
        eventType: 'priority_changed',
        auditAction: 'conversation.priority_changed',
        oldValue: { priority: before.priority },
        newValue: { priority: parsed.data.priority },
        payload: { from: before.priority, to: parsed.data.priority },
      });
    }

    if (parsed.data.assigned_to !== undefined && before.assigned_to !== parsed.data.assigned_to) {
      changes.assigned_to = { from: before.assigned_to, to: parsed.data.assigned_to };
      void recordAuditAndEvent(config, {
        ...eventBase,
        eventType: parsed.data.assigned_to ? 'assigned' : 'unassigned',
        auditAction: parsed.data.assigned_to ? 'conversation.assigned' : 'conversation.unassigned',
        oldValue: { assigned_to: before.assigned_to },
        newValue: { assigned_to: parsed.data.assigned_to },
        payload: { from: before.assigned_to, to: parsed.data.assigned_to },
      });
    }

    if (normalizedTags !== undefined) {
      const beforeTags = new Set<string>((before.tags as string[] | null) ?? []);
      const afterTags = new Set<string>(normalizedTags);
      const added = [...afterTags].filter(t => !beforeTags.has(t));
      const removed = [...beforeTags].filter(t => !afterTags.has(t));
      if (added.length || removed.length) {
        changes.tags = { added, removed };
      }
      for (const tag of added) {
        void recordConversationEvent(config, {
          ...eventBase,
          eventType: 'tag_added',
          payload: { tag },
        });
      }
      for (const tag of removed) {
        void recordConversationEvent(config, {
          ...eventBase,
          eventType: 'tag_removed',
          payload: { tag },
        });
      }
    }

    // ─── Realtime push (Phase 5) ───
    // Operator-only `event` envelope. Fans out to the per-conversation
    // channel AND the workspace inbox channel. Best-effort, non-blocking.
    if (Object.keys(changes).length > 0) {
      const kind: OperatorEventPayload['kind'] =
        statusEvType === 'resolved' ? 'conversation_resolved'
        : statusEvType === 'reopened' ? 'conversation_reopened'
        : 'conversation_updated';
      void publishOperatorEvent(config, {
        kind,
        conversation_id: conversationId,
        workspace_id: parsed.data.workspace_id,
        actor_id: auth.userId,
        changes,
        updated_at: after.updated_at,
      });
    }

    return res.json({ ok: true, conversation: after });
  } catch (err: any) {
    console.error('[conversations PATCH] error:', err);
    return res.status(500).json({ error: err?.message || 'Internal error' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// POST /api/conversations/:id/claim
// Manual-routing-mode claim: the first operator to claim an unassigned
// conversation owns it. Atomic via public.claim_conversation() — unlike
// the PATCH assigned_to path above (a plain read-then-write, fine for a
// deliberate reassignment by anyone with permission), this is a
// compare-and-set so two operators racing to claim the same conversation
// can never both succeed.
// ═══════════════════════════════════════════════════════════════════
const claimConversationSchema = z.object({
  workspace_id: z.string().uuid(),
});

conversationsRouter.post('/:id/claim', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const parsed = claimConversationSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid payload', details: parsed.error.flatten().fieldErrors });
    }
    const auth = await authorizeWorkspaceMember(req, res, config, parsed.data.workspace_id);
    if (!auth) return;

    const sb = getServiceClient(config);
    const conversationId = req.params.id;
    const { data: before } = await sb
      .from('conversations')
      .select('id, workspace_id, assigned_to')
      .eq('id', conversationId)
      .maybeSingle();
    if (!before || before.workspace_id !== parsed.data.workspace_id) {
      return res.status(404).json({ error: 'Conversation not found in workspace' });
    }

    const { claimConversationManually } = await import('../services/chatRouting.js');
    const result = await claimConversationManually(config, {
      workspaceId: parsed.data.workspace_id,
      conversationId,
      userId: auth.userId,
    });

    if (!result.claimed) {
      return res.status(409).json({
        error: 'already_claimed',
        assigned_to: result.assignedTo,
      });
    }

    void recordAuditAndEvent(config, {
      workspaceId: parsed.data.workspace_id,
      conversationId,
      actorType: 'agent',
      actorId: auth.userId,
      eventType: 'assigned',
      auditAction: 'conversation.claimed',
      oldValue: { assigned_to: before.assigned_to },
      newValue: { assigned_to: auth.userId },
      payload: { from: before.assigned_to, to: auth.userId, method: 'manual_claim' },
    });

    return res.json({ ok: true, assigned_to: auth.userId });
  } catch (err: any) {
    console.error('[conversations claim] error:', err);
    return res.status(500).json({ error: err?.message || 'Internal error' });
  }
});

// ─── Spam routing ─────────────────────────────────────────────────────
// POST /api/conversations/spam       → mark spam
// POST /api/conversations/not-spam   → clear spam flag
//
// Soft routing only. Marking spam:
//   • flags the conversation (and the contact, if any, plus all their
//     other conversations) so they move to the Spam queue
//   • prevents the AI Agent from auto-replying or generating suggestions
//   • does NOT close the conversation, delete history, or block the
//     visitor — Block is a separate, deliberate action.
const spamSchema = z.object({
  workspace_id: z.string().uuid(),
  conversation_id: z.string().uuid(),
});

conversationsRouter.post('/spam', async (req: any, res: any) => {
  const config = (req as any).serverConfig as ServerConfig;
  const parsed = spamSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_params' });
  const auth = await authorizeWorkspaceMember(req, res, config, parsed.data.workspace_id);
  if (!auth) return;
  try {
    const result = await markSpam(config, {
      workspaceId: parsed.data.workspace_id,
      conversationId: parsed.data.conversation_id,
      operatorId: auth.userId,
    });
    // Realtime: nudge every operator's inbox to re-fetch — the affected
    // conversation(s) move between queues (Main/Automated/NeedsHuman → Spam).
    for (const cid of result.conversation_ids) {
      void publishOperatorEvent(config, {
        kind: 'spam_changed',
        conversation_id: cid,
        workspace_id: parsed.data.workspace_id,
        actor_id: auth.userId,
        is_spam: true,
        contact_id: result.contact_id,
      });
    }
    return res.json(result);
  } catch (err: any) {
    if (err?.message === 'conversation_not_found') {
      return res.status(404).json({ error: 'conversation_not_found' });
    }
    console.error('[conversations spam] error:', err);
    return res.status(500).json({ error: err?.message || 'Internal error' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// GET / — Inbox list.
//
// Replaces src/hooks/useConversations.ts's direct
// supabase.from('conversations').select('*, contacts(...)') query, which
// relied on RLS scoped to auth.uid() and silently returned nothing once
// the dashboard stopped carrying a Supabase Auth session. Reproduces the
// exact queue/status/needs-human/assigned-to-me filtering, the contact
// join, the last-message/last-visitor-message/unread-count enrichment,
// and the "unanswered AI-intro thread" exclusion from Main Inbox — all
// previously computed client-side against two direct Supabase reads.
//
// Visitor network-profile enrichment (geo/IP/device) is intentionally
// NOT duplicated here: it already goes through the authenticated
// POST /api/visitor-intel/network/batch route (see
// src/hooks/useVisitorNetwork.ts), so the frontend hook calls that
// separately after this list resolves, exactly as it does today.
// ═══════════════════════════════════════════════════════════════════
const listQuerySchema = z.object({
  workspace_id: z.string().uuid(),
  queue: z.enum(['main', 'automated', 'spam']).optional().default('main'),
  status: z.string().max(200).optional(),
  needs_human: z.enum(['true', 'false']).optional(),
  assigned_to_me: z.string().uuid().optional(),
});

conversationsRouter.get('/', async (req: any, res: any) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid query', details: parsed.error.flatten().fieldErrors });
    }
    const { workspace_id, queue, status, assigned_to_me } = parsed.data;
    const needsHuman = parsed.data.needs_human === 'true';
    const auth = await authorizeWorkspaceMember(req, res, config, workspace_id);
    if (!auth) return;

    const sb = getServiceClient(config);
    let q = sb
      .from('conversations')
      .select('*, contacts(name, email, avatar_url, visitor_code, metadata)')
      .eq('workspace_id', workspace_id)
      .order('updated_at', { ascending: false });

    if (queue === 'automated') {
      q = q.eq('ai_state', 'ai_managed').neq('status', 'closed').is('assigned_to', null).eq('is_spam', false);
    } else if (queue === 'spam') {
      q = q.eq('is_spam', true);
    } else {
      q = q.eq('is_spam', false);
      if (needsHuman) {
        q = q.eq('ai_state', 'needs_human');
      } else {
        q = q.or('ai_state.is.null,ai_state.neq.ai_managed');
      }
      if (assigned_to_me) q = q.eq('assigned_to', assigned_to_me);
      if (status && status !== 'all') {
        const parts = status.split(',').map((x) => x.trim()).filter(Boolean);
        q = parts.length > 1 ? q.in('status', parts) : q.eq('status', parts[0]);
      }
    }

    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    const convos = (data || []) as any[];

    const ids = convos.map((c) => c.id).filter(Boolean);
    if (ids.length > 0) {
      const { data: msgs } = await sb
        .from('conversation_messages')
        .select('conversation_id, body, created_at, sender_type, seen_at, metadata')
        .in('conversation_id', ids)
        // Bot menu/button taps are navigation, not chat content — keep them
        // out of the fetch window entirely so a visitor browsing the bot menu
        // can never push the real last message out of the preview.
        .or('metadata->>channel_menu_event.is.null,metadata->>channel_menu_event.neq.true')
        .order('created_at', { ascending: false })
        .limit(2000);

      const byConv: Record<string, { body: string; created_at: string; seen_at: string | null }> = {};
      const lastByConv: Record<string, { body: string; created_at: string; sender_type: string }> = {};
      const unreadByConv: Record<string, number> = {};
      for (const m of (msgs || []) as any[]) {
        if (!m.conversation_id) continue;
        // Channel menu/button taps are navigation, not conversation content:
        // they must never drive the list preview or the unread badge.
        if (String((m.metadata || {}).channel_menu_event || '') === 'true') continue;
        if (!lastByConv[m.conversation_id]) {
          lastByConv[m.conversation_id] = { body: m.body ?? '', created_at: m.created_at, sender_type: m.sender_type };
        }

        if (m.sender_type !== 'contact') continue;
        if (!byConv[m.conversation_id]) {
          byConv[m.conversation_id] = { body: m.body ?? '', created_at: m.created_at, seen_at: m.seen_at ?? null };
        }
        if (!m.seen_at) {
          unreadByConv[m.conversation_id] = (unreadByConv[m.conversation_id] ?? 0) + 1;
        }
      }
      for (const c of convos) {
        c.last_visitor_message = byConv[c.id] ?? null;
        c.last_message = lastByConv[c.id] ?? null;
        c.unread_count = unreadByConv[c.id] ?? 0;
      }
    }

    let result = convos;
    if (queue === 'main') {
      // AI greeting threads (source='ai_agent_intro') the visitor never
      // answered are not human-actionable — exclude them from Main Inbox
      // unless a human has already touched the thread.
      result = convos.filter((c) => {
        const meta = c?.metadata || {};
        const introOnly = meta.source === 'ai_agent_intro' && !c.last_visitor_message;
        const humanTouched = !!c.assigned_to || c.ai_state === 'human_active'
          || (c.last_message && c.last_message.sender_type === 'agent');
        return !introOnly || humanTouched;
      });
    }

    return res.json({ conversations: result });
  } catch (err: any) {
    console.error('[conversations list] error:', err);
    return res.status(500).json({ error: err?.message || 'Internal error' });
  }
});

// ─── Sidebar inbox counters ─────────────────────────────────────────
conversationsRouter.get('/inbox-counts', async (req: any, res: any) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const workspaceId = String(req.query.workspace_id || '');
    if (!workspaceId) return res.status(400).json({ error: 'workspace_id is required' });
    const auth = await authorizeWorkspaceMember(req, res, config, workspaceId);
    if (!auth) return;

    const sb = getServiceClient(config);
    const base = () =>
      sb.from('conversations').select('id', { count: 'exact', head: true }).eq('workspace_id', workspaceId);
    const [mainRes, autoRes, needsRes, spamRes] = await Promise.all([
      base().eq('is_spam', false).neq('status', 'closed').or('ai_state.is.null,ai_state.neq.ai_managed'),
      base().eq('is_spam', false).neq('status', 'closed').eq('ai_state', 'ai_managed').is('assigned_to', null),
      base().eq('is_spam', false).neq('status', 'closed').eq('ai_state', 'needs_human'),
      base().eq('is_spam', true),
    ]);
    return res.json({
      main: mainRes.count ?? 0,
      automated: autoRes.count ?? 0,
      needs_human: needsRes.count ?? 0,
      spam: spamRes.count ?? 0,
    });
  } catch (err: any) {
    console.error('[conversations inbox-counts] error:', err);
    return res.status(500).json({ error: err?.message || 'Internal error' });
  }
});

// ─── Per-tab counters for the Main Inbox status tabs ─────────────────
conversationsRouter.get('/inbox-tab-counts', async (req: any, res: any) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const workspaceId = String(req.query.workspace_id || '');
    if (!workspaceId) return res.status(400).json({ error: 'workspace_id is required' });
    const auth = await authorizeWorkspaceMember(req, res, config, workspaceId);
    if (!auth) return;

    const sb = getServiceClient(config);
    const base = () =>
      sb.from('conversations').select('id', { count: 'exact', head: true })
        .eq('workspace_id', workspaceId).eq('is_spam', false).or('ai_state.is.null,ai_state.neq.ai_managed');
    const [openRes, pendingRes, resolvedRes, allRes, needsRes] = await Promise.all([
      base().eq('status', 'open'),
      base().eq('status', 'pending'),
      base().in('status', ['resolved', 'closed']),
      base(),
      base().eq('ai_state', 'needs_human'),
    ]);
    return res.json({
      open: openRes.count ?? 0,
      pending: pendingRes.count ?? 0,
      resolved: resolvedRes.count ?? 0,
      all: allRes.count ?? 0,
      needs_human: needsRes.count ?? 0,
    });
  } catch (err: any) {
    console.error('[conversations inbox-tab-counts] error:', err);
    return res.status(500).json({ error: err?.message || 'Internal error' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// GET /:id/messages — thread for one conversation, enriched with
// attachment metadata and sender identity (name + avatar).
//
// Replaces src/hooks/useConversations.ts's direct reads of
// conversation_messages / conversation_attachments / profiles.
// Authorization derives from the conversation's OWN workspace_id, not
// a client-supplied one — a caller cannot probe an arbitrary
// conversation id by guessing/forging a workspace_id query param.
// ═══════════════════════════════════════════════════════════════════
conversationsRouter.get('/:id/messages', async (req: any, res: any) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const conversationId = req.params.id;
    const sb = getServiceClient(config);

    const { data: conv } = await sb
      .from('conversations')
      .select('id, workspace_id')
      .eq('id', conversationId)
      .maybeSingle();
    if (!conv) return res.status(404).json({ error: 'conversation_not_found' });

    const auth = await authorizeWorkspaceMember(req, res, config, (conv as any).workspace_id);
    if (!auth) return;

    const { data, error } = await sb
      .from('conversation_messages')
      .select('*')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    const messages = (data || []) as any[];

    const ids = new Set<string>();
    const fromMeta = new Set<string>();
    for (const m of messages) {
      if (m?.id) ids.add(m.id);
      const aid = (m?.metadata as any)?.attachment_id;
      if (typeof aid === 'string') fromMeta.add(aid);
    }
    const attMap: Record<string, any> = {};
    const byMsg: Record<string, any> = {};
    if (ids.size || fromMeta.size) {
      const orFilters: string[] = [];
      if (ids.size) orFilters.push(`message_id.in.(${Array.from(ids).join(',')})`);
      if (fromMeta.size) orFilters.push(`id.in.(${Array.from(fromMeta).join(',')})`);
      const { data: atts } = await sb
        .from('conversation_attachments')
        .select('id, file_name, mime_type, size_bytes, status, message_id')
        .or(orFilters.join(','));
      for (const a of (atts || []) as any[]) {
        if (a.status !== 'attached' && a.status !== 'uploaded') continue;
        const meta = {
          id: a.id, file_name: a.file_name, mime_type: a.mime_type, size_bytes: a.size_bytes,
          kind: String(a.mime_type).startsWith('image/') ? 'image' : 'file',
        };
        attMap[a.id] = meta;
        if (a.message_id) byMsg[a.message_id] = meta;
      }
    }

    const senderIds = Array.from(new Set(
      messages.filter((m) => (m.sender_type === 'agent' || m.sender_type === 'ai') && m.sender_id).map((m) => m.sender_id),
    ));
    const senderMap: Record<string, { name: string | null; avatar: string | null }> = {};
    if (senderIds.length) {
      const { data: profiles } = await sb.from('profiles').select('id, full_name, avatar_url').in('id', senderIds);
      for (const p of (profiles || []) as any[]) {
        senderMap[p.id] = { name: p.full_name || null, avatar: p.avatar_url || null };
      }
    }

    const enriched = messages.map((m) => {
      const aid = (m?.metadata as any)?.attachment_id;
      const att = (typeof aid === 'string' && attMap[aid]) || (m.id && byMsg[m.id]) || null;
      const prof = m.sender_id ? senderMap[m.sender_id] : null;
      return {
        ...m,
        ...(att ? { attachment: att } : {}),
        sender_name: prof?.name ?? null,
        sender_avatar: prof?.avatar ?? null,
      };
    });

    return res.json({ messages: enriched });
  } catch (err: any) {
    console.error('[conversations messages] error:', err);
    return res.status(500).json({ error: err?.message || 'Internal error' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// POST /:id/seen — operator-side "seen" trigger.
//
// Replaces the client-side supabase.rpc('mark_conversation_seen', ...)
// call. That RPC checks is_workspace_member(workspace_id, auth.uid())
// internally — it would silently no-op (0 rows) called via service_role,
// since auth.uid() is NULL outside a Supabase Auth session. The
// membership check and monotonic update are reimplemented directly here
// against the same table/columns; behavior is identical.
// ═══════════════════════════════════════════════════════════════════
conversationsRouter.post('/:id/seen', async (req: any, res: any) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const conversationId = req.params.id;
    const sb = getServiceClient(config);

    const { data: conv } = await sb
      .from('conversations')
      .select('id, workspace_id')
      .eq('id', conversationId)
      .maybeSingle();
    if (!conv) return res.status(404).json({ error: 'conversation_not_found' });

    const auth = await authorizeWorkspaceMember(req, res, config, (conv as any).workspace_id);
    if (!auth) return;

    const { data, error } = await sb
      .from('conversation_messages')
      .update({ seen_at: new Date().toISOString() })
      .eq('conversation_id', conversationId)
      .eq('sender_type', 'contact')
      .is('seen_at', null)
      .select('id');
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ ok: true, count: (data || []).length });
  } catch (err: any) {
    console.error('[conversations seen] error:', err);
    return res.status(500).json({ error: err?.message || 'Internal error' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// DELETE / — delete ALL conversations (+ their messages) in a
// workspace. Destructive workspace-wide operation, so — unlike the
// per-message/per-conversation routes above, which only require plain
// membership — this requires manage:true (owner/admin), matching the
// bar already set for other destructive workspace-wide operations
// (member removal, invitation deletion) elsewhere in this migration.
// ═══════════════════════════════════════════════════════════════════
const deleteAllSchema = z.object({ workspace_id: z.string().uuid() });

conversationsRouter.delete('/', async (req: any, res: any) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const parsed = deleteAllSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'workspace_id is required' });
    const auth = await authorizeWorkspaceAccess(req, res, parsed.data.workspace_id, { manage: true });
    if (!auth) return;

    const sb = getServiceClient(config);
    const { data: convs, error: fetchErr } = await sb
      .from('conversations')
      .select('id')
      .eq('workspace_id', parsed.data.workspace_id);
    if (fetchErr) return res.status(500).json({ error: fetchErr.message });
    const ids = (convs ?? []).map((c: any) => c.id);
    if (ids.length === 0) return res.json({ deleted: 0 });

    const { error: msgErr } = await sb.from('conversation_messages').delete().in('conversation_id', ids);
    if (msgErr) return res.status(500).json({ error: msgErr.message });

    const { error: convErr } = await sb.from('conversations').delete().in('id', ids);
    if (convErr) return res.status(500).json({ error: convErr.message });

    return res.json({ deleted: ids.length });
  } catch (err: any) {
    console.error('[conversations delete-all] error:', err);
    return res.status(500).json({ error: err?.message || 'Internal error' });
  }
});

conversationsRouter.post('/not-spam', async (req: any, res: any) => {
  const config = (req as any).serverConfig as ServerConfig;
  const parsed = spamSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_params' });
  const auth = await authorizeWorkspaceMember(req, res, config, parsed.data.workspace_id);
  if (!auth) return;
  try {
    const result = await unmarkSpam(config, {
      workspaceId: parsed.data.workspace_id,
      conversationId: parsed.data.conversation_id,
      operatorId: auth.userId,
    });
    void publishOperatorEvent(config, {
      kind: 'spam_changed',
      conversation_id: parsed.data.conversation_id,
      workspace_id: parsed.data.workspace_id,
      actor_id: auth.userId,
      is_spam: false,
      contact_id: result.contact_id,
    });
    return res.json(result);
  } catch (err: any) {
    if (err?.message === 'conversation_not_found') {
      return res.status(404).json({ error: 'conversation_not_found' });
    }
    console.error('[conversations not-spam] error:', err);
    return res.status(500).json({ error: err?.message || 'Internal error' });
  }
});
