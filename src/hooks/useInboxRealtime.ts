/**
 * Inbox realtime subscription — provider-abstracted (Inbox-only).
 *
 * The hook delegates transport selection to
 * `resolveClientRealtimeProvider(workspaceId)` which returns one of:
 *   - CentrifugoClientProvider    (negotiated via /api/realtime/operator-connect)
 *   - SupabaseRealtimeClientProvider
 *   - PollingClientProvider       (graceful no-op; React Query polling drives the UI)
 *
 * Stable contracts honored exactly as they exist in production:
 *   - channel:  ws:<workspace_id>:conv:<conversation_id>
 *   - envelope: { type: 'message' | 'typing' | 'seen', payload: { ... } }
 *
 * On `message` events we just invalidate React Query keys — no aggressive
 * local cache patching yet (that's a later phase).
 */

import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { resolveClientRealtimeProvider } from '@/realtime';
import type {
  NormalizedMessagePayload,
  RealtimeSubscription,
} from '@/realtime';

export interface InboxRealtimeOptions {
  workspaceId: string | undefined;
  conversationId: string | undefined;
  /** Called with the normalized message payload (envelope.payload). */
  onMessage?: (payload: NormalizedMessagePayload) => void;
  onTyping?: (payload: Record<string, unknown>) => void;
  enabled?: boolean;
}

export function useInboxRealtime(opts: InboxRealtimeOptions) {
  const { workspaceId, conversationId, onMessage, onTyping, enabled = true } = opts;
  const queryClient = useQueryClient();

  // Latest handlers in a ref so the subscription effect stays stable.
  const handlersRef = useRef({ onMessage, onTyping });
  handlersRef.current = { onMessage, onTyping };

  useEffect(() => {
    if (!enabled || !workspaceId || !conversationId) return;

    let cancelled = false;
    let sub: RealtimeSubscription | null = null;
    const channel = `ws:${workspaceId}:conv:${conversationId}`;

    (async () => {
      try {
        const provider = await resolveClientRealtimeProvider(workspaceId);
        if (cancelled) return;

        const subscription = await provider.subscribe(channel, {
          onMessage: (payload) => {
            // Default behavior: invalidate the message list so React Query
            // refetches and the Inbox renders the new row. Conservative —
            // no optimistic patching here.
            queryClient.invalidateQueries({ queryKey: ['messages', conversationId] });
            queryClient.invalidateQueries({ queryKey: ['conversations', workspaceId] });
            handlersRef.current.onMessage?.(payload);
          },
          onTyping: (payload) => {
            handlersRef.current.onTyping?.(payload);
          },
          onSeen: () => {
            queryClient.invalidateQueries({ queryKey: ['messages', conversationId] });
          },
          onStatus: (status, info) => {
            if (status === 'error') {
              // Polling already covers the UI; don't spam the user.
              console.warn('[inbox-rt] status=error', info?.reason);
            }
          },
        });
        if (cancelled) {
          subscription.unsubscribe();
          return;
        }
        sub = subscription;
      } catch (err) {
        // Resolver itself never throws; this catches subscribe-time errors
        // from a primary transport. Polling fallback is implicit.
        console.warn('[inbox-rt] subscribe failed, polling continues', err);
      }
    })();

    return () => {
      cancelled = true;
      if (sub) {
        try {
          sub.unsubscribe();
        } catch {
          /* noop */
        }
        sub = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, conversationId, enabled]);
}
