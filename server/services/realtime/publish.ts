/**
 * Centralized realtime publish helper — vendor-agnostic.
 *
 * This module is the only entry point the application code uses to push
 * conversation events to clients. Vendor selection is delegated to
 * `resolvePublisher()` and the actual transport lives in
 * `publishers/{centrifugo,supabase,noop}.ts`.
 *
 * Stable contracts (do not change):
 *   - channels:
 *       ws:<workspace_id>:conv:<conversation_id>   visitor + operator
 *       ws:<workspace_id>:inbox                    operator-only
 *   - envelope: { type: 'message' | 'typing' | 'seen' | 'event', payload: { ... } }
 *
 * `event` envelopes are operator-oriented: they travel on the inbox channel,
 * and only the few kinds the widget acts on (WIDGET_EVENT_FIELDS) also on the
 * conversation channel, which the visitor's browser subscribes to. A
 * `message` envelope reaches the conversation channel as the visitor's copy
 * (visitorMessagePayload: no operator account ids) and the inbox channel
 * whole; typing and seen envelopes are unchanged.
 *
 * Fail-safe: never throws. If realtime is disabled, mis-configured, or
 * the publish call fails, returns { ok: false, reason } and the caller
 * continues — the DB write is the source of truth, React Query polling
 * drives the inbox UI.
 */

import type { ServerConfig } from '../../config.js';
import { resolvePublisher } from './resolvePublisher.js';
import {
  buildChannelName,
  buildInboxChannelName,
  buildOperatorUserChannelName,
  buildVisitorsChannelName,
} from './types.js';
import type { ConversationEventEnvelope } from './publishers/types.js';
import { rtDebug, rtWarn } from './debug.js';
import { isPlaceholderName, looksLikeEmail, visitorDisplayName } from '../../../shared/systemMessages.js';

export type { ConversationEventEnvelope } from './publishers/types.js';

export async function publishConversationEvent(
  config: ServerConfig,
  workspaceId: string,
  conversationId: string,
  event: ConversationEventEnvelope,
): Promise<{ ok: boolean; reason?: string }> {
  try {
    const publisher = await resolvePublisher(config, workspaceId);
    const channel = buildChannelName(workspaceId, conversationId);
    rtDebug('publish', 'attempt', {
      vendor: publisher.vendor,
      channel,
      type: event.type,
    });
    // The visitor's browser subscribes to this channel: a message goes out
    // without the operator account ids it carries (the inbox copy below and
    // every operator API keep them).
    const result = await publisher.publish(
      channel,
      event.type === 'message' ? { type: 'message', payload: visitorMessagePayload(event.payload) } : event,
    );
    if (result.ok) {
      rtDebug('publish', 'ok', { vendor: publisher.vendor, channel, type: event.type });
    } else {
      rtWarn('publish', 'skipped', {
        vendor: publisher.vendor,
        channel,
        type: event.type,
        reason: result.reason,
      });
    }
    // Phase 5b — also fan out `message` envelopes to the workspace inbox
    // channel so the operator's conversation list updates instantly even
    // when the affected conversation is not currently open. The list has no
    // periodic poll, so without this it would only refresh on mount, tab
    // switch or the operator's own actions. The widget runtime never
    // subscribes to the inbox channel, so this is purely operator-facing
    // and safe.
    if (event.type === 'message') {
      try {
        const inboxChannel = buildInboxChannelName(workspaceId);
        const inboxResult = await publisher.publish(inboxChannel, event);
        if (!inboxResult.ok) {
          rtWarn('publish', 'inbox_message_skipped', {
            vendor: publisher.vendor,
            channel: inboxChannel,
            reason: inboxResult.reason,
          });
        }
      } catch (err) {
        rtWarn('publish', 'inbox_message_error', { error: err?.message || String(err) });
      }
    }
    return result;
  } catch (err) {
    rtWarn('publish', 'error', { error: err?.message || String(err) });
    return { ok: false, reason: err?.message || 'unknown_error' };
  }
}

/**
 * Build the `message` envelope from a freshly inserted conversation_messages row.
 * Mirrors the shape that widget /history and /poll already return so the
 * widget can drop the message into its UI without translation.
 */
