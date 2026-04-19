/**
 * Centralized realtime publish helper.
 *
 * Resolves the global realtime provider and publishes an event to the
 * conversation channel `ws:<workspace_id>:conv:<conversation_id>`.
 *
 * Symmetric event model — the same payload shape is used for visitor
 * messages, agent messages, typing, and seen/read state. The widget's
 * Centrifugo runtime (public/widget/runtime-rt-centrifugo.js) and the
 * inbox subscriber both consume the same envelope:
 *
 *   { type: 'message' | 'typing' | 'seen', payload: { ... } }
 *
 * Fail-safe: never throws. If realtime is disabled, mis-configured, or
 * the publish call fails, returns { ok: false, reason } and the caller
 * continues — the DB write is the source of truth.
 */

import type { ServerConfig } from '../../config.js';
import { getCentrifugoDriver, loadRealtimeConfig } from './index.js';
import { buildChannelName } from './types.js';

export interface ConversationEventEnvelope {
  type: 'message' | 'typing' | 'seen';
  payload: Record<string, unknown>;
}

export async function publishConversationEvent(
  config: ServerConfig,
  workspaceId: string,
  conversationId: string,
  event: ConversationEventEnvelope,
): Promise<{ ok: boolean; reason?: string }> {
  try {
    const cfg = await loadRealtimeConfig(config);
    if (!cfg.enabled || cfg.vendor !== 'centrifugo') {
      return { ok: false, reason: 'realtime_not_centrifugo' };
    }
    const driver = await getCentrifugoDriver(config);
    if (!driver) return { ok: false, reason: 'driver_not_configured' };

    const channel = buildChannelName(workspaceId, conversationId);
    const result = await driver.publish(channel, event as unknown as Record<string, unknown>);
    if (!result.ok) {
      console.warn('[realtime/publish] publish failed', channel, result.error);
      return { ok: false, reason: result.error };
    }
    return { ok: true };
  } catch (err: any) {
    console.warn('[realtime/publish] error', err?.message || err);
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
