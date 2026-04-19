/**
 * Centralized realtime publish helper — vendor-agnostic.
 *
 * This module is the only entry point the application code uses to push
 * conversation events to clients. Vendor selection is delegated to
 * `resolvePublisher()` and the actual transport lives in
 * `publishers/{centrifugo,supabase,noop}.ts`.
 *
 * Stable contracts (do not change):
 *   - channel:  ws:<workspace_id>:conv:<conversation_id>
 *   - envelope: { type: 'message' | 'typing' | 'seen', payload: { ... } }
 *
 * Fail-safe: never throws. If realtime is disabled, mis-configured, or
 * the publish call fails, returns { ok: false, reason } and the caller
 * continues — the DB write is the source of truth, React Query polling
 * drives the inbox UI.
 */

import type { ServerConfig } from '../../config.js';
import { resolvePublisher } from './resolvePublisher.js';
import { buildChannelName } from './types.js';
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