export function buildMessageEnvelope(row: {
  id: string;
  conversation_id: string;
  sender_type: 'contact' | 'agent' | 'system' | 'ai';
  body: string;
  created_at: string | null;
  metadata?: Record<string, unknown> | null;
  seen_at?: string | null;
  /**
   * Operator/AI identity. Realtime used to omit these, so a live operator
   * reply rendered with no avatar until the visitor reloaded (only /poll and
   * /history enriched the sender). Any caller that inserts an agent message
   * must pass them so the widget can draw the avatar immediately.
   */
  sender_id?: string | null;
  sender_name?: string | null;
  sender_avatar?: string | null;
  attachment?: unknown;
  attachments?: unknown;
  /**
   * Structured reply-to-message relationship. `reply_to_message_id` is the
   * raw FK (conversation_messages.reply_to_message_id, migration 176);
   * `reply_to` is an OPTIONAL pre-resolved `{id, text, sender_type}`
   * preview the caller already fetched (widget.ts's POST /message does
   * this with zero extra query, reusing the row it fetched to validate the
   * reply target) — never resolved here, since this function must stay
   * synchronous and callers that only have the raw id (e.g. a bulk
   * republish) can omit it and let the widget fall back to the id alone.
   */
  reply_to_message_id?: string | null;
  reply_to?: { id: string; text: string; sender_type: string } | null;
}): ConversationEventEnvelope {
  const meta = (row.metadata && typeof row.metadata === 'object') ? row.metadata as Record<string, unknown> : {};
  return {
    type: 'message',
    payload: {
      id: row.id,
      conversation_id: row.conversation_id,
      role:
        row.sender_type === 'contact'
          ? 'visitor'
          : row.sender_type === 'system'
            ? 'system'
            : 'agent',
      sender_type: row.sender_type,
      text: row.body,
      body: row.body,
      time: row.created_at,
      created_at: row.created_at,
      seen_at: row.seen_at ?? null,
      metadata: row.metadata ?? {},
      sender_id: row.sender_id ?? null,
      sender_name: row.sender_name ?? meta.agent_name ?? null,
      // No metadata fallback: `agent_logo_url` is no longer snapshotted into
      // a message row, because a stored URL names one provider. The caller
      // passes a link it derived from the storage key, or none.
      sender_avatar: row.sender_avatar ?? null,
      ...(row.attachment ? { attachment: row.attachment } : {}),
      ...(row.attachments ? { attachments: row.attachments } : {}),
      ...(row.reply_to_message_id ? { reply_to_message_id: row.reply_to_message_id } : {}),
      ...(row.reply_to ? { reply_to: row.reply_to } : {}),
    },
  };
}

// ─────────────────────────────────────────────────────────────────────
// What a visitor may see of a message
// ─────────────────────────────────────────────────────────────────────

/**
 * Message metadata keys that name an operator's account (their user id), as
 * the server writes them: a join's `agent_id` and `actor_id`
 * (chatRouting.ts, the inbox PATCH), a transfer's `actor_id`, `from_id` and
 * `to_id`, the closed line's `agent_id` and `operator_id`
 * (conversationClosedNotice.ts); the rest are the same idea under the names
 * other rows use. The visitor's widget reads none of them: it shows the
 * names next to them (`agent_name`, `to_name`, `operator_name`), and the
 * server reads the ids from the stored row, never from the widget.
 */
export const OPERATOR_ID_METADATA_KEYS: readonly string[] = [
  'actor_id', 'agent_id', 'operator_id', 'from_id', 'to_id',
  'sender_id', 'assigned_to', 'created_by_user_id', 'ended_by_user_id',
];

/**
 * Metadata keys that hold the NAME the visitor's sentence shows (a join's
 * `agent_name`, a transfer's `to_name`, a call invitation's
 * `operator_name`). A value that is an English stand-in ('a colleague',
 * which chatRouting.ts once stored as a name: shared/systemMessages.ts
 * isPlaceholderName) or an email address (call invitations once fell back
 * to the operator's) is not a name: without it every renderer writes its
 * own generic sentence, in the visitor's language.
 */
const VISITOR_NAME_METADATA_KEYS: readonly string[] = ['agent_name', 'to_name', 'operator_name'];

function notAVisitorName(key: string, value: unknown): boolean {
  return VISITOR_NAME_METADATA_KEYS.includes(key) && (isPlaceholderName(value) || looksLikeEmail(value));
}

/**
 * A message's metadata as the visitor gets it: without
 * OPERATOR_ID_METADATA_KEYS, and without a name key that holds no name
 * (above). The same object when nothing goes (so such a row answers exactly
 * as it always did), else a shallow copy, keys in their order.
 */
