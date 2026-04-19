/**
 * Polling adapter — graceful no-op transport.
 *
 * When realtime is disabled, the negotiation endpoint is unreachable, or
 * the chosen primary transport fails to connect, the resolver returns
 * this adapter. It satisfies the `ClientRealtimeProvider` contract with
 * no-op subscriptions; the existing React Query polling already drives
 * the Inbox UI, so callers don't need to do anything special.
 */

import type {
  ClientRealtimeProvider,
  RealtimeHandlers,
  RealtimeSubscription,
} from '../types';

export class PollingClientProvider implements ClientRealtimeProvider {
  readonly vendor = 'polling' as const;

  async subscribe(_channel: string, handlers: RealtimeHandlers): Promise<RealtimeSubscription> {
    // Surface an advisory "open" status so UI can render a polling badge if it wants.
    handlers.onStatus?.('open', { reason: 'polling_fallback' });
    return {
      unsubscribe: () => {
        handlers.onStatus?.('closed', { reason: 'polling_fallback' });
      },
    };
  }
}
