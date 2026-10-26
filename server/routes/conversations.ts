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
import { getClientIp } from '../utils/clientIp.js';
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
import { isTelegramMenuEventsVisible } from '../services/channels/telegram/settings.js';
import { emitLog } from '../services/observability/metrics.js';
import { markHumanTakeover } from '../services/ai-agent/handoffState.js';
import { resolveWorkspaceAgentLogoUrl } from '../services/ai-agent/settings.js';
import { maybeCreateLearningCandidateFromOperatorReply } from '../services/ai-agent/learning/candidates.js';
import { markSpam, unmarkSpam } from '../services/spam/state.js';
import { enforceMaxConversationsLimit } from '../services/billing/conversationLimit.js';
import { authorizeWorkspaceAccess, serverConfigOf } from '../lib/workspaceAuth.js';
import { authorizeInboxAccess, holdsInboxSeat, supervisesInbox } from '../lib/inboxAccess.js';
import {
  announceManualAssignment,
  checkAssignmentTarget,
  compareAndAssign,
  mayReassign,
  publishAssigneeChange,
  takeOverConversation,
} from '../services/conversationAssignment.js';
import { continueConversationThread, endConversationThread } from '../services/conversationLifecycle.js';
import { findLiveVisitorConversation, resolveVisitorConversationScope, type VisitorConversationScope } from '../services/widget/visitorConversations.js';
import {
  dropReplyJoin,
  introduceOperatorBeforeReply,
  lockConversationReplies,
  publishReplyJoin,
  separateJoinFromReply,
  type ReplyJoinRow,
} from '../services/operatorReplyJoin.js';
import { patchConversationMetadata } from '../services/conversationMetadata.js';
import { clearedClosedMarkers, operatorCloseMarkers } from '../../shared/inactivityClose.js';
import { readVisitorLastRead } from '../services/visitorReadReceipts.js';
import { channelOutboundStopped, channelStoppedBody, dispatchOutboundIfChannelConversation } from '../services/channels/outbound.js';
import { enqueueOutboundMediaIfChannelConversation } from '../services/channels/mediaOutbound.js';
import { sanitizeClientMessageMetadata } from '../services/channels/clientMessageMetadata.js';

import { applyPostSendAction } from '../services/conversationPostSend.js';
import { recordConversationClosed } from '../services/conversationClosedNotice.js';
import { isActionableCustomerTurn, isQualifiedCustomerFacingAnswer, type NeedsReplyMessage } from '../services/needsReply.js';
import {
  REACTIONS_MIGRATION_REQUIRED,
  publishMessageReactions,
  readConversationReactions,
  readMessageReactions,
  setMessageReaction,
  workspaceShowsReactions,
  type ConversationReactions,
} from '../services/messageReactions.js';
import { isWidgetChannel, normalizeReactionEmoji, reactableByOperator, reactionEmojiToTakeBack } from '../../shared/messageReactions.js';

/** The public-safe attachment shape a message is enriched with. No URLs. */
type MessageAttachment = {
  id: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  kind: string;
};
import { createStorageUrlResolver, hydrateUserAvatars, hydrateContactAvatars } from '../services/storage/urlResolver.js';
import { publicOperatorIdentity } from '../services/widget/senderIdentity.js';
import { publishVisitorSeen } from '../services/widget/visitorSeen.js';
import { isChannelMenuEvent, loadInboxUnread, publishConversationSeen } from '../services/inboxUnread.js';
import { wakeVisitorWidget } from '../services/widget/visitorWake.js';
import { deltaLowerBound, inThreadOrder, nextSyncCursor, parseSyncCursor } from '../services/messageSync.js';
import { isConversationId, parseConversationIds } from '../services/conversationIds.js';
import { queueTranscript } from '../services/notificationEmail/producers.js';
import { operatorLocale } from '../services/operatorLocale.js';
import { operatorSystemText, withOperatorSystemBody, withoutPlaceholderNames } from '../services/operatorSystemText.js';
import { coalesce } from '../lib/inflight.js';
import { onSupportConversationChanged, onTeamReply } from '../services/platformSupport/service.js';
import {
  CONTACT_LOCK_COLUMNS,
  contactRowForPanel,
  conversationLockedBody,
  conversationLockedNow,
  conversationRetentionDays,
  isConversationLocked,
  resolveContactChatLocks,
} from '../services/contactChatLocks.js';


export const conversationsRouter = Router();

const ALLOWED_STATUSES = ['open', 'pending', 'resolved', 'closed'] as const;
const ALLOWED_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;

const sendMessageSchema = z.object({
  conversation_id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  body: z.string().max(50_000).optional().default(''),
  metadata: z.record(z.unknown()).optional(),
  attachment_id: z.string().uuid().nullable().optional(),
  /** Split Send: status transition applied AFTER a successful send. */
  post_send_action: z.enum(['none', 'wait_for_customer', 'resolve']).optional().default('none'),
  /**
   * Server-side idempotency key generated by the composer. A double-click or a
   * network retry replays the SAME key, so the duplicate is collapsed instead
   * of producing a second message + a second provider delivery.
   */
  client_message_id: z.string().min(8).max(64).optional(),
  /** The message this one answers, from the same conversation (shown as a quote). */
  reply_to_message_id: z.string().uuid().nullable().optional(),
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
 * Authenticate the request as a workspace member who may use the Inbox.
 * Returns { userId } on success, sends 401/403 on failure (403
 * `inbox_not_allowed` for a staff role without an Inbox: every route here is
 * the Inbox's; server/lib/inboxAccess.ts). Delegates to the central
 * first-party session helper (server/lib/workspaceAuth.ts).
 */
async function authorizeWorkspaceMember(
  req,
  res,
  _config: ServerConfig,
  workspaceId: string,
): Promise<{ userId: string; isAdmin: boolean; role: string | null } | null> {
  const auth = await authorizeInboxAccess(req, res, workspaceId);
  if (!auth) return null;
  return { userId: auth.userId, isAdmin: auth.isAdmin, role: auth.role };
}

/**
 * Plan lock (phase 4): a chat whose last activity is older than the plan's
 * data_retention_days cannot be read, answered, changed, claimed or taken
 * over. Writes the 403 and returns true when the caller must stop. Fail open:
 * an unreadable lock state never refuses anything.
 */
async function refuseLockedConversation(
  res,
  config: ServerConfig,
  workspaceId: string,
  conv: { created_at?: string | null; updated_at?: string | null },
): Promise<boolean> {
  const { locked, state } = await conversationLockedNow(config, workspaceId, conv);
  if (!locked) return false;
  res.status(403).json(conversationLockedBody(state));
  return true;
}

/**
 * An operator continues a finished conversation, which reopens it:
 *   - a reply into a closed one (send-message; reason operator_replied,
 *     source composer);
 *   - reaching out from the Visitors page to a visitor whose live
 *     conversation is resolved (start-from-visitor; reason and source
 *     visitor_outreach): resolved is still live for the visitor, so it is
 *     the one the operator writes in, back in the Open lists.
 * Only while it still has that status, on the timeline (`reopened`) and in
 * every inbox. The operator continues the thread, so routing does not
 * re-examine who has it when the visitor answers — unless `continueThread`
 * is false (the outreach, which decides that once it knows who holds it).
 * Never throws (a reply already went out). True when it reopened it.
 */
async function reopenForOperator(
  config: ServerConfig,
  a: {
    workspaceId: string; conversationId: string; actorId: string; messageId: string | null;
    from: 'closed' | 'resolved'; reason: 'operator_replied' | 'visitor_outreach'; source: 'composer' | 'visitor_outreach';
    continueThread?: boolean;
  },
): Promise<boolean> {
  try {
    const { data } = await getServiceClient(config)
      .from('conversations')
      .update({ status: 'open', updated_at: new Date().toISOString() })
      .eq('id', a.conversationId)
      .eq('workspace_id', a.workspaceId)
      .eq('status', a.from)
      .select('id, updated_at')
      .maybeSingle();
    if (!data) return false;
    // Out of `closed`: the close it was in is over (shared/inactivityClose.ts).
    if (a.from === 'closed') {
      await patchConversationMetadata(config, a.conversationId, clearedClosedMarkers(), a.workspaceId);
    }
    void recordAuditAndEvent(config, {
      workspaceId: a.workspaceId,
      conversationId: a.conversationId,
      actorType: 'agent',
      actorId: a.actorId,
      eventType: 'reopened',
      auditAction: 'conversation.status_changed',
      oldValue: { status: a.from },
      newValue: { status: 'open' },
      payload: { from: a.from, to: 'open', reason: a.reason, source: a.source, message_id: a.messageId },
    });
    void publishOperatorEvent(config, {
      kind: 'conversation_reopened',
      conversation_id: a.conversationId,
      workspace_id: a.workspaceId,
      actor_id: a.actorId,
      changes: { status: { from: a.from, to: 'open' } },
      updated_at: (data as { updated_at?: string }).updated_at,
    });
    if (a.continueThread !== false) {
      await continueConversationThread(config, { workspaceId: a.workspaceId, conversationId: a.conversationId });
    }
    void onSupportConversationChanged(config, { workspaceId: a.workspaceId, conversationId: a.conversationId });
    return true;
  } catch (err) {
    console.warn(`[conversations] reopening a ${a.from} conversation failed:`, err?.message || err);
    return false;
  }
}

/**
 * An operator makes an unassigned conversation theirs without asking — the
 * first reply to it (send-message, method first_reply) or reaching out to
 * its visitor (start-from-visitor, method manual): only while nobody has it
 * (one conditional write, so of two operators replying at once exactly one
 * gets it), on the timeline (`assigned`) and in every inbox — the colleagues'
 * lists drop it. Never throws.
 */
async function claimUnassigned(
  config: ServerConfig,
  a: { workspaceId: string; conversationId: string; actorId: string; method: string; source?: string },
): Promise<boolean> {
  try {
    const { data } = await getServiceClient(config)
      .from('conversations')
      .update({ assigned_to: a.actorId })
      .eq('id', a.conversationId)
      .eq('workspace_id', a.workspaceId)
      .is('assigned_to', null)
      .select('id, updated_at');
    if (!Array.isArray(data) || data.length === 0) return false;
    void recordAuditAndEvent(config, {
      workspaceId: a.workspaceId,
      conversationId: a.conversationId,
      actorType: 'agent',
      actorId: a.actorId,
      eventType: 'assigned',
      auditAction: 'conversation.assigned',
      oldValue: { assigned_to: null },
      newValue: { assigned_to: a.actorId },
      payload: { from: null, to: a.actorId, method: a.method, ...(a.source ? { source: a.source } : {}) },
    });
    publishAssigneeChange(config, {
      workspaceId: a.workspaceId,
      conversationId: a.conversationId,
      actorId: a.actorId,
      from: null,
      to: a.actorId,
      updatedAt: (data[0] as { updated_at?: string }).updated_at,
    });
    void onSupportConversationChanged(config, { workspaceId: a.workspaceId, conversationId: a.conversationId });
    return true;
  } catch (err) {
    console.warn('[conversations/send-message] claim on first reply failed:', err?.message || err);
    return false;
  }
}

/**
 * POST /api/conversations/:conversationId/take-over
 *
 * Inbox-owned human takeover. Intentionally lives here (and NOT only under
 * /api/ai-agent) so an operator can always grab a conversation even when the
 * AI Agent module is off at platform level or missing from the workspace
 * plan — otherwise an AI-managed thread could never be handed back to a human.
 */
const inboxTakeOverSchema = z.object({
  workspaceId: z.string().uuid(),
  assign_to_me: z.boolean().optional().default(true),
});
conversationsRouter.post('/:conversationId/take-over', async (req, res) => {
  const config = serverConfigOf(req);
  const conversationId = String(req.params.conversationId || '');
  const parsed = inboxTakeOverSchema.safeParse(req.body);
  if (!conversationId || !parsed.success) return res.status(400).json({ error: 'invalid_params' });
  const { workspaceId, assign_to_me } = parsed.data;

  const sb = getServiceClient(config);
  const { data: conv } = await sb
    .from('conversations')
    .select('id, workspace_id, assigned_to, created_at, updated_at, ai_state:metadata->>ai_state')
    .eq('id', conversationId)
    .maybeSingle();
  if (!conv || conv.workspace_id !== workspaceId) {
    return res.status(404).json({ error: 'conversation_not_found' });
  }
  const auth = await authorizeWorkspaceMember(req, res, config, workspaceId);
  if (!auth) return;
  if (await refuseLockedConversation(res, config, workspaceId, conv)) return;

  // Taking it is atomic (R-10): only while nobody has it, else 409
  // `already_assigned` with the holder and the AI left as it is
  // (takeOverConversation).
  const taken = await takeOverConversation(config, {
    workspaceId,
    conversationId,
    actorId: auth.userId,
    assignToMe: assign_to_me,
    assignedTo: conv.assigned_to ?? null,
    previousAiState: conv.ai_state ?? null,
  });
  if ('heldBy' in taken) return res.status(409).json({ error: 'already_assigned', assigned_to: taken.heldBy });
  return res.json({ ok: true });
});



/**
 * Operator typing — ephemeral realtime-only event.
 *
 * Phase 1 contract:
 *   - No DB write. The server simply publishes an ephemeral
 *     `{ type: 'typing', payload: { actor: 'agent', conversation_id, ts, name?, avatar? } }`
 *     envelope on the conversation channel using the active realtime publisher.
 *     `name` and `avatar` are the typing operator's PUBLIC identity, exactly
 *     what the visitor sees on their messages (each only when known; never
 *     an id, e-mail or role), so a template can say who is typing. The inbox
 *     ignores agent typing; the default widget reads no field of it.
 *   - On polling deployments the publish becomes a no-op and typing is silently
 *     not delivered (by design — typing is best-effort).
 *   - Caller must be an authenticated workspace member of the conversation.
 *   - Returns `{ ok, published }` so clients can throttle accordingly.
 */
const typingSchema = z.object({
  conversation_id: z.string().uuid(),
  workspace_id: z.string().uuid(),
});

/** A profile name as a typing event carries it: no control characters, trimmed, at most 80 characters (never half of one). */
function typingName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = name.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim();
  return Array.from(clean).slice(0, 80).join('').trim();
}

conversationsRouter.post('/typing', async (req, res) => {
  try {
    const config: ServerConfig = serverConfigOf(req);
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

    const who = await publicOperatorIdentity(config, sb, auth.userId);
    const name = typeof who?.name === 'string' ? typingName(who.name) : '';
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
          ...(name ? { name } : {}),
          ...(typeof who?.avatar === 'string' && who.avatar ? { avatar: who.avatar } : {}),
        },
      },
    );
    return res.json({ ok: true, published: pub.ok });
  } catch (err) {
    console.error('[conversations/typing] error:', err);
    return res.status(500).json({ error: err?.message || 'Internal error' });
  }
});