export function visitorMessageMetadata<T>(metadata: T): T {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return metadata;
  const meta = metadata as Record<string, unknown>;
  const drop = (key: string) => OPERATOR_ID_METADATA_KEYS.includes(key) || notAVisitorName(key, meta[key]);
  if (!Object.keys(meta).some(drop)) return metadata;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta)) {
    if (!drop(key)) out[key] = value;
  }
  return out as T;
}

/**
 * A message row or `message` payload as the visitor gets it, on every path:
 * the conversation channel (publishConversationEvent), GET /poll, /history
 * and /identity/history. No `sender_id` (an operator's user id on their
 * replies, the inviting or hanging-up operator's on call rows; nothing in the
 * widget groups or labels by it: runtime.js keys a sender by its name and
 * avatar) and metadata through visitorMessageMetadata. A `sender_name` that
 * is a placeholder or an email address (an operator who typed theirs as
 * their profile name, I-10) is null: the widget then writes its own word
 * for an operator. An AI row keeps its stored name, the built-in
 * 'AI Assistant' too: the runtime.js loaded before this release labels the
 * reply with it, and today's treats it as no name (runtime.js aiOwnName).
 * Keys keep their order.
 */
export function visitorMessagePayload<T extends Record<string, unknown>>(payload: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (key === 'sender_id') continue;
    if (key === 'metadata') out[key] = visitorMessageMetadata(value);
    else if (key === 'sender_name') out[key] = typeof value === 'string' ? visitorDisplayName(value) : value;
    else out[key] = value;
  }
  return out as T;
}


// ─────────────────────────────────────────────────────────────────────
// Operator event envelopes (Phase 5 — realtime push for non-message events)
// ─────────────────────────────────────────────────────────────────────

/** Discriminated `payload.kind` values for `type: 'event'` envelopes. */
export type OperatorEventKind =
  | 'contact_updated'
  | 'conversation_updated'
  | 'conversation_resolved'
  | 'conversation_reopened'
  | 'note_added'
  | 'note_deleted'
  | 'timeline_event'
  | 'spam_changed'
  // The AI hand-over pair (services/ai-agent/handoffState.ts): published
  // on the same channel, and read by the apps like any other kind.
  | 'ai_handoff_requested'
  | 'ai_human_takeover'
  // Email Inbox: "this mailbox changed, re-read it" — ids and a cursor only,
  // never content (docs/EMAIL_INBOX_ARCHITECTURE.md).
  | 'email_mailbox_changed'
  // The operator's AI suggestion card (engine/deliveryStage.ts,
  // routes/ai-agent/activity.ts): ids only.
  | 'ai_suggestion_created'
  | 'ai_suggestion_updated'
  // A message's reactions changed (services/messageReactions.ts): its new
  // counts, read by the visitor's widget too (WIDGET_EVENT_FIELDS). No
  // actor ids.
  | 'message_reactions'
  // A call invitation's status changed (services/calls/invitations.ts),
  // read by the inbox's call card (src/lib/call-invitations-events.ts).
  | 'call_invitation_changed'
  // The visitor read the conversation in the widget
  // (services/visitorReadReceipts.ts): `visitor_last_read_at`, for the
  // operator's "Seen". Operators only.
  | 'visitor_read';

export interface OperatorEventPayload {
  kind: OperatorEventKind;
  conversation_id: string;
  workspace_id: string;
  actor_id?: string | null;
  /** All other fields are kind-specific; UI must guard on `kind`. */
  [key: string]: unknown;
}

/** Wrap an operator event payload in the standard envelope shape. */
export function buildEventEnvelope(payload: OperatorEventPayload): ConversationEventEnvelope {
  return { type: 'event', payload: payload as Record<string, unknown> };
}

/**
 * The `event` kinds the visitor's widget acts on, each with the fields it
 * reads: all an `event` envelope may carry on ws:<ws>:conv:<cid>. The visitor
 * subscribes to that channel, and its realtime drivers
 * (public/widget/runtime-rt-centrifugo.js, runtime-rt-supabase.js) act on
 * these kinds only, but whatever is published there reaches the visitor's
 * browser, where devtools show it. Private-note events, tag, status and
 * assignee changes, AI suggestions and the timeline therefore travel on the
 * operator-only inbox channel alone. A kind the widget starts to act on is
 * added here, with exactly the fields it reads. (`call:incoming` is published
 * by routes/calls.ts itself, not through publishOperatorEvent.)
 */
