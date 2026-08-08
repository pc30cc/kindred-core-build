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
 * `event` envelopes are operator-oriented. The widget runtime explicitly
 * ignores unknown `type` values for forward-safety. Existing message/typing/
 * seen envelopes remain byte-identical.
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
  buildVisitorsChannelName,
} from './types.js';
import type { ConversationEventEnvelope } from './publishers/types.js';
import { rtDebug, rtWarn } from './debug.js';

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
    const result = await publisher.publish(channel, event);
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
    // when the affected conversation is not currently open. Without this,
    // the inbox list only refreshes on the 10s React Query poll. The
    // widget runtime never subscribes to the inbox channel, so this is
    // purely operator-facing and safe.
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
      } catch (err: any) {
        rtWarn('publish', 'inbox_message_error', { error: err?.message || String(err) });
      }
    }
    return result;
  } catch (err: any) {
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
}): ConversationEventEnvelope {
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
    },
  };
}

// ─────────────────────────────────────────────────────────────────────
// Operator event envelopes (Phase 5 — realtime push for non-message events)
// ─────────────────────────────────────────────────────────────────────

/** Discriminated `payload.kind` values for `type: 'event'` envelopes. */
export type OperatorEventKind =
  | 'conversation_updated'
  | 'conversation_resolved'
  | 'conversation_reopened'
  | 'note_added'
  | 'note_deleted'
  | 'timeline_event'
  | 'spam_changed';

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
 * Fan out an operator-oriented event to BOTH:
 *   1. The per-conversation channel (so an open thread updates immediately).
 *   2. The workspace inbox channel (so the conversation list updates even
 *      when the conversation isn't open).
 *
 * Both publishes are best-effort and independent. If either transport is
 * disabled or fails, polling fallback still drives the UI within ≤10s.
 */
export async function publishOperatorEvent(
  config: ServerConfig,
  payload: OperatorEventPayload,
  opts?: { skipInboxChannel?: boolean; skipConversationChannel?: boolean },
): Promise<void> {
  const envelope = buildEventEnvelope(payload);
  const tasks: Promise<unknown>[] = [];

  if (!opts?.skipConversationChannel) {
    tasks.push(
      publishConversationEvent(config, payload.workspace_id, payload.conversation_id, envelope),
    );
  }

  if (!opts?.skipInboxChannel) {
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
        } catch (err: any) {
          rtWarn('publish', 'inbox_error', { error: err?.message || String(err) });
        }
      })(),
    );
  }

  await Promise.allSettled(tasks);
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
  } catch (err: any) {
    rtWarn('publish', 'visitors:error', { error: err?.message || String(err) });
  }
}
