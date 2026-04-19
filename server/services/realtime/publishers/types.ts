/**
 * Server-side realtime publisher interface.
 *
 * One small contract that every transport must implement. The conversation
 * route does not know which vendor is active — it just calls
 * `publisher.publish(channel, envelope)`. Resolution lives in
 * `resolvePublisher.ts`.
 *
 * Stable contracts every publisher MUST honor (do not change):
 *   - channels:
 *       ws:<workspace_id>:conv:<conversation_id>   (visitor + operator)
 *       ws:<workspace_id>:inbox                    (operator-only)
 *   - envelope:
 *       { type: 'message' | 'typing' | 'seen' | 'event', payload: { ... } }
 *
 * The 'event' type is OPERATOR-ORIENTED. The widget runtime explicitly
 * ignores it (forward-safe). Existing message/typing/seen envelopes are
 * unchanged byte-for-byte.
 *
 * publish() must be fail-safe: never throw. On failure return
 * { ok: false, reason } and the caller continues — DB write is the source
 * of truth, polling fallback drives the UI.
 */

export type ConversationEventEnvelopeType = 'message' | 'typing' | 'seen' | 'event';

export interface ConversationEventEnvelope {
  type: ConversationEventEnvelopeType;
  payload: Record<string, unknown>;
}

export interface PublishResult {
  ok: boolean;
  reason?: string;
}

export type PublisherVendor = 'centrifugo' | 'supabase' | 'noop';

export interface ServerRealtimePublisher {
  readonly vendor: PublisherVendor;
  publish(channel: string, envelope: ConversationEventEnvelope): Promise<PublishResult>;
}