export const WIDGET_EVENT_FIELDS: Readonly<Record<string, readonly string[]>> = {
  // handleServerCallEnded (public/widget/runtime.js): closes the call surface
  // and writes "operator ended the call · 02:15" into the thread.
  'call:ended': ['kind', 'call_session_id', 'ended_by', 'duration_seconds', 'ended_at'],
  // The reaction badge (runtime-late.js, Template 2): the message's new
  // counts `[{emoji, count, visitor}]` and the moment they were read (`at`,
  // ms: the widget keeps the newest). The same for every reader, so no
  // `mine`; never who reacted.
  message_reactions: ['kind', 'conversation_id', 'message_id', 'reactions', 'at'],
};

/** The visitor's copy of an operator event, or null when the widget has no use for its kind. */
export function widgetEventPayload(payload: OperatorEventPayload): Record<string, unknown> | null {
  const fields = Object.prototype.hasOwnProperty.call(WIDGET_EVENT_FIELDS, payload.kind)
    ? WIDGET_EVENT_FIELDS[payload.kind]
    : null;
  if (!fields) return null;
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    if (payload[field] !== undefined) out[field] = payload[field];
  }
  return out;
}

/**
 * Fan out an operator-oriented event to:
 *   1. The workspace inbox channel (operator-only): every event, whole. The
 *      conversation list, an open thread (useInboxRealtime picks its own
 *      conversation's events from it), the contacts and mailbox pages and the
 *      apps all listen there.
 *   2. The per-conversation channel, only for a kind the visitor's widget
 *      acts on, cut down to the fields it reads (WIDGET_EVENT_FIELDS).
 *      `skipConversationChannel` leaves even that out.
 *
 * Both publishes are best-effort and independent. The inbox list and its
 * counts have no periodic poll: an event lost here shows on the operator's
 * next list refetch (mount, tab switch, their own action), not within a
 * fixed interval.
 */
export async function publishOperatorEvent(
  config: ServerConfig,
  payload: OperatorEventPayload,
  opts?: { skipConversationChannel?: boolean },
): Promise<void> {
  const envelope = buildEventEnvelope(payload);
  const tasks: Promise<unknown>[] = [];

  const visitorCopy = opts?.skipConversationChannel ? null : widgetEventPayload(payload);
  if (visitorCopy) {
    tasks.push(
      publishConversationEvent(config, payload.workspace_id, payload.conversation_id, {
        type: 'event',
        payload: visitorCopy,
      }),
    );
  }

  tasks.push(
    (async () => {
      try {
        const publisher = await resolvePublisher(config, payload.workspace_id);
        const channel = buildInboxChannelName(payload.workspace_id);
        rtDebug('publish', 'attempt:inbox', {
          vendor: publisher.vendor,
          channel,
          kind: payload.kind,
        });
        const result = await publisher.publish(channel, envelope);
        if (!result.ok) {
          rtWarn('publish', 'inbox_skipped', {
            vendor: publisher.vendor,
            channel,
            kind: payload.kind,
            reason: result.reason,
          });
        }
      } catch (err) {
        rtWarn('publish', 'inbox_error', { error: err?.message || String(err) });
      }
    })(),
  );

  await Promise.allSettled(tasks);
}

// ─────────────────────────────────────────────────────────────────────
// Team-chat event envelopes
//   Channel: ws:<workspace_id>:user:<user_id>  (that operator only)
//   Envelope: { type: 'event', payload: { kind, workspace_id, ... } }
//   kinds: 'team_message' | 'team_read'
//
// Ids only, never the text: a client that hears one re-reads the thread or
// the colleague list over REST, where membership is checked again. Polling
// (the console's 10–20 s) remains the fallback when realtime is off.
// ─────────────────────────────────────────────────────────────────────

export type TeamEventKind = 'team_message' | 'team_read';

export interface TeamEventPayload {
  kind: TeamEventKind;
  workspace_id: string;
  /** `team_message`: the new row and who it is between. */
  message_id?: string;
  sender_id?: string;
  recipient_id?: string;
  /** `team_read`: whose messages the reader has just read. */
  peer_id?: string;
}

/**
 * Tell each of [userIds] — on their own channel — that something changed in
 * one of their team threads. Best-effort and never throws: the DB write is
 * the source of truth.
 */
