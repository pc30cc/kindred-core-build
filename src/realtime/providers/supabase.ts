/**
 * Supabase Realtime adapter.
 *
 * Subscribes to a Supabase broadcast channel using the SAME channel name
 * the rest of the system uses (`ws:<workspace_id>:conv:<conversation_id>`)
 * and the SAME envelope shape the backend publishes
 * (`{ type: 'message' | 'typing' | 'seen', payload }`).
 *
 * IMPORTANT: For this adapter to actually deliver events end-to-end, the
 * server-side publish path (`server/services/realtime/publish.ts`) must
 * also broadcast on Supabase Realtime when the active vendor is supabase.
 * Today the publisher only handles Centrifugo. Until that companion
 * change ships, selecting Supabase as the realtime vendor will cause this
 * adapter to subscribe successfully but receive no events — the Inbox
 * will still update via React Query polling, so behavior degrades
 * gracefully rather than failing visibly.
 */

import { supabase } from '@/lib/supabase';
import type {
  ClientRealtimeProvider,
  NormalizedMessagePayload,
  RealtimeHandlers,
  RealtimeSubscription,
} from '../types';

export class SupabaseRealtimeClientProvider implements ClientRealtimeProvider {
  readonly vendor = 'supabase' as const;

  async subscribe(channel: string, handlers: RealtimeHandlers): Promise<RealtimeSubscription> {
    handlers.onStatus?.('connecting');

    const ch = supabase.channel(channel, {
      config: { broadcast: { self: false, ack: false } },
    });

    ch.on('broadcast', { event: 'message' }, (msg: any) => {
      const payload = msg?.payload?.payload ?? msg?.payload;
      if (payload && typeof payload === 'object') {
        handlers.onMessage?.(payload as NormalizedMessagePayload);
      }
    });
    ch.on('broadcast', { event: 'typing' }, (msg: any) => {
      handlers.onTyping?.(msg?.payload?.payload ?? msg?.payload ?? {});
    });
    ch.on('broadcast', { event: 'seen' }, (msg: any) => {
      handlers.onSeen?.(msg?.payload?.payload ?? msg?.payload ?? {});
    });

    await new Promise<void>((resolve) => {
      ch.subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          handlers.onStatus?.('open');
          resolve();
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          handlers.onStatus?.(status === 'CLOSED' ? 'closed' : 'error', { reason: status });
          resolve(); // Don't block — caller already considers polling fallback elsewhere.
        }
      });
    });

    return {
      unsubscribe: () => {
        try {
          supabase.removeChannel(ch);
        } catch {
          /* noop */
        }
        handlers.onStatus?.('closed');
      },
    };
  }
}
