/**
 * Supabase Realtime publisher.
 *
 * Broadcasts the envelope on Supabase Broadcast using the SAME payload shape
 * the Centrifugo path uses, so the client adapter
 * (src/realtime/providers/supabase.ts) and the widget runtime consume it
 * without translation.
 *
 * SECURITY — topics, not channel names:
 *   Supabase Broadcast channels here are public (joined with the anon key,
 *   no Supabase Auth / RLS), so the topic name is the access boundary. The
 *   canonical channel names (`ws:<workspace_id>:conv:<conversation_id>`,
 *   `ws:<workspace_id>:inbox`, …) are guessable, so this publisher NEVER
 *   broadcasts on them. Every canonical channel is mapped to unguessable
 *   HMAC-derived topics (`channelTopic.ts`): the operator copy, plus the
 *   visitor copy for conversation channels. Clients learn those topics only
 *   from the authenticated /api/realtime/* endpoints. If no topic secret is
 *   available the publish fails closed (polling keeps the UI correct).
 *
 * Implementation notes:
 *   - We use the service-role Supabase client.
 *   - We send via `channel.send` using event = envelope.type. Subscribers
 *     register `.on('broadcast', { event: 'message' }, ...)`, so the event
 *     field is what routes the payload.
 *   - The supabase-js v2 channel needs `subscribe()` to be ready before
 *     sending. To keep this fail-safe and stateless we create + send +
 *     teardown per publish. Latency is one HTTP round-trip per topic
 *     (topics are sent in parallel) — acceptable for chat message volume;
 *     the DB write is the source of truth either way.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  ConversationEventEnvelope,
  PublishResult,
  ServerRealtimePublisher,
} from './types.js';
import { supabaseTopicsForPublish } from '../channelTopic.js';

function errorReason(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

export class SupabaseRealtimePublisher implements ServerRealtimePublisher {
  readonly vendor = 'supabase' as const;

  constructor(private readonly sb: SupabaseClient) {}

  async publish(channel: string, envelope: ConversationEventEnvelope): Promise<PublishResult> {
    let topics: string[];
    try {
      topics = supabaseTopicsForPublish(channel);
    } catch (err) {
      // Fail closed: never fall back to the guessable canonical name.
      return { ok: false, reason: errorReason(err, 'supabase_topic_unavailable') };
    }
    const results = await Promise.all(topics.map((topic) => this.publishToTopic(topic, envelope)));
    const failed = results.find((r) => !r.ok);
    return failed ?? { ok: true };
  }

  private async publishToTopic(topic: string, envelope: ConversationEventEnvelope): Promise<PublishResult> {
    let ch: ReturnType<SupabaseClient['channel']> | null = null;
    try {
      const channelHandle = this.sb.channel(topic, {
        config: { broadcast: { self: false, ack: true } },
      });
      ch = channelHandle;

      // Wait for SUBSCRIBED before sending, with a hard timeout. If the
      // realtime websocket is unreachable, we fail fast (caller treats as
      // soft failure — DB write already succeeded).
      const subscribed = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 4000);
        channelHandle.subscribe((status) => {
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

      const sendResult = await channelHandle.send({
        type: 'broadcast',
        event: envelope.type,
        payload: envelope.payload,
      });

      // supabase-js returns 'ok' | 'timed out' | 'error'
      if (sendResult !== 'ok') {
        return { ok: false, reason: `supabase_send_${String(sendResult)}` };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: errorReason(err, 'supabase_publish_error') };
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