export async function publishTeamEvent(
  config: ServerConfig,
  userIds: readonly string[],
  payload: TeamEventPayload,
): Promise<void> {
  const envelope: ConversationEventEnvelope = {
    type: 'event',
    payload: payload as unknown as Record<string, unknown>,
  };
  const targets = [...new Set(userIds.filter((id) => typeof id === 'string' && id.length > 0))];
  if (targets.length === 0) return;
  try {
    const publisher = await resolvePublisher(config, payload.workspace_id);
    await Promise.allSettled(
      targets.map(async (userId) => {
        const channel = buildOperatorUserChannelName(payload.workspace_id, userId);
        const result = await publisher.publish(channel, envelope);
        if (!result.ok) {
          rtWarn('publish', 'team_skipped', { vendor: publisher.vendor, kind: payload.kind, reason: result.reason });
        }
      }),
    );
  } catch (err) {
    rtWarn('publish', 'team_error', { error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Platform support: something new in one of an operator's support threads.
 *
 * The operator is not a member of the workspace that answers support, so the
 * news travels on their OWN user channel — once per workspace they belong
 * to, since an app is subscribed to the channel of whichever workspace it
 * has open. Ids only; the app reads the thread through
 * `/api/platform-support`.
 */
export interface SupportEventPayload {
  kind: 'support_message' | 'support_update' | 'support_read';
  thread_id: string;
  message_id?: string;
}

export async function publishSupportEvent(
  config: ServerConfig,
  userId: string,
  workspaceIds: readonly string[],
  payload: SupportEventPayload,
): Promise<void> {
  const targets = [...new Set(workspaceIds.filter((id) => typeof id === 'string' && id.length > 0))];
  if (!userId || targets.length === 0) return;
  await Promise.allSettled(
    targets.map(async (workspaceId) => {
      try {
        const publisher = await resolvePublisher(config, workspaceId);
        const result = await publisher.publish(buildOperatorUserChannelName(workspaceId, userId), {
          type: 'event',
          payload: { ...payload, workspace_id: workspaceId } as unknown as Record<string, unknown>,
        });
        if (!result.ok) {
          rtWarn('publish', 'support_skipped', { vendor: publisher.vendor, kind: payload.kind, reason: result.reason });
        }
      } catch (err) {
        rtWarn('publish', 'support_error', { error: err instanceof Error ? err.message : String(err) });
      }
    }),
  );
}

// ─────────────────────────────────────────────────────────────────────
// Visitor Intelligence event envelopes
//   Channel: ws:<workspace_id>:visitors  (operator-only)
//   Envelope: { type: 'event', payload: { kind, ... } }
//   kinds: 'visitor.upsert' | 'visitor.remove'
//
// Polling fallback: if realtime is disabled or the publisher fails, the
// Visitors page's React Query refetch (10–15s) keeps the UI fresh.
// ─────────────────────────────────────────────────────────────────────

export type VisitorEventKind = 'visitor.upsert' | 'visitor.remove';

export interface VisitorEventPayload {
  kind: VisitorEventKind;
  workspace_id: string;
  /** visitor_session_id (the row id used as key in the UI list/map). */
  session_id: string;
  /** Lightweight diff so the client can patch its cache without a refetch. */
  patch?: {
    status?: 'online' | 'idle' | 'offline' | 'unknown';
    current_page?: string | null;
    last_activity_at?: string;
    visitor_id?: string;
    /**
     * Set when the async geo enrichment finished AFTER ingestion. Operator
     * surfaces use it to invalidate their cached network profiles instead of
     * showing the pre-enrichment (empty/stale) geo until a manual refresh.
     */
    geo_enriched?: boolean;
  };
  occurred_at: string;
}

export async function publishVisitorEvent(
  config: ServerConfig,
  payload: VisitorEventPayload,
): Promise<void> {
  const envelope: ConversationEventEnvelope = {
    type: 'event',
    payload: payload as unknown as Record<string, unknown>,
  };
  try {
    const publisher = await resolvePublisher(config, payload.workspace_id);
    const channel = buildVisitorsChannelName(payload.workspace_id);
    rtDebug('publish', 'visitors:attempt', {
      vendor: publisher.vendor,
      channel,
      kind: payload.kind,
    });
    const result = await publisher.publish(channel, envelope);
    if (!result.ok) {
      rtWarn('publish', 'visitors:skipped', {
        vendor: publisher.vendor,
        channel,
        kind: payload.kind,
        reason: result.reason,
      });
    }
  } catch (err) {
    rtWarn('publish', 'visitors:error', { error: err?.message || String(err) });
  }
}