conversationsRouter.post('/send-message', async (req, res) => {
  try {
    const config: ServerConfig = serverConfigOf(req);
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

    // Verify the conversation belongs to this workspace. `ai_state` rides
    // along so the takeover below is announced only when it is news; the
    // status and assignee for the reopen and the claim below.
    const { data: conv, error: convErr } = await sb
      .from('conversations')
      .select('id, workspace_id, status, assigned_to, created_at, updated_at, ai_state:metadata->>ai_state, channel:metadata->>channel')
      .eq('id', parsed.data.conversation_id)
      .maybeSingle();
    if (convErr) return res.status(500).json({ error: convErr.message });
    if (!conv || conv.workspace_id !== parsed.data.workspace_id) {
      return res.status(404).json({ error: 'Conversation not found in workspace' });
    }
    // A reply would move updated_at and so reopen a chat the plan locked.
    if (await refuseLockedConversation(res, config, conv.workspace_id, conv)) return;
    // A channel the plan stopped sends nothing: refuse before the reply is
    // written (the DB trigger would otherwise queue it). Only while billing
    // locks are on; an unreadable plan stops nothing.
    if (await channelOutboundStopped(config, {
      workspaceId: conv.workspace_id,
      conversationId: conv.id,
      provider: (conv as { channel?: string | null }).channel ?? null,
    })) {
      return res.status(403).json(channelStoppedBody());
    }

    // Insert message. body may be empty when only an attachment is sent.
    const messageBody = parsed.data.body || '';
    const clientMessageId = parsed.data.client_message_id ?? null;
    // Server-owned control keys (`attachments`, `channel_*`, …) are dropped
    // from client metadata: the outbound DB trigger turns `attachments` into
    // a media job whose URLs the Channels Worker fetches (SSRF). Real
    // attachments go through `attachment_id` → mediaOutbound.ts.
    const clientMetadata = sanitizeClientMessageMetadata(parsed.data.metadata);
    const baseMetadata: Record<string, unknown> = {
      ...clientMetadata,
      source: clientMetadata.source ?? 'inbox',
    };
    if (parsed.data.attachment_id) baseMetadata.attachment_id = parsed.data.attachment_id;
    if (clientMessageId) baseMetadata.client_message_id = clientMessageId;

    const MESSAGE_COLUMNS =
      'id, conversation_id, sender_type, sender_id, body, created_at, metadata, seen_at';

    /**
     * Idempotency (double-click / client retry). The partial unique index from
     * migration 070 is the real guard — this lookup only avoids a pointless
     * failing insert. A replay returns the ORIGINAL message and skips the
     * outbound dispatch, so no second Telegram/WhatsApp/… delivery is queued.
     */
    let duplicate = false;
    let inserted = null;
    if (clientMessageId) {
      const { data: prior } = await sb
        .from('conversation_messages')
        .select(MESSAGE_COLUMNS)
        .eq('conversation_id', parsed.data.conversation_id)
        .filter('metadata->>client_message_id', 'eq', clientMessageId)
        .maybeSingle();
      if (prior) { inserted = prior; duplicate = true; }
    }

    // A reply may only quote a message of the same conversation.
    let replyTo: string | null = null;
    if (parsed.data.reply_to_message_id) {
      const { data: quoted } = await sb
        .from('conversation_messages')
        .select('id')
        .eq('id', parsed.data.reply_to_message_id)
        .eq('conversation_id', parsed.data.conversation_id)
        .maybeSingle();
      if (!quoted) return res.status(400).json({ error: 'reply_to_not_in_conversation' });
      replyTo = quoted.id;
    }

    // The visitor reads "X joined" right before X's first message after the
    // AI (operatorReplyJoin.ts): the check, that line and the reply run
    // under the conversation's lock, so two messages sent at once write one
    // line, and the line is its own insert, strictly before the reply.
    let join: ReplyJoinRow | null = null;
    const releaseReplyLock = duplicate ? null : await lockConversationReplies(parsed.data.conversation_id);
    try {
      if (!duplicate) {
        join = await introduceOperatorBeforeReply(config, {
          workspaceId: parsed.data.workspace_id,
          conversationId: parsed.data.conversation_id,
          userId: auth.userId,
        });
      }
      if (!inserted) {
        const { data: row, error: insErr } = await sb
          .from('conversation_messages')
          .insert({
            conversation_id: parsed.data.conversation_id,
            body: messageBody,
            sender_type: 'agent',
            sender_id: auth.userId,
            metadata: baseMetadata,
            ...(replyTo ? { reply_to_message_id: replyTo } : {}),
          })
          .select(MESSAGE_COLUMNS)
          .single();
        if (insErr || !row) {
          // Lost the race against a concurrent replay of the same key.
          if (clientMessageId && /duplicate key|23505/i.test(insErr?.message || '')) {
            const { data: prior } = await sb
              .from('conversation_messages')
              .select(MESSAGE_COLUMNS)
              .eq('conversation_id', parsed.data.conversation_id)
              .filter('metadata->>client_message_id', 'eq', clientMessageId)
              .maybeSingle();
            if (prior) { inserted = prior; duplicate = true; }
          }
          if (!inserted) {
            // No reply, so no line announcing it.
            if (join) await dropReplyJoin(config, join.id);
            return res.status(500).json({ error: insErr?.message || 'Insert failed' });
          }
        } else {
          inserted = row;
        }
      }
      // A replay that lost the race: the original request wrote the message
      // (and the line, if one was owed).
      if (duplicate && join) {
        await dropReplyJoin(config, join.id);
        join = null;
      }
    } finally {
      releaseReplyLock?.();
    }
    // Awaited, so the line reaches the visitor before the reply's publish below.
    if (join) {
      join = await separateJoinFromReply(config, join, (inserted as { created_at?: string | null } | null)?.created_at);
      await publishReplyJoin(config, parsed.data.workspace_id, join);
    }


    // Phase 2 — Bind operator-uploaded attachment to this message + conversation.
    let attachmentBound = false;
    if (!duplicate && parsed.data.attachment_id && inserted?.id) {
      const ok = await attachUploadedFileToMessage(
        config,
        parsed.data.attachment_id,
        parsed.data.workspace_id,
        parsed.data.conversation_id,
        inserted.id,
      );
      attachmentBound = ok;
      if (!ok) {
        console.warn('[conversations/send-message] failed to attach',
          parsed.data.attachment_id, 'to', inserted.id);
      }
    }

    // Bump conversation timestamp (and reopen if needed).
    if (!duplicate) {
      await sb
        .from('conversations')
        .update({ updated_at: new Date().toISOString() })
        .eq('id', parsed.data.conversation_id);
    }

    // A reply into a CLOSED conversation reopens it (I-05): a closed thread
    // is never resumed by the visitor — their answer would start a new
    // conversation, without this context and maybe with someone else. The
    // operator who writes is continuing it. (A resolved one reopens by itself
    // when the visitor answers.)
    if (!duplicate && (conv as { status?: string | null }).status === 'closed') {
      await reopenForOperator(config, {
        workspaceId: conv.workspace_id,
        conversationId: conv.id,
        actorId: auth.userId,
        messageId: inserted?.id ?? null,
        from: 'closed',
        reason: 'operator_replied',
        source: 'composer',
      });
    }

    // The first operator reply to an unassigned conversation claims it, the
    // way the apps' claim does (R-10): atomically, only while nobody has it,
    // so a colleague's list drops it at once instead of two people answering.
    // A platform admin claims only when they hold an Inbox seat in this
    // workspace (the owner answering in their own); one looking in from
    // outside claims nothing, though the visitor still reads who joined.
    if (
      !duplicate
      && !(conv as { assigned_to?: string | null }).assigned_to
      && (!auth.isAdmin || await holdsInboxSeat(config, conv.workspace_id, auth.userId))
    ) {
      await claimUnassigned(config, {
        workspaceId: conv.workspace_id,
        conversationId: conv.id,
        actorId: auth.userId,
        method: 'first_reply',
      });
    }

    // Channel bridge: if this conversation came from a plugin channel
    // (Telegram / Bale / WhatsApp / Instagram), make the delivery intent
    // durable. No-op for widget conversations. AWAITED, because Split Send may
    // only change the status once the transport accepted the reply.
    //
    // An attachment reply takes the MEDIA path: the DB trigger only enqueues
    // text, so a file-only (or file+caption) reply would otherwise never leave
    // the platform.
    let dispatch: { accepted: boolean; result: string };
    if (duplicate) {
      dispatch = { accepted: true, result: 'already_enqueued' };
    } else if (attachmentBound && parsed.data.attachment_id) {
      try {
        const mediaResult = await enqueueOutboundMediaIfChannelConversation(config, {
          workspaceId: parsed.data.workspace_id,
          conversationId: parsed.data.conversation_id,
          messageId: inserted.id,
          attachmentId: parsed.data.attachment_id,
          caption: messageBody,
          req,
        });
        dispatch = { accepted: true, result: mediaResult };
      } catch (err) {
        console.warn('[conversations/send-message] outbound media enqueue failed:', err?.message);
        dispatch = { accepted: false, result: 'failed' };
      }
    } else {
      dispatch = await dispatchOutboundIfChannelConversation(config, {
        workspaceId: parsed.data.workspace_id,
        conversationId: parsed.data.conversation_id,
        messageId: inserted.id,
        body: messageBody,
      });
    }




    // Enrich envelope with public-safe attachment metadata so the visitor
    // widget renders the file via its proxy route. Same shape as visitor flow.
    const [enriched] = await enrichMessagesWithAttachments(
      config, parsed.data.workspace_id, [inserted]
    );

    // Operator identity must travel WITH the realtime envelope — otherwise the
    // visitor sees the reply instantly but with a blank avatar until a reload
    // hits /poll or /history (which enrich the sender server-side).
    let senderProfile: { name: string | null; avatar: string | null } | null = null;
    if (auth.userId) {
      try {
        const { data: prof } = await sb
          .from('profiles')
          .select('id, full_name, avatar_storage_key')
          .eq('id', auth.userId)
          .maybeSingle();
        if (prof) {
          // The realtime envelope carries a DERIVED link, exactly like the
          // REST enrichment below — an event payload must never republish a
          // provider-pinned URL that a row no longer holds.
          senderProfile = {
            name: prof.full_name || null,
            avatar: await createStorageUrlResolver(config).user(auth.userId, prof.avatar_storage_key),
          };
        }
      } catch { /* avatar is cosmetic — never block the send */ }
    }

    // Publish to realtime — fire-and-forget semantics. A replayed request must
    // not emit a second message envelope.
    const pub = duplicate
      ? { ok: false, reason: 'duplicate_request' as string | null }
      : await publishConversationEvent(
          config,
          parsed.data.workspace_id,
          parsed.data.conversation_id,
          buildMessageEnvelope({
            ...(enriched as Parameters<typeof buildMessageEnvelope>[0]),
            sender_id: auth.userId ?? null,
            sender_name: senderProfile?.name ?? null,
            sender_avatar: senderProfile?.avatar ?? null,
          }),
        );
    // A visitor whose widget is not listening yet (another page, or never
    // opened: Visitors → Start chat) hears of it through the loader.
    if (!duplicate) void wakeVisitorWidget(config, parsed.data.workspace_id, parsed.data.conversation_id);


    // Platform support: when this conversation is an operator's support
    // thread, the reply reaches them on their own channel, as a push and —
    // for a ticket — by email. One primary-key read for any other thread.
    if (!duplicate && inserted?.id) {
      void onTeamReply(config, {
        workspaceId: parsed.data.workspace_id,
        conversationId: parsed.data.conversation_id,
        messageId: inserted.id,
        body: messageBody,
        hasAttachment: attachmentBound,
        senderName: senderProfile?.name ?? null,
      });
    }

    // Phase 3 — record attachment_added event (timeline-only) when applicable.
    if (!duplicate && parsed.data.attachment_id) {
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
      previousAiState: conv.ai_state ?? null,
    }).catch((e) =>
      console.warn('[conversations/send-message] markHumanTakeover failed:', e?.message),
    );

    // AI Agent — learning candidate v1. Pair this operator reply with the
    // visitor's last question if the AI recently bailed out. Best-effort.
    if (!duplicate && inserted?.id && (parsed.data.body || '').trim().length > 0) {
      void maybeCreateLearningCandidateFromOperatorReply(config, {
        workspaceId: parsed.data.workspace_id,
        conversationId: parsed.data.conversation_id,
        operatorMessageId: inserted.id,
        operatorMessageBody: parsed.data.body || '',
        operatorId: auth.userId,
      }).catch((e) =>
        console.warn('[conversations/send-message] learning candidate hook failed:', e?.message),
      );
    }

    // Split Send — optional status transition, applied ONLY now that the
    // message really exists AND the transport accepted it. Shared by every
    // channel (widget / Telegram / Bale / WhatsApp / Instagram) because they
    // all send through this route. The transition itself is decided inside the
    // DB (row lock + "no newer customer message" guard).
    const postSend = await applyPostSendAction(config, {
      action: parsed.data.post_send_action,
      workspaceId: parsed.data.workspace_id,
      conversationId: parsed.data.conversation_id,
      actorId: auth.userId,
      messageId: inserted.id,
      deliveryAccepted: dispatch.accepted,
      ipAddress: getClientIp(req),
    });


    return res.json({
      ok: true,
      message: enriched,
      duplicate,
      delivery: { accepted: dispatch.accepted, result: dispatch.result },
      realtime: { published: pub.ok, reason: pub.reason ?? null },
      post_send: {
        action: parsed.data.post_send_action,
        changed: postSend.changed,
        status: postSend.status ?? null,
        reason: postSend.reason ?? null,
        blocked: postSend.blocked ?? null,
      },
    });


  } catch (err) {
    console.error('[conversations/send-message] error:', err);
    return res.status(500).json({ error: err?.message || 'Internal error' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// POST /api/conversations/start-from-visitor
//
// Operator-initiated outreach from the Visitors page. Given a visitor
// session, returns the visitor's live conversation or creates a fresh one
// tied to that session + its contact (if any). Idempotent for repeated
// clicks: the live conversation is reused.
// ═══════════════════════════════════════════════════════════════════
conversationsRouter.post('/start-from-visitor', async (req, res) => {
  try {
    const config: ServerConfig = serverConfigOf(req);
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

    // The visitor's live conversation (open, pending or resolved: one
    // current conversation per visitor, 2026-10-24) is the one the operator
    // writes in, never a second one beside it (which also keeps repeated
    // clicks from spawning duplicates). The visitor is who the widget lists
    // (services/widget/visitorConversations.ts): every session of their
    // visitor id and the contact that carries it, so a conversation they
    // started in an earlier visit counts too. Without a live one, an
    // unanswered greeting of theirs (an older widget's intro row) is reused
    // rather than doubled.
    const scope: VisitorConversationScope = session.visitor_id
      ? await resolveVisitorConversationScope(sb, parsed.data.workspace_id, String(session.visitor_id))
      : { visitorId: '', sessionIds: [], contactId: null };
    if (!scope.sessionIds.includes(String(session.id))) scope.sessionIds.push(String(session.id));
    let existing = await findLiveVisitorConversation(sb, parsed.data.workspace_id, scope)
      ?? await findLiveVisitorConversation(sb, parsed.data.workspace_id, scope, { includeUnansweredGreeting: true });
    // A chat the plan locked (no activity within its data_retention_days) is
    // not continued: reaching out would move its updated_at and so unlock
    // what the plan hides, which every operator write refuses (403
    // conversation_locked). The outreach starts a new conversation instead,
    // as it did for a resolved one before 2026-10-24 (the visitor's newest
    // live one, so the widget makes it current). Not a 403: the web panel
    // and the apps open whatever id this answers, and a refusal would leave
    // the operator no way to reach a returning visitor at all.
    if (existing && (await conversationLockedNow(config, parsed.data.workspace_id, { id: existing.id, updated_at: existing.updatedAt })).locked) {
      existing = null;
    }

    // The operator reaching out is who the visitor's answer goes to (R-29):
    // a conversation they start is theirs, and so is the visitor's live one
    // when nobody has it yet (taken atomically, as a claim), or when it was
    // resolved (its operator's thread is over).
    const owner = auth.isAdmin ? null : auth.userId;
    if (existing?.id) {
      const workspaceId = parsed.data.workspace_id;
      // Resolved is only out of the Inbox: reaching out continues it, so it
      // is open again, in the operator's lists (reopenForOperator). Whether
      // the visitor's answer looks at who has it again is decided below,
      // once that is known.
      const reopened = existing.status === 'resolved' && await reopenForOperator(config, {
        workspaceId,
        conversationId: existing.id,
        actorId: auth.userId,
        messageId: null,
        from: 'resolved',
        reason: 'visitor_outreach',
        source: 'visitor_outreach',
        continueThread: false,
      });
      let holder = existing.assignedTo;
      let claimed = false;
      let taken = false;
      if (owner && !holder) {
        claimed = await claimUnassigned(config, {
          workspaceId,
          conversationId: existing.id,
          actorId: owner,
          method: 'manual',
          source: 'visitor_outreach',
        });
        if (claimed) holder = owner;
      } else if (owner && holder !== owner && reopened) {
        // A resolve leaves its operator on the conversation, but their thread
        // is over: the one reaching out is who the visitor's answer goes to,
        // as the new conversation this outreach made before was theirs. Only
        // while it is still with whoever had it (compare-and-set), told as a
        // hand-made assignment (the timeline, the Inbox's transfer line, both
        // operators' lists).
        const moved = await compareAndAssign(config, { workspaceId, conversationId: existing.id, from: holder, to: owner });
        taken = 'row' in moved;
        if ('row' in moved) {
          void announceManualAssignment(config, {
            workspaceId,
            conversationId: existing.id,
            actorId: owner,
            from: holder,
            to: owner,
            // The takeover below names them.
            aiState: null,
            source: 'visitor_outreach',
            ipAddress: getClientIp(req),
            stamp: String(moved.row.updated_at ?? Date.now()),
          });
          publishAssigneeChange(config, { workspaceId, conversationId: existing.id, actorId: owner, from: holder, to: owner, updatedAt: moved.row.updated_at });
          void onSupportConversationChanged(config, { workspaceId, conversationId: existing.id });
          holder = owner;
        } else if ('conflict' in moved) {
          holder = moved.assignedTo;
        }
      }
      // Reopened and now the operator's who reaches out: theirs to continue,
      // so the visitor's answer does not re-examine who has it. With anyone
      // else on it (a platform admin reaching out without a seat, a colleague
      // who got there first), routing's thread-end stamp stays, and the
      // visitor's answer looks at that holder again
      // (chatRouting.ts keepsReopenedConversation).
      const continues = reopened && !!holder && holder === owner;
      if (continues) await continueConversationThread(config, { workspaceId, conversationId: existing.id });
      // A thread the AI held is the operator's now, as POST /:id/claim
      // makes it: out of the AI's lane, the AI stops. A reopened one is its
      // operator's to continue, as an operator's reopen (PATCH) makes it:
      // the resolve reset the AI's state, and the AI must not answer over
      // them (one taken from its operator names who has it now).
      const aiState = existing.aiState;
      if (holder && ((claimed && aiState === 'ai_managed') || (continues && (taken || aiState !== 'human_active')))) {
        await markHumanTakeover(config, {
          workspaceId: parsed.data.workspace_id,
          conversationId: existing.id,
          operatorId: holder,
          reason: 'assignment',
          previousAiState: aiState,
        }).catch(() => undefined);
      }
      return res.json({ ok: true, conversation_id: existing.id, created: false });
    }

    // Phase 5 — enforce max_conversations only on the actual creation
    // branch. Reuse of the visitor's live conversation above does not
    // count. workspace_id is already verified via authorizeWorkspaceMember.
    {
      const ok = await enforceMaxConversationsLimit(req, res, parsed.data.workspace_id);
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
        assigned_to: owner,
      })
      .select('id')
      .single();

    if (createErr || !created) {
      return res.status(500).json({ error: createErr?.message || 'Create failed' });
    }
    if (owner) {
      void recordAuditAndEvent(config, {
        workspaceId: parsed.data.workspace_id,
        conversationId: created.id,
        actorType: 'agent',
        actorId: owner,
        eventType: 'assigned',
        auditAction: 'conversation.assigned',
        oldValue: { assigned_to: null },
        newValue: { assigned_to: owner },
        payload: { from: null, to: owner, method: 'manual', source: 'visitor_outreach' },
      });
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
  } catch (err) {
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
//
// An assignee change (services/conversationAssignment.ts): supervisors move
// anyone's conversation, everyone else takes an unassigned one or hands on /
// gives back their own (403 `not_allowed`); the new assignee must be the
// caller or a member who receives chats (400 `invalid_target`,
// `assignee_seat_locked`); it applies only while the conversation is still
// with whoever the caller saw — `expected_assigned_to` when sent, else the
// holder this request read — or 409 `assignment_changed` with the holder now.
// ═══════════════════════════════════════════════════════════════════
const patchConversationSchema = z.object({
  workspace_id: z.string().uuid(),
  status: z.enum(ALLOWED_STATUSES).optional(),
  priority: z.enum(ALLOWED_PRIORITIES).optional(),
  assigned_to: z.string().uuid().nullable().optional(),
  /** With `assigned_to`: the assignee the panel showed (null = nobody). */
  expected_assigned_to: z.string().uuid().nullable().optional(),
  tags: z.array(z.string().min(1).max(50)).max(20).optional(),
}).refine(
  d => d.status !== undefined || d.priority !== undefined
    || d.assigned_to !== undefined || d.tags !== undefined,
  { message: 'No editable field provided' }
);

conversationsRouter.patch('/:id', async (req, res) => {
  try {
    const config: ServerConfig = serverConfigOf(req);
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
      .select('id, workspace_id, status, priority, assigned_to, tags, ai_state, created_at, updated_at')
      .eq('id', conversationId)
      .maybeSingle();
    if (loadErr) return res.status(500).json({ error: loadErr.message });
    if (!before || before.workspace_id !== parsed.data.workspace_id) {
      return res.status(404).json({ error: 'Conversation not found in workspace' });
    }
    if (await refuseLockedConversation(res, config, before.workspace_id, before)) return;

    const heldBy: string | null = before.assigned_to ?? null;
    const assignTo: string | null | undefined = parsed.data.assigned_to;
    // The panel acted on an assignee that is not the conversation's any more.
    if (assignTo !== undefined && parsed.data.expected_assigned_to !== undefined
        && (parsed.data.expected_assigned_to ?? null) !== heldBy) {
      return res.status(409).json({ error: 'assignment_changed', assigned_to: heldBy });
    }
    const assignmentChanges = assignTo !== undefined && (assignTo ?? null) !== heldBy;
    if (assignmentChanges) {
      if (!mayReassign(auth, heldBy, assignTo ?? null)) {
        return res.status(403).json({ error: 'not_allowed' });
      }
      if (assignTo) {
        const target = await checkAssignmentTarget(config, parsed.data.workspace_id, auth.userId, assignTo);
        if (target.ok === false) return res.status(target.status).json(target.body);
      }
    }

    // Build the update set. Tags are normalized (trim, dedupe, lowercase).
    const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (parsed.data.status !== undefined) update.status = parsed.data.status;
    if (parsed.data.priority !== undefined) update.priority = parsed.data.priority;
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

    let after: { id: string; workspace_id: string; status: string; priority: string; assigned_to: string | null; tags: string[] | null; updated_at: string } | null;
    if (assignmentChanges) {
      // One conditional write: the other fields land only with the assignee.
      const moved = await compareAndAssign(config, {
        workspaceId: parsed.data.workspace_id,
        conversationId,
        from: heldBy,
        to: assignTo ?? null,
        extra: update,
      });
      if ('conflict' in moved) return res.status(409).json({ error: 'assignment_changed', assigned_to: moved.assignedTo });
      if ('error' in moved) return res.status(500).json({ error: moved.error });
      after = moved.row as typeof after;
    } else {
      const { data, error: updErr } = await sb
        .from('conversations')
        .update(update)
        .eq('id', conversationId)
        .select('id, workspace_id, status, priority, assigned_to, tags, updated_at')
        .single();
      if (updErr || !data) {
        return res.status(500).json({ error: updErr?.message || 'Update failed' });
      }
      after = data as typeof after;
    }
    if (!after) return res.status(500).json({ error: 'Update failed' });

    // ─── Record events + audit per changed field ───
    const ip = getClientIp(req);

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
        // Machine-readable reason so an operator reopen is never confused
        // with the automatic `customer_replied` resume.
        payload: {
          from: before.status,
          to: parsed.data.status,
          reason:
            parsed.data.status === 'open' && before.status !== 'open'
              ? 'manually_reopened'
              : 'manual_status_change',
          source: 'operator_status_change',
        },

      });
      // Resolved or closed: the thread is over, and the next one starts
      // afresh (the AI may answer it; its operator is looked at again when
      // the visitor writes — R-17). Reopened by the operator: theirs to
      // continue. A resolved one closed later is stamped again: its end for
      // the visitor is the close (GET /api/widget/conversations `endedAt`).
      if (statusEvType === 'resolved' || (parsed.data.status === 'closed' && before.status === 'resolved')) {
        await endConversationThread(config, { workspaceId: parsed.data.workspace_id, conversationId });
      }
      // The close markers (shared/inactivityClose.ts), read only while the
      // conversation is closed: a close by the operator is theirs (the
      // reports count it as such), and any move out of `closed` clears the
      // close it was in, so a later close is never read as an earlier one.
      if (parsed.data.status === 'closed') {
        await patchConversationMetadata(config, conversationId, operatorCloseMarkers(new Date().toISOString(), String(before.status)), parsed.data.workspace_id);
      } else if (before.status === 'closed') {
        await patchConversationMetadata(config, conversationId, clearedClosedMarkers(), parsed.data.workspace_id);
      }
      if (statusEvType === 'reopened') {
        await continueConversationThread(config, { workspaceId: parsed.data.workspace_id, conversationId });
        // Its operator continues it: a person has it, so the AI (whose state
        // the resolve reset) does not answer over them, and it stays in
        // their lists rather than the AI's.
        if (after.assigned_to) {
          await markHumanTakeover(config, {
            workspaceId: parsed.data.workspace_id,
            conversationId,
            operatorId: after.assigned_to,
            reason: 'assignment',
            previousAiState: (before as { ai_state?: string | null }).ai_state ?? null,
          }).catch(() => undefined);
        }
      }
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

    if (assignmentChanges) {
      changes.assigned_to = { from: heldBy, to: assignTo ?? null };
      // The timeline, the new operator's phone, the AI letting go of a
      // thread it held (R-06), the thread's notice, and — handed back to
      // nobody — routing again in every mode (R-20; the queue in manual).
      void announceManualAssignment(config, {
        workspaceId: parsed.data.workspace_id,
        conversationId,
        actorId: auth.userId,
        from: heldBy,
        to: assignTo ?? null,
        aiState: (before as { ai_state?: string | null }).ai_state ?? null,
        ipAddress: ip,
        stamp: String(after.updated_at ?? Date.now()),
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
    // Operator-only `event` envelope (tags, assignee ids): the workspace
    // inbox channel only, never the conversation channel the visitor's
    // widget listens on. Best-effort, non-blocking.
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

      // A resolved conversation is the one moment a transcript is worth
      // sending: it is finished, so the mail is a record rather than a
      // snapshot of something still moving. Queued, never sent inline —
      // nobody resolving a conversation should wait on an SMTP round trip —
      // and a no-op while the platform has the type switched off.
      if (statusEvType === 'resolved') {
        void queueTranscript(config, {
          conversationId,
          workspaceId: parsed.data.workspace_id,
          actorId: auth.userId,
        }).catch((err: unknown) => {
          console.error('[conversations PATCH] transcript queue failed:', err);
        });
      }
      // The visitor's «X closed the conversation» line (and its rating
      // card), for a widget conversation whose template draws it: only when
      // it is closed, from any status (a resolved one too). A resolve is the
      // operator's alone and draws nothing (owner, 2026-10-24). Never throws,
      // never awaited.
      if (parsed.data.status === 'closed' && before.status !== 'closed') {
        void recordConversationClosed(config, {
          workspaceId: parsed.data.workspace_id,
          conversationId,
          actorId: auth.userId,
          status: 'closed',
        });
      }
    }

    // A platform-support conversation: the operator's chat shows it ended,
    // reopened or taken by somebody.
    if ((parsed.data.status !== undefined && parsed.data.status !== before.status) || assignmentChanges) {
      void onSupportConversationChanged(config, { workspaceId: parsed.data.workspace_id, conversationId });
    }

    return res.json({ ok: true, conversation: after });
  } catch (err) {
    console.error('[conversations PATCH] error:', err);
    return res.status(500).json({ error: err?.message || 'Internal error' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// POST /api/conversations/:id/claim
// Taking an unassigned conversation: the first operator to claim it owns
// it — the apps' claim and the web Inbox's "take" (R-10: the web used a
// plain read-then-write, so two operators taking it at once both "won").
// Atomic via public.claim_conversation(), a compare-and-set, so two
// operators racing can never both succeed: the other gets 409
// `already_assigned` with the holder. Claiming one you hold already is a
// 200. A thread the AI held becomes the claimer's (human takeover).
// ═══════════════════════════════════════════════════════════════════
const claimConversationSchema = z.object({
  workspace_id: z.string().uuid(),
});

conversationsRouter.post('/:id/claim', async (req, res) => {
  try {
    const config: ServerConfig = serverConfigOf(req);
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
      .select('id, workspace_id, assigned_to, ai_state, created_at, updated_at')
      .eq('id', conversationId)
      .maybeSingle();
    if (!before || before.workspace_id !== parsed.data.workspace_id) {
      return res.status(404).json({ error: 'Conversation not found in workspace' });
    }
    if (await refuseLockedConversation(res, config, before.workspace_id, before)) return;

    const { claimConversationManually } = await import('../services/chatRouting.js');
    const result = await claimConversationManually(config, {
      workspaceId: parsed.data.workspace_id,
      conversationId,
      userId: auth.userId,
    });

    if (!result.claimed) {
      return res.status(409).json({
        error: 'already_assigned',
        assigned_to: result.assignedTo,
      });
    }
    if (result.alreadyHeld) return res.json({ ok: true, assigned_to: auth.userId });

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
    if ((before as { ai_state?: string | null }).ai_state === 'ai_managed') {
      void markHumanTakeover(config, {
        workspaceId: parsed.data.workspace_id,
        conversationId,
        operatorId: auth.userId,
        reason: 'assignment',
        previousAiState: 'ai_managed',
      }).catch(() => undefined);
    }
    void onSupportConversationChanged(config, { workspaceId: parsed.data.workspace_id, conversationId });

    return res.json({ ok: true, assigned_to: auth.userId });
  } catch (err) {
    console.error('[conversations claim] error:', err);
    return res.status(500).json({ error: err?.message || 'Internal error' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// POST /api/conversations/:id/transfer — hand a conversation on (R-21).
//
// Body { workspace_id, user_id? | department_id? (exactly one),
// expected_assigned_to? } → 200 { ok, conversation } (the list's shape) |
// 400 invalid_target (not exactly one target; a non-member, a suspended
// member, staff, a department that is unknown, off or takes no chats) /
// assignee_seat_locked | 403 not_allowed | 404 conversation_not_found | 409
// assignment_changed { assigned_to } (somebody moved it since the panel read
// it, or meanwhile).
//
//   to an operator  as the PATCH's assignee change (permissions, target,
//                   atomic, the Inbox's transfer line, the new operator's
//                   phone, the AI letting go);
//   to a department the conversation leaves its operator (atomically), takes
//                   the department, and is routed inside it now — the
//                   department's available operators only (never the whole
//                   team or the owner fallback: nobody there = it waits for
//                   them, `routing_department_only` until the thread ends or
//                   someone moves it to a person); in manual mode it waits
//                   in the queue — whatever the AI would do (a person was
//                   asked for). Whoever held it is not offered it again for
//                   this chat. The Inbox reads "X transferred this
//                   conversation to <department>" (internal); the visitor
//                   reads who joined when that operator first writes.
// Supervisors move anyone's conversation; everyone else only their own (or
// takes an unassigned one themselves).
// ═══════════════════════════════════════════════════════════════════
const transferSchema = z.object({
  workspace_id: z.string().uuid(),
  user_id: z.string().uuid().optional(),
  department_id: z.string().uuid().optional(),
  expected_assigned_to: z.string().uuid().nullable().optional(),
}).refine((d) => !!d.user_id !== !!d.department_id, { message: 'exactly one of user_id, department_id' });

conversationsRouter.post('/:id/transfer', async (req, res) => {
  try {
    const config: ServerConfig = serverConfigOf(req);
    const conversationId = String(req.params.id || '');
    const parsed = transferSchema.safeParse(req.body ?? {});
    if (!isConversationId(conversationId) || !parsed.success) {
      return res.status(400).json({ error: 'invalid_target' });
    }
    const workspaceId = parsed.data.workspace_id;
    const auth = await authorizeWorkspaceMember(req, res, config, workspaceId);
    if (!auth) return;

    const sb = getServiceClient(config);
    const { data: before } = await sb
      .from('conversations')
      .select('id, workspace_id, status, assigned_to, ai_state, metadata, created_at, updated_at')
      .eq('id', conversationId)
      .maybeSingle();
    if (!before || before.workspace_id !== workspaceId) return res.status(404).json({ error: 'conversation_not_found' });
    if (await refuseLockedConversation(res, config, workspaceId, before)) return;

    const heldBy: string | null = before.assigned_to ?? null;
    if (parsed.data.expected_assigned_to !== undefined && (parsed.data.expected_assigned_to ?? null) !== heldBy) {
      return res.status(409).json({ error: 'assignment_changed', assigned_to: heldBy });
    }
    const ip = getClientIp(req);
    const respond = async () => {
      const listed = await listConversationRows(config, auth, {
        workspaceId, queue: 'any', needsHuman: false, canSeeAllAssignments: true, ids: [conversationId.toLowerCase()],
      });
      return res.json({ ok: true, conversation: listed.rows[0] ?? null });
    };

    // ─── To an operator ───
    if (parsed.data.user_id) {
      const to = parsed.data.user_id;
      if (to === heldBy) return await respond();
      if (!mayReassign(auth, heldBy, to)) return res.status(403).json({ error: 'not_allowed' });
      const target = await checkAssignmentTarget(config, workspaceId, auth.userId, to);
      if (target.ok === false) return res.status(target.status).json(target.body);
      const moved = await compareAndAssign(config, { workspaceId, conversationId, from: heldBy, to });
      if ('conflict' in moved) return res.status(409).json({ error: 'assignment_changed', assigned_to: moved.assignedTo });
      if ('error' in moved) return res.status(500).json({ error: moved.error });
      // A person now, whoever they are: an earlier transfer's "this
      // department only" no longer holds.
      if ((before.metadata as Record<string, unknown> | null)?.routing_department_only === true) {
        await patchConversationMetadata(config, conversationId, { routing_department_only: null }, workspaceId);
      }
      await announceManualAssignment(config, {
        workspaceId, conversationId, actorId: auth.userId, from: heldBy, to,
        aiState: (before as { ai_state?: string | null }).ai_state ?? null,
        source: 'transfer', ipAddress: ip, stamp: String(moved.row.updated_at ?? Date.now()),
      });
      publishAssigneeChange(config, { workspaceId, conversationId, actorId: auth.userId, from: heldBy, to, updatedAt: moved.row.updated_at });
      void onSupportConversationChanged(config, { workspaceId, conversationId });
      return await respond();
    }

    // ─── To a department ───
    const departmentId = parsed.data.department_id as string;
    if (!mayReassign(auth, heldBy, null)) return res.status(403).json({ error: 'not_allowed' });
    const { data: dept } = await sb
      .from('workspace_departments')
      .select('id, name, enabled, chat_enabled')
      .eq('workspace_id', workspaceId)
      .eq('id', departmentId)
      .maybeSingle();
    const department = dept as { id: string; name: string | null; enabled?: boolean | null; chat_enabled?: boolean | null } | null;
    if (!department || department.enabled === false || department.chat_enabled === false) {
      return res.status(400).json({ error: 'invalid_target', reason: 'department' });
    }
    if (heldBy) {
      const moved = await compareAndAssign(config, { workspaceId, conversationId, from: heldBy, to: null });
      if ('conflict' in moved) return res.status(409).json({ error: 'assignment_changed', assigned_to: moved.assignedTo });
      if ('error' in moved) return res.status(500).json({ error: moved.error });
    }
    const beforeMeta = (before.metadata || {}) as Record<string, unknown>;
    const fromDepartment = typeof beforeMeta.department_id === 'string' ? beforeMeta.department_id : null;
    await patchConversationMetadata(config, conversationId, { department_id: department.id, routing_department_only: true }, workspaceId);

    const { data: people } = await sb
      .from('profiles')
      .select('id, full_name')
      .in('id', [auth.userId, heldBy].filter((v): v is string => !!v));
    const nameOf = (id: string | null) => (id
      ? ((people || []) as Array<{ id: string; full_name?: string | null }>).find((p) => p.id === id)?.full_name || null
      : null);
    const actorName = nameOf(auth.userId);
    if (heldBy) {
      void recordAuditAndEvent(config, {
        workspaceId,
        conversationId,
        actorType: 'agent',
        actorId: auth.userId,
        ipAddress: ip,
        eventType: 'unassigned',
        auditAction: 'conversation.unassigned',
        oldValue: { assigned_to: heldBy },
        newValue: { assigned_to: null },
        payload: { from: heldBy, to: null, method: 'transfer_department', department_id: department.id },
      });
    }
    void recordConversationEvent(config, {
      workspaceId,
      conversationId,
      eventType: 'department_assigned',
      actorType: 'agent',
      actorId: auth.userId,
      payload: { department_id: department.id, department_name: department.name ?? null, from: fromDepartment, source: 'transfer' },
    });
    publishAssigneeChange(config, {
      workspaceId, conversationId, actorId: auth.userId, from: heldBy, to: null,
      extra: { department_id: { from: fromDepartment, to: department.id } },
    });
    // The Inbox's line (never the visitor's: the operator who joins is theirs).
    await sb.from('conversation_messages').insert({
      conversation_id: conversationId,
      sender_type: 'system',
      body: `${actorName || 'An operator'} transferred this conversation to ${department.name || 'a department'}`,
      metadata: {
        kind: 'conversation_transferred',
        internal: true,
        actor_id: auth.userId,
        actor_name: actorName,
        from_id: heldBy,
        from_name: nameOf(heldBy),
        to_id: null,
        to_name: department.name ?? null,
        department_id: department.id,
        department_name: department.name ?? null,
      },
    });
    const { rerouteConversation } = await import('../services/chatRouting.js');
    await rerouteConversation(config, { workspaceId, conversationId, skipUserId: heldBy, forPerson: true });
    void onSupportConversationChanged(config, { workspaceId, conversationId });
    return await respond();
  } catch (err) {
    console.error('[conversations transfer] error:', err);
    return res.status(500).json({ error: 'Internal error' });
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

conversationsRouter.post('/spam', async (req, res) => {
  const config = serverConfigOf(req);
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
  } catch (err) {
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
  // Assignment scope. Default 'mine': every operator — owners and admins
  // included — only sees unassigned threads plus the ones assigned to them,
  // so a transferred conversation leaves the sender's Inbox immediately.
  // 'all' is the explicit full-workspace view, allowed for privileged roles.
  scope: z.enum(['mine', 'all']).optional().default('mine'),
});

conversationsRouter.get('/', async (req, res) => {
  try {
    const config: ServerConfig = serverConfigOf(req);
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid query', details: parsed.error.flatten().fieldErrors });
    }
    const { workspace_id, queue, status, assigned_to_me, scope } = parsed.data;
    const needsHuman = parsed.data.needs_human === 'true';
    const idsParsed = parseConversationIds(req.query.ids);
    if (idsParsed.ok === false) {
      return res.status(400).json({ error: 'Invalid query', details: { ids: [idsParsed.error] } });
    }
    const auth = await authorizeWorkspaceMember(req, res, config, workspace_id);
    if (!auth) return;
    // Supervisors (owner, admin, team lead: shared/chatRoles.ts) keep the
    // full view ONLY when they explicitly ask for it (scope=all). Otherwise
    // their Inbox behaves like an operator's.
    const canSeeAllAssignments = supervisesInbox(auth) && scope === 'all';

    const listed = await listConversationRows(config, auth, {
      workspaceId: workspace_id,
      queue,
      status,
      needsHuman,
      assignedToMe: assigned_to_me,
      canSeeAllAssignments,
      ids: idsParsed.ids,
    });
    if (listed.error) return res.status(500).json({ error: listed.error });
    // The ids are echoed so a client can tell this answer from an older
    // server's, which ignores `ids` and sends the whole queue.
    return res.json(idsParsed.ids ? { conversations: listed.rows, ids: idsParsed.ids } : { conversations: listed.rows });
  } catch (err) {
    console.error('[conversations list] error:', err);
    return res.status(500).json({ error: err?.message || 'Internal error' });
  }
});

type ListQueue = 'main' | 'automated' | 'spam' | 'any';

interface ListOptions {
  workspaceId: string;
  queue: ListQueue;
  status?: string;
  needsHuman: boolean;
  assignedToMe?: string;
  canSeeAllAssignments: boolean;
  /** Narrow to these conversations (`?ids=`, or one id for `GET /:id`). */
  ids: string[] | null;
}

/**
 * The conversation list, as the Inbox reads it: the queue's rows with the
 * contact joined and the preview, unread count and needs-reply computed —
 * shared by the list route and `GET /:id`, so a row fetched by id is in
 * exactly the shape the list gives it.
 */
async function listConversationRows(
  config: ServerConfig,
  auth: { userId: string },
  opts: ListOptions,
): Promise<{ rows: Array<Record<string, unknown>>; error: string | null }> {
  const { workspaceId, queue, status, needsHuman, assignedToMe, canSeeAllAssignments } = opts;
  const onlyIds = opts.ids;
  const sb = getServiceClient(config);
  // The plan's locks (phase 4) are read alongside the list; the contact join
  // also reads what its lock is judged by (dropped again below).
  const locksPending = resolveContactChatLocks(config, workspaceId);
  let q = sb
    .from('conversations')
    .select(`*, contacts(avatar_url, avatar_storage_key, visitor_code, ${CONTACT_LOCK_COLUMNS})`)
    .eq('workspace_id', workspaceId)
    .order('updated_at', { ascending: false });

  // A targeted read: the same query, narrowed to the rows a client named.
  if (onlyIds && onlyIds.length > 0) q = q.in('id', onlyIds);

  if (queue === 'any') {
    // By id, whichever queue it is in: no queue, status or assignment
    // narrowing — the caller already holds the id, and reading a thread's
    // messages is open to every member of its workspace.
  } else if (queue === 'automated') {
    q = q.eq('ai_state', 'ai_managed').neq('status', 'closed').is('assigned_to', null).eq('is_spam', false);
  } else if (queue === 'spam') {
    q = q.eq('is_spam', true);
  } else {
    q = q.eq('is_spam', false);
    // The Closed box (status=closed alone) lists every closed conversation,
    // the ones the AI held to the end and the timer closed included; every
    // other status keeps the AI's conversations in their own queue.
    const closedOnly = !needsHuman && String(status || '').trim() === 'closed';
    if (needsHuman) {
      q = q.eq('ai_state', 'needs_human');
    } else if (!closedOnly) {
      q = q.or('ai_state.is.null,ai_state.neq.ai_managed');
    }
    if (assignedToMe) {
      q = q.eq('assigned_to', assignedToMe);
    } else if (!canSeeAllAssignments) {
      // A claimed conversation belongs to the operator who took it: other
      // agents must not keep seeing it in their Inbox. Owners/admins and
      // team leads still get the full workspace view.
      q = q.or(`assigned_to.is.null,assigned_to.eq.${auth.userId}`);
    }
    if (status && status !== 'all') {
      const parts = status.split(',').map((x) => x.trim()).filter(Boolean);
      // "Resolved" is the finished tab: resolved and closed, as the tab's
      // count (/inbox-tab-counts) and the desktop console ('resolved,closed')
      // already read it. iOS, windows-native, Electron and the web mobile
      // inbox ask for 'resolved' alone and would never list a closed one.
      const wanted = parts.length === 1 && parts[0] === 'resolved' ? ['resolved', 'closed'] : parts;
      q = wanted.length > 1 ? q.in('status', wanted) : q.eq('status', wanted[0]);
    }
  }

  const [{ data, error }, locks] = await Promise.all([q, locksPending]);
  if (error) return { rows: [], error: error.message };
  const convos = (data || []);
  // Plan locks (phase 4). A chat past the plan's retention is listed, marked
  // `locked_by_retention`, without its preview; a contact over the plan's
  // limit is joined redacted with `locked: true` (D4: the chat stays usable,
  // the contact's details do not reach the panel).
  const retentionDays = conversationRetentionDays(locks);
  const lockedConv = new Set<string>();
  for (const c of convos) {
    const locked = isConversationLocked(locks, c);
    c.locked_by_retention = locked;
    if (locked) {
      lockedConv.add(c.id);
      c.retention_days = retentionDays;
      c.subject = null;
    }
    if (c.contacts) {
      const contact = contactRowForPanel(locks, c.contacts);
      // Read only to judge the lock: the list never carried them.
      delete contact.phone;
      delete contact.is_spam;
      delete contact.created_at;
      c.contacts = contact;
    }
  }
  // Contact avatars: derived from the stored key for the workspace's
  // current provider, one resolution for the whole page.
  await hydrateContactAvatars(
    config,
    workspaceId,
    convos.map((c) => c.contacts).filter((ct) => ct && !ct.locked),
  );

  const ids = convos.map((c) => c.id).filter(Boolean);
  if (ids.length > 0) {
    // The department the visitor chose (routing keeps it in the metadata),
    // by id and name, on every row (R-22).
    const departmentOf = (c: Record<string, unknown>): string | null => {
      const id = (c.metadata as Record<string, unknown> | null)?.department_id;
      return typeof id === 'string' && isConversationId(id) ? id : null;
    };
    const departmentIds = Array.from(new Set(convos.map(departmentOf).filter((id): id is string => !!id)));
    const [{ data: msgs }, readerLocale, lastRead, { data: departments }] = await Promise.all([
      sb
        .from('conversation_messages')
        .select('conversation_id, body, created_at, sender_type, sender_id, seen_at, metadata')
        .in('conversation_id', ids)
        // Bot menu/button taps are navigation, not chat content — keep them
        // out of the fetch window entirely so a visitor browsing the bot menu
        // can never push the real last message out of the preview.
        .or('metadata->>channel_menu_event.is.null,metadata->>channel_menu_event.neq.true')
        .order('created_at', { ascending: false })
        .limit(2000),
      // The language a system preview's `body` is written in (below).
      operatorLocale(config, auth.userId),
      // When the visitor last read each thread in the widget (I-03).
      readVisitorLastRead(sb, ids),
      departmentIds.length
        ? sb.from('workspace_departments').select('id, name').eq('workspace_id', workspaceId).in('id', departmentIds)
        : Promise.resolve({ data: [] as Array<{ id: string; name: string | null }> }),
    ]);
    const departmentName = new Map(((departments || []) as Array<{ id: string; name: string | null }>).map((d) => [d.id, d.name ?? null]));
    for (const c of convos) {
      const departmentId = departmentOf(c);
      c.department_id = departmentId;
      c.department_name = departmentId ? (departmentName.get(departmentId) ?? null) : null;
      c.visitor_last_read_at = lastRead.get(c.id) ?? null;
    }

    const byConv: Record<string, { body: string; created_at: string; seen_at: string | null }> = {};
    const lastByConv: Record<string, { body: string; created_at: string; sender_type: string; sender_id?: string | null; sender_name?: string | null; attachment_id?: string | null; attachment_kind?: 'image' | 'audio' | 'video' | 'file' | null; system_kind?: string | null; system_meta?: Record<string, unknown> | null }> = {};
    // Human operators who ever wrote in the thread — drives "who handled
    // this" visibility for resolved threads and the list preview label.
    const agentParticipants: Record<string, Set<string>> = {};
    const unreadByConv: Record<string, number> = {};
    // Needs Reply is derived from the message stream, never stored. Rows
    // arrive newest-first, so the FIRST conversational turn we see per
    // conversation decides the obligation (see services/needsReply.ts).
    const needsReplyByConv: Record<string, boolean> = {};
    const needsReplyDecided = new Set<string>();
    // Oldest actionable customer turn of the CURRENT unanswered streak, so
    // the Inbox can rank by real waiting age instead of `updated_at` (which
    // assignment, routing metadata and delivery receipts also bump).
    const waitingSinceByConv: Record<string, string | null> = {};
    for (const m of (msgs || [])) {
      if (!m.conversation_id) continue;
      // Channel menu/button taps are navigation, not conversation content:
      // they must never drive the list preview or the unread badge (the
      // Inbox's unread number skips them by the same rule).
      const meta = (m.metadata || {}) as Record<string, unknown>;
      if (isChannelMenuEvent(meta)) continue;

      if (!lastByConv[m.conversation_id]) {
        // A system notice's body is written in the requesting operator's
        // language (services/operatorSystemText.ts): an installed native app
        // that does not know the kind prints the body.
        const isSystem = m.sender_type === 'system';
        lastByConv[m.conversation_id] = {
          body: (isSystem ? operatorSystemText(meta, readerLocale) : null) ?? m.body ?? '',
          created_at: m.created_at,
          sender_type: m.sender_type,
          sender_id: m.sender_id ?? null,
          sender_name: null,
          // A file-only message has an empty body: the list preview must
          // describe the media instead of claiming "no messages yet".
          attachment_id: meta?.attachment_id ? String(meta.attachment_id) : null,
          attachment_kind: null,
          // Every system notice is stored in English and frozen at insert
          // time, so the preview has to rebuild the sentence from metadata
          // (see shared/systemMessageText.ts). Shipping the whole object
          // rather than a field per kind is why the list no longer falls
          // behind the thread every time a new kind is added. The English
          // stand-ins once stored as a name ('a colleague') go out as null.
          system_kind: meta?.kind ? String(meta.kind) : null,
          system_meta: meta?.kind ? (isSystem ? withoutPlaceholderNames(meta) : meta) : null,
        };
      }
      if (m.sender_type === 'agent' && m.sender_id) {
        (agentParticipants[m.conversation_id] ||= new Set<string>()).add(String(m.sender_id));
      }


      // Rows arrive newest-first. The first conversational turn decides the
      // obligation; we then keep walking back over the customer streak to
      // find when the wait actually started.
      if (isQualifiedCustomerFacingAnswer(m as NeedsReplyMessage)) {
        if (!needsReplyDecided.has(m.conversation_id)) {
          needsReplyByConv[m.conversation_id] = false;
        }
        needsReplyDecided.add(m.conversation_id);
      } else if (isActionableCustomerTurn(m as NeedsReplyMessage)) {
        if (!needsReplyDecided.has(m.conversation_id)) {
          needsReplyByConv[m.conversation_id] = true;
          waitingSinceByConv[m.conversation_id] = m.created_at ?? null;
        } else if (needsReplyByConv[m.conversation_id]) {
          // Still inside the unanswered streak → the wait began earlier.
          waitingSinceByConv[m.conversation_id] = m.created_at ?? null;
        }
      }

      if (m.sender_type !== 'contact') continue;
      if (!byConv[m.conversation_id]) {
        byConv[m.conversation_id] = { body: m.body ?? '', created_at: m.created_at, seen_at: m.seen_at ?? null };
      }
      if (!m.seen_at) {
        unreadByConv[m.conversation_id] = (unreadByConv[m.conversation_id] ?? 0) + 1;
      }
    }

    // Resolve the media kind of every attachment-only preview in one query,
    // so the Inbox list can say "sent a photo / voice message / file".
    const previewAttachmentIds = Array.from(new Set(
      Object.values(lastByConv)
        .filter((l) => l.attachment_id && !String(l.body || '').trim())
        .map((l) => l.attachment_id as string),
    ));
    if (previewAttachmentIds.length) {
      const { data: atts } = await sb
        .from('conversation_attachments')
        .select('id, mime_type')
        .in('id', previewAttachmentIds);
      const mimeById = new Map<string, string>(
        ((atts || [])).map((a) => [String(a.id), String(a.mime_type || '')]),
      );
      for (const last of Object.values(lastByConv)) {
        if (!last.attachment_id) continue;
        const mime = mimeById.get(last.attachment_id) || '';
        last.attachment_kind = mime.startsWith('image/')
          ? 'image'
          : mime.startsWith('audio/')
            ? 'audio'
            : mime.startsWith('video/')
              ? 'video'
              : 'file';
      }
    }

    // Resolve display names for the operators whose message is the list
    // preview, so the row reads "Ali: …" instead of always "You: …".
    const agentSenderIds = Array.from(new Set(
      Object.values(lastByConv)
        .filter((l) => l.sender_type === 'agent' && l.sender_id)
        .map((l) => String(l.sender_id)),
    ));
    if (agentSenderIds.length) {
      const { data: profs } = await sb
        .from('profiles')
        .select('id, full_name, email')
        .in('id', agentSenderIds);
      const nameById = new Map<string, string>(
        ((profs || [])).map((p) => [
          String(p.id),
          String(p.full_name || String(p.email || '').split('@')[0] || ''),
        ]),
      );
      for (const last of Object.values(lastByConv)) {
        if (last.sender_type !== 'agent' || !last.sender_id) continue;
        last.sender_name = nameById.get(String(last.sender_id)) || null;
      }
    }

    for (const c of convos) {
      c.last_visitor_message = byConv[c.id] ?? null;
      c.last_message = lastByConv[c.id] ?? null;
      c.unread_count = unreadByConv[c.id] ?? 0;
      c.handled_by = Array.from(agentParticipants[c.id] ?? []);
      // Only an `open` thread can owe the customer an answer: `pending`
      // means we are waiting for THEM, `resolved`/`closed` are done.
      c.needs_reply = c.status === 'open' && (needsReplyByConv[c.id] ?? false);
      c.waiting_since = c.needs_reply ? (waitingSinceByConv[c.id] ?? null) : null;
    }
  }

  let result = convos;
  if (queue === 'main') {
    // AI greeting threads (source='ai_agent_intro') the visitor never
    // answered are not human-actionable — exclude them from Main Inbox
    // unless a human has already touched the thread. Decided from what was
    // read, never from its absence: the messages above are one window for
    // the whole list, so an older row may have none read (the Closed box
    // lists many AI rows). An inactivity close recorded the answer itself
    // (closed_outcome, migration 284), so a closed row goes by that.
    result = convos.filter((c) => {
      const meta = c?.metadata || {};
      const closedOutcome = (c.status === 'closed' && meta.closed_reason === 'inactivity'
        && typeof meta.closed_outcome === 'string') ? meta.closed_outcome : null;
      const introOnly = meta.source === 'ai_agent_intro' && !c.last_visitor_message
        && (closedOutcome ? closedOutcome === 'no_visitor_message' : !!c.last_message);
      const humanTouched = !!c.assigned_to || c.ai_state === 'human_active'
        || (c.last_message && c.last_message.sender_type === 'agent');
      return !introOnly || humanTouched;
    });
  }

  // A finished thread belongs to whoever actually handled it. An operator
  // must not see resolved/closed threads that another operator answered,
  // even when nobody claimed them (`assigned_to` stays null on the
  // "send & resolve" path). Owners/admins/team leads keep the full view.
  if (!canSeeAllAssignments && queue !== 'any') {
    result = result.filter((c) => {
      if (c.status !== 'resolved' && c.status !== 'closed') return true;
      if (c.assigned_to && c.assigned_to !== auth.userId) return false;
      const handled: string[] = Array.isArray(c.handled_by) ? c.handled_by : [];
      if (handled.length === 0) return true; // AI/system resolved → shared
      return handled.includes(auth.userId);
    });
  }

  // A locked chat's messages were read only for the queue rules above; its
  // content stays on the server.
  for (const c of result) {
    if (!lockedConv.has(c.id)) continue;
    c.last_visitor_message = null;
    c.last_message = null;
    c.unread_count = 0;
    c.needs_reply = false;
    c.waiting_since = null;
  }

  return { rows: result, error: null };
}

// ─── Inbox counters: one query for both counter endpoints ────────────
// conversation_inbox_counters (migration 241 / 20260930100200) returns every
// number /inbox-counts and /inbox-tab-counts report, in one pass. The
// dashboard requests both at the same moment on each realtime invalidation,
// so concurrent calls with the same arguments also share one execution. A
// database without the function yet (or any error) falls back to the
// per-counter queries below, which compute the same numbers.
type InboxCounters = {
  inbox_main: number; inbox_automated: number; inbox_needs_human: number; inbox_spam: number;
  tab_open: number; tab_pending: number; tab_resolved: number; tab_all: number;
  tab_needs_human: number; tab_automated: number;
};

async function loadInboxCounters(
  sb: ReturnType<typeof getServiceClient>,
  workspaceId: string,
  userId: string,
  seesAll: boolean,
): Promise<InboxCounters | null> {
  const { data, error } = await coalesce(`inbox_counters:${workspaceId}:${userId}:${seesAll}`, () =>
    sb.rpc('conversation_inbox_counters', {
      p_workspace_id: workspaceId,
      p_user_id: userId,
      p_sees_all: seesAll,
    }),
  );
  const row = Array.isArray(data) ? data[0] : data;
  if (error || !row) {
    if (error && error.code !== 'PGRST202') {
      console.warn('[conversations] inbox counters query failed, using per-counter fallback:', error.message);
    }
    return null;
  }
  const n = (v: unknown) => Number(v ?? 0) || 0;
  return {
    inbox_main: n(row.inbox_main), inbox_automated: n(row.inbox_automated),
    inbox_needs_human: n(row.inbox_needs_human), inbox_spam: n(row.inbox_spam),
    tab_open: n(row.tab_open), tab_pending: n(row.tab_pending), tab_resolved: n(row.tab_resolved),
    tab_all: n(row.tab_all), tab_needs_human: n(row.tab_needs_human), tab_automated: n(row.tab_automated),
  };
}

// ─── Sidebar inbox counters ─────────────────────────────────────────
conversationsRouter.get('/inbox-counts', async (req, res) => {
  try {
    const config: ServerConfig = serverConfigOf(req);
    const workspaceId = String(req.query.workspace_id || '');
    if (!workspaceId) return res.status(400).json({ error: 'workspace_id is required' });
    const auth = await authorizeWorkspaceMember(req, res, config, workspaceId);
    if (!auth) return;

    const sb = getServiceClient(config);
    const seesAll = supervisesInbox(auth) && String(req.query.scope || 'mine') === 'all';
    const counters = await loadInboxCounters(sb, workspaceId, auth.userId, seesAll);
    if (counters) {
      return res.json({
        main: counters.inbox_main,
        automated: counters.inbox_automated,
        needs_human: counters.inbox_needs_human,
        spam: counters.inbox_spam,
      });
    }
    const base = () => {
      const q = sb.from('conversations').select('id', { count: 'exact', head: true }).eq('workspace_id', workspaceId);
      return seesAll ? q : q.or(`assigned_to.is.null,assigned_to.eq.${auth.userId}`);
    };
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
  } catch (err) {
    console.error('[conversations inbox-counts] error:', err);
    return res.status(500).json({ error: err?.message || 'Internal error' });
  }
});

// ─── The Inbox's unread number ──────────────────────────────────────
// How many of this operator's open conversations (nobody's or theirs) hold a
// visitor message nobody has read: the badge on Inbox in every web
// navigation and the tab title's "(n)" (services/inboxUnread.ts). Always the
// operator's own scope, also for a supervisor watching "All".
conversationsRouter.get('/unread', async (req, res) => {
  try {
    const config: ServerConfig = serverConfigOf(req);
    const workspaceId = String(req.query.workspace_id || '');
    if (!workspaceId) return res.status(400).json({ error: 'workspace_id is required' });
    const auth = await authorizeWorkspaceMember(req, res, config, workspaceId);
    if (!auth) return;
    return res.json(await loadInboxUnread(config, { workspaceId, userId: auth.userId }));
  } catch (err) {
    console.error('[conversations unread] error:', err);
    return res.status(500).json({ error: err?.message || 'Internal error' });
  }
});

// ─── Per-tab counters for the Main Inbox status tabs ─────────────────
conversationsRouter.get('/inbox-tab-counts', async (req, res) => {
  try {
    const config: ServerConfig = serverConfigOf(req);
    const workspaceId = String(req.query.workspace_id || '');
    if (!workspaceId) return res.status(400).json({ error: 'workspace_id is required' });
    const auth = await authorizeWorkspaceMember(req, res, config, workspaceId);
    if (!auth) return;

    const sb = getServiceClient(config);
    const seesAll = supervisesInbox(auth) && String(req.query.scope || 'mine') === 'all';
    const counters = await loadInboxCounters(sb, workspaceId, auth.userId, seesAll);
    if (counters) {
      return res.json({
        open: counters.tab_open,
        pending: counters.tab_pending,
        resolved: counters.tab_resolved,
        all: counters.tab_all,
        needs_human: counters.tab_needs_human,
        automated: counters.tab_automated,
      });
    }
    const scopeAssignment = (q) =>
      seesAll ? q : q.or(`assigned_to.is.null,assigned_to.eq.${auth.userId}`);
    const base = () =>
      scopeAssignment(sb.from('conversations').select('id', { count: 'exact', head: true })
        .eq('workspace_id', workspaceId).eq('is_spam', false).or('ai_state.is.null,ai_state.neq.ai_managed'));
    /* The AI tab lives outside `base()` scope: it counts exactly the
       ai_managed threads that base() excludes — with the list's own
       narrowing (not closed, not claimed by anyone), so the number on the
       tab is the number of rows behind it. */
    const automatedQuery = scopeAssignment(sb.from('conversations').select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId).eq('is_spam', false).eq('ai_state', 'ai_managed')
      .neq('status', 'closed').is('assigned_to', null));
    const [openRes, pendingRes, resolvedRes, allRes, needsRes, automatedRes] = await Promise.all([
      base().eq('status', 'open'),
      base().eq('status', 'pending'),
      base().in('status', ['resolved', 'closed']),
      base(),
      base().eq('ai_state', 'needs_human'),
      automatedQuery,
    ]);
    // Same ownership rule as the list: a finished thread another operator
    // handled is not part of this operator's Resolved tab.
    let resolvedCount = resolvedRes.count ?? 0;
    if (!seesAll && resolvedCount > 0) {
      // Not the AI's (the list's own filter): the inactivity close ends AI-only
      // conversations without touching their ai_state (migration 284).
      const { data: resolvedRows } = await sb
        .from('conversations')
        .select('id, assigned_to')
        .eq('workspace_id', workspaceId)
        .eq('is_spam', false)
        .in('status', ['resolved', 'closed'])
        .or('ai_state.is.null,ai_state.neq.ai_managed')
        .or(`assigned_to.is.null,assigned_to.eq.${auth.userId}`)
        .limit(2000);
      const rows = (resolvedRows || []);
      const ids = rows.map((r) => r.id);
      const handled: Record<string, Set<string>> = {};
      if (ids.length) {
        const { data: agentMsgs } = await sb
          .from('conversation_messages')
          .select('conversation_id, sender_id')
          .in('conversation_id', ids)
          .eq('sender_type', 'agent')
          .limit(5000);
        for (const m of (agentMsgs || [])) {
          if (!m.sender_id) continue;
          (handled[m.conversation_id] ||= new Set<string>()).add(String(m.sender_id));
        }
      }
      resolvedCount = rows.filter((r) => {
        if (r.assigned_to && r.assigned_to !== auth.userId) return false;
        const set = handled[r.id];
        return !set || set.size === 0 || set.has(auth.userId);
      }).length;
    }
    return res.json({
      open: openRes.count ?? 0,
      pending: pendingRes.count ?? 0,
      resolved: resolvedCount,
      all: allRes.count ?? 0,
      needs_human: needsRes.count ?? 0,
      automated: automatedRes.count ?? 0,
    });

  } catch (err) {
    console.error('[conversations inbox-tab-counts] error:', err);
    return res.status(500).json({ error: err?.message || 'Internal error' });
  }
});

/**
 * GET /api/conversations/:id?workspace_id= — one conversation, in the list's
 * shape (`{ conversation }`), whichever queue it is in.
 *
 * For a native client opening a thread from a notification: it has an id and
 * no list containing it, and without this it would have to read every queue
 * to find one row. Registered after every literal GET path on this router,
 * and it passes anything that is not a UUID on, so no other route is shadowed.
 */
conversationsRouter.get('/:id', async (req, res, next) => {
  const id = String(req.params.id || '');
  if (!isConversationId(id)) return next();
  try {
    const config: ServerConfig = serverConfigOf(req);
    const workspaceId = String(req.query.workspace_id || '');
    if (!isConversationId(workspaceId)) return res.status(400).json({ error: 'workspace_id is required' });
    const auth = await authorizeWorkspaceMember(req, res, config, workspaceId);
    if (!auth) return;
    const listed = await listConversationRows(config, auth, {
      workspaceId,
      queue: 'any',
      needsHuman: false,
      canSeeAllAssignments: true,
      ids: [id.toLowerCase()],
    });
    if (listed.error) return res.status(500).json({ error: listed.error });
    const conversation = listed.rows[0];
    if (!conversation) return res.status(404).json({ error: 'conversation_not_found' });
    return res.json({ conversation });
  } catch (err) {
    console.error('[conversation by id] error:', err);
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
/** A conversation_messages row as the thread endpoint reads it (`select *`). */
interface MessageRow {
  id: string;
  conversation_id: string;
  sender_type: string;
  sender_id: string | null;
  body: string | null;
  created_at: string;
  updated_at?: string | null;
  seen_at?: string | null;
  metadata?: Record<string, unknown> | null;
  [column: string]: unknown;
}

conversationsRouter.get('/:id/messages', async (req, res) => {
  try {
    const config: ServerConfig = serverConfigOf(req);
    const conversationId = req.params.id;
    const sb = getServiceClient(config);

    const { data: conv } = await sb
      .from('conversations')
      .select('id, workspace_id, created_at, updated_at, channel:metadata->>channel')
      .eq('id', conversationId)
      .maybeSingle();
    if (!conv) return res.status(404).json({ error: 'conversation_not_found' });

    const auth = await authorizeWorkspaceMember(req, res, config, conv.workspace_id);
    if (!auth) return;
    if (await refuseLockedConversation(res, config, conv.workspace_id, conv)) return;

    // Reactions (a widget conversation only: no other channel has them), read
    // alongside the thread. `can_react` marks the visitor's messages an
    // operator may react to: only where the visitor sees reactions.
    const widgetThread = isWidgetChannel((conv as { channel?: string | null }).channel);
    const reactionsP: Promise<ConversationReactions | null> = widgetThread
      ? readConversationReactions(sb, conversationId, { type: 'operator', userId: auth.userId })
      : Promise.resolve(null);
    const reactionsShownP = widgetThread ? workspaceShowsReactions(config, conv.workspace_id) : Promise.resolve(false);
    // System rows' bodies go out in this operator's language (below).
    const readerLocaleP = operatorLocale(config, auth.userId);

    const threadRows = () => sb.from('conversation_messages').select('*').eq('conversation_id', conversationId);
    // `?since=<cursor>`: only rows created/changed since then (services/messageSync.ts).
    const since = parseSyncCursor(req.query.since);
    let syncMode: 'full' | 'delta' = 'full';
    let rows: MessageRow[] | null = null;
    if (since) {
      const { data: changed, error: deltaError } = await threadRows()
        .gt('updated_at', deltaLowerBound(since))
        .order('updated_at', { ascending: true });
      if (!deltaError) {
        rows = inThreadOrder((changed || []) as MessageRow[]);
        syncMode = 'delta';
      } else {
        // Not migrated yet (no updated_at column): answer in full rather than fail.
        console.warn('[conversations messages] delta read unavailable, full read instead:', deltaError.message);
      }
    }
    if (!rows) {
      const { data, error } = await threadRows().order('created_at', { ascending: true });
      if (error) return res.status(500).json({ error: error.message });
      rows = (data || []) as MessageRow[];
    }
    const syncCursor = nextSyncCursor(rows, syncMode === 'delta' ? since : null);
    let messages = rows;

    // Super Admin can hide Telegram bot menu taps from operator threads.
    if (messages.some((m) => String(m?.metadata?.channel_menu_event ?? '') === 'true')) {
      const menuVisible = await isTelegramMenuEventsVisible(config);
      if (!menuVisible) {
        messages = messages.filter(
          (m) => String(m?.metadata?.channel_menu_event ?? '') !== 'true',
        );
      }
    }

    const ids = new Set<string>();
    const fromMeta = new Set<string>();
    for (const m of messages) {
      if (m?.id) ids.add(m.id);
      const aid = m?.metadata?.attachment_id;
      if (typeof aid === 'string') fromMeta.add(aid);
    }
    const attMap: Record<string, MessageAttachment> = {};
    // A single inbound channel message can carry SEVERAL media parts
    // (WhatsApp album, Telegram document + caption, …) so this is a list.
    const byMsg: Record<string, MessageAttachment[]> = {};
    if (ids.size || fromMeta.size) {
      const orFilters: string[] = [];
      if (ids.size) orFilters.push(`message_id.in.(${Array.from(ids).join(',')})`);
      if (fromMeta.size) orFilters.push(`id.in.(${Array.from(fromMeta).join(',')})`);
      const { data: atts } = await sb
        .from('conversation_attachments')
        .select('id, file_name, mime_type, size_bytes, status, message_id, created_at')
        .or(orFilters.join(','));
      for (const a of (atts || [])) {
        if (a.status !== 'attached' && a.status !== 'uploaded') continue;
        const mime = String(a.mime_type || '');
        const meta = {
          id: a.id, file_name: a.file_name, mime_type: a.mime_type, size_bytes: a.size_bytes,
          kind: mime.startsWith('image/')
            ? 'image'
            : mime.startsWith('audio/')
              ? 'audio'
              : mime.startsWith('video/')
                ? 'video'
                : 'file',
        };
        attMap[a.id] = meta;
        if (a.message_id) (byMsg[a.message_id] ||= []).push(meta);
      }
    }

    const senderIds = Array.from(new Set(
      messages.filter((m) => (m.sender_type === 'agent' || m.sender_type === 'ai') && m.sender_id).map((m) => m.sender_id),
    ));
    const senderMap: Record<string, { name: string | null; avatar: string | null }> = {};
    if (senderIds.length) {
      const { data: profiles } = await sb.from('profiles').select('id, full_name, avatar_storage_key').in('id', senderIds);
      for (const p of await hydrateUserAvatars(config, profiles || [])) {
        senderMap[p.id] = { name: p.full_name || null, avatar: p.avatar_url || null };
      }
    }

    // An AI reply has no sender_id — nobody's profile is behind it — so the
    // lookup above never gave it a face, and the operator apps drew every AI
    // bubble with none. The agent's own logo is the one the widget shows the
    // visitor; derived once per read, and only when the thread has AI turns.
    // Null when the workspace never uploaded one: the apps draw their own.
    const hasAiTurns = messages.some((m) => m.sender_type === 'ai' || m.sender_type === 'bot');
    const agentLogo = hasAiTurns
      ? await resolveWorkspaceAgentLogoUrl(config, conv.workspace_id).catch(() => null)
      : null;

    const [reactions, reactionsShown, readerLocale] = await Promise.all([reactionsP, reactionsShownP, readerLocaleP]);
    const canReact = reactionsShown && !!reactions?.ready;

    const enriched = messages.map((m) => {
      const aid = m?.metadata?.attachment_id;
      const list: unknown[] = [];
      const seen = new Set<string>();
      if (typeof aid === 'string' && attMap[aid]) { list.push(attMap[aid]); seen.add(aid); }
      for (const a of (m.id && byMsg[m.id]) || []) {
        if (!seen.has(a.id)) { list.push(a); seen.add(a.id); }
      }
      const prof = m.sender_id ? senderMap[m.sender_id] : null;
      const reacted = m.id ? reactions?.byMessage.get(m.id) : undefined;
      // A system row's stored body is English; it goes out written in this
      // operator's language for a client that prints `body` (an installed
      // native app without the kind). `metadata` keeps the stored values,
      // apart from the English stand-in names ('a colleague'), nulled.
      return {
        ...withOperatorSystemBody(m, readerLocale),
        // `attachment` kept for backwards compatibility with older clients.
        ...(list.length ? { attachment: list[0], attachments: list } : {}),
        sender_name: prof?.name ?? null,
        sender_avatar: prof?.avatar
          ?? ((m.sender_type === 'ai' || m.sender_type === 'bot') ? agentLogo : null),
        // [{emoji, count, mine, visitor}] for this operator; absent without
        // any (in a ?since delta too: the message came back because its
        // reactions changed, and none means none now).
        ...(reacted && reacted.length ? { reactions: reacted } : {}),
        ...(canReact && reactableByOperator(m) ? { can_react: true } : {}),
      };
    });


    // `sync` is new: older clients ignore it. `cursor` is null until the database has
    // `updated_at` (then the client simply keeps reading in full).
    return res.json({ messages: enriched, sync: { mode: syncMode, cursor: syncCursor } });
  } catch (err) {
    console.error('[conversations messages] error:', err);
    return res.status(500).json({ error: err?.message || 'Internal error' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// POST /:id/messages/:messageId/reactions — an operator's reaction to a
// visitor's message (issue #340 g2).
//
// Body { workspace_id, emoji (❤️ 👍 😂 😮 😢 🙏; taking back, also one since
// dropped from the list), on } → 200 { ok, message_id,
// reactions: [{emoji, count, mine, visitor}], at } | 400 Invalid payload /
// invalid_emoji | 401 / 403 (membership, seat lock, plan lock) | 404
// conversation_not_found / message_not_found | 409 reactions_not_shown (the
// workspace's template does not draw reactions) | 422
// reactions_unsupported_channel (Telegram, WhatsApp, …: the customer would
// never see it) / not_reactable (not the visitor's message) | 503
// migration_required. Sets or takes back this operator's reaction, either
// idempotent; a change is published (services/messageReactions.ts). Not a
// reply: nothing else about the conversation changes.
// ═══════════════════════════════════════════════════════════════════
const reactionSchema = z.object({
  workspace_id: z.string().uuid(),
  emoji: z.unknown(),
  on: z.boolean(),
});

conversationsRouter.post('/:id/messages/:messageId/reactions', async (req, res) => {
  try {
    const config: ServerConfig = serverConfigOf(req);
    const conversationId = String(req.params.id || '');
    const messageId = String(req.params.messageId || '');
    const parsed = reactionSchema.safeParse(req.body ?? {});
    if (!parsed.success || !isConversationId(conversationId) || !isConversationId(messageId)) {
      return res.status(400).json({ error: 'Invalid payload' });
    }
    // Given: one of the list. Taken back: also one since dropped from it.
    const emoji = parsed.data.on ? normalizeReactionEmoji(parsed.data.emoji) : reactionEmojiToTakeBack(parsed.data.emoji);
    if (!emoji) return res.status(400).json({ error: 'invalid_emoji' });
    const workspaceId = parsed.data.workspace_id;

    const auth = await authorizeWorkspaceMember(req, res, config, workspaceId);
    if (!auth) return;

    const sb = getServiceClient(config);
    const { data: conv } = await sb
      .from('conversations')
      .select('id, workspace_id, created_at, updated_at, channel:metadata->>channel')
      .eq('id', conversationId)
      .maybeSingle();
    if (!conv || conv.workspace_id !== workspaceId) return res.status(404).json({ error: 'conversation_not_found' });
    if (await refuseLockedConversation(res, config, workspaceId, conv)) return;
    if (!isWidgetChannel((conv as { channel?: string | null }).channel)) {
      return res.status(422).json({ error: 'reactions_unsupported_channel' });
    }
    if (!(await workspaceShowsReactions(config, workspaceId))) return res.status(409).json({ error: 'reactions_not_shown' });

    const { data: message } = await sb
      .from('conversation_messages')
      .select('id, conversation_id, sender_type, metadata')
      .eq('id', messageId)
      .eq('conversation_id', conversationId)
      .maybeSingle();
    if (!message) return res.status(404).json({ error: 'message_not_found' });
    if (!reactableByOperator(message)) return res.status(422).json({ error: 'not_reactable' });

    const outcome = await setMessageReaction(sb, {
      workspaceId,
      conversationId,
      messageId,
      actorType: 'operator',
      actorId: auth.userId,
      emoji,
      on: parsed.data.on,
    });
    if (outcome === 'missing') return res.status(503).json(REACTIONS_MIGRATION_REQUIRED);
    // Taken before the read: a later `at` always saw every earlier write.
    const at = Date.now();
    const summary = await readMessageReactions(sb, messageId, { type: 'operator', userId: auth.userId });
    if (outcome === 'changed') {
      void publishMessageReactions(config, { workspaceId, conversationId, messageId, reactions: summary, at });
    }
    return res.json({ ok: true, message_id: messageId, reactions: summary, at });
  } catch (err) {
    console.error('[conversations reactions] error:', err);
    return res.status(500).json({ error: 'Internal error' });
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
conversationsRouter.post('/:id/seen', async (req, res) => {
  try {
    const config: ServerConfig = serverConfigOf(req);
    const conversationId = req.params.id;
    const sb = getServiceClient(config);

    const { data: conv } = await sb
      .from('conversations')
      .select('id, workspace_id')
      .eq('id', conversationId)
      .maybeSingle();
    if (!conv) return res.status(404).json({ error: 'conversation_not_found' });

    const auth = await authorizeWorkspaceMember(req, res, config, conv.workspace_id);
    if (!auth) return;

    const seenAt = new Date().toISOString();
    const { data, error } = await sb
      .from('conversation_messages')
      .update({ seen_at: seenAt })
      .eq('conversation_id', conversationId)
      .eq('sender_type', 'contact')
      .is('seen_at', null)
      .select('id');
    if (error) return res.status(500).json({ error: error.message });
    // The visitor's ticks turn "seen" live (services/widget/visitorSeen.ts).
    void publishVisitorSeen(config, conv.workspace_id, conversationId, (data || []).map((r) => r.id as string), seenAt);
    // And every operator's Inbox badge drops the chat (services/inboxUnread.ts).
    if ((data || []).length > 0) {
      void publishConversationSeen(config, { workspaceId: conv.workspace_id, conversationId, actorId: auth.userId, seenAt });
    }
    return res.json({ ok: true, count: (data || []).length });
  } catch (err) {
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

conversationsRouter.delete('/', async (req, res) => {
  try {
    const config: ServerConfig = serverConfigOf(req);
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
    const ids = (convs ?? []).map((c) => c.id);
    if (ids.length === 0) return res.json({ deleted: 0 });

    const { error: msgErr } = await sb.from('conversation_messages').delete().in('conversation_id', ids);
    if (msgErr) return res.status(500).json({ error: msgErr.message });

    const { error: convErr } = await sb.from('conversations').delete().in('id', ids);
    if (convErr) return res.status(500).json({ error: convErr.message });

    return res.json({ deleted: ids.length });
  } catch (err) {
    console.error('[conversations delete-all] error:', err);
    return res.status(500).json({ error: err?.message || 'Internal error' });
  }
});

conversationsRouter.post('/not-spam', async (req, res) => {
  const config = serverConfigOf(req);
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
  } catch (err) {
    if (err?.message === 'conversation_not_found') {
      return res.status(404).json({ error: 'conversation_not_found' });
    }
    console.error('[conversations not-spam] error:', err);
    return res.status(500).json({ error: err?.message || 'Internal error' });
  }
});
