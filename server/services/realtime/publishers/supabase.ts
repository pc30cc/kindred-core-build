/**
 * Supabase Realtime publisher.
 *
 * Broadcasts the envelope on a Supabase Broadcast channel using the SAME
 * channel name and SAME payload shape the Centrifugo path uses, so the
 * existing client adapter (src/realtime/providers/supabase.ts) and the
 * widget runtime can consume it without translation.
 *
 * Implementation notes:
 *   - We use the service-role Supabase client. Broadcast publish does not
 *     require RLS; the channel name is multi-tenant safe
 *     (`ws:<workspace_id>:conv:<conversation_id>`) and the client must
 *     prove workspace membership before subscribing on the operator side.
 *   - We send via REST (`channel.send`) using event = envelope.type.
 *     Subscribers register `.on('broadcast', { event: 'message' }, ...)`
 *     so the event field is what routes the payload.
 *   - The supabase-js v2 channel needs `subscribe()` to be ready before
 *     sending. To keep this fail-safe and stateless we create + send +
 *     teardown per publish. Latency is one HTTP round-trip — acceptable
 *     for chat message volume; the DB write is the source of truth either
 *     way. If volume warrants it later, swap to a long-lived per-channel
 *     map; the interface won't change.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  ConversationEventEnvelope,
  PublishResult,
  ServerRealtimePublisher,
} from './types.js';

export class SupabaseRealtimePublisher implements ServerRealtimePublisher {
  readonly vendor = 'supabase' as const;

  constructor(private readonly sb: SupabaseClient) {}

  async publish(channel: string, envelope: ConversationEventEnvelope): Promise<PublishResult> {
    let ch: ReturnType<SupabaseClient['channel']> | null = null;
    try {
      ch = this.sb.channel(channel, {
        config: { broadcast: { self: false, ack: true } },
      });

      // Wait for SUBSCRIBED before sending, with a hard timeout. If the
      // realtime websocket is unreachable, we fail fast (caller treats as
      // soft failure — DB write already succeeded).
      const subscribed = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 4000);
        ch!.subscribe((status) => {
          if (status === 'SUBSCRIBED') {
            clearTimeout(timer);
            resolve(true);
          } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
            clearTimeout(timer);
            resolve(false);
          }
        });
      });

      if (!subscribed) {
        return { ok: false, reason: 'supabase_channel_not_ready' };
      }

      const sendResult = await ch.send({
        type: 'broadcast',
        event: envelope.type,
        payload: envelope.payload,
      });

      // supabase-js returns 'ok' | 'timed out' | 'error'
      if (sendResult !== 'ok') {
        return { ok: false, reason: `supabase_send_${String(sendResult)}` };
      }
      return { ok: true };
    } catch (err: any) {
      return { ok: false, reason: err?.message || 'supabase_publish_error' };
    } finally {
      if (ch) {
        try {
          await this.sb.removeChannel(ch);
        } catch {
          /* noop — best-effort cleanup */
        }
      }
    }
  }
}
