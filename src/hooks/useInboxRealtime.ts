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
import type { OperatorEventPayload } from '@/realtime/types';
import { rtDebug, rtWarn } from '@/realtime/debug';

export interface InboxRealtimeOptions {
  workspaceId: string | undefined;
  conversationId: string | undefined;
  /** Called with the normalized message payload (envelope.payload). */
  onMessage?: (payload: NormalizedMessagePayload) => void;
  onTyping?: (payload: Record<string, unknown>) => void;
  /**
   * Phase 5 — operator-only events on the per-conversation channel.
   * Polling/disabled adapters are no-ops; React Query refetch keeps
   * the UI fresh in that case.
   */
  onEvent?: (payload: OperatorEventPayload) => void;
  enabled?: boolean;
}

export function useInboxRealtime(opts: InboxRealtimeOptions) {
  const { workspaceId, conversationId, onMessage, onTyping, onEvent, enabled = true } = opts;
  const queryClient = useQueryClient();

  // Latest handlers in a ref so the subscription effect stays stable.
  const handlersRef = useRef({ onMessage, onTyping, onEvent });
  handlersRef.current = { onMessage, onTyping, onEvent };

  useEffect(() => {
    if (!enabled || !workspaceId || !conversationId) return;

    let cancelled = false;
    let sub: RealtimeSubscription | null = null;
    const channel = `ws:${workspaceId}:conv:${conversationId}`;

    (async () => {
      try {
        const provider = await resolveClientRealtimeProvider(workspaceId);
        if (cancelled) return;
        rtDebug('inbox', 'subscribing', { vendor: provider.vendor, channel });

        const subscription = await provider.subscribe(channel, {
          onMessage: (payload) => {
            rtDebug('inbox', 'event:message', {
              vendor: provider.vendor,
              channel,
              id: (payload as any)?.id,
              sender_type: (payload as any)?.sender_type,
            });
            // Default behavior: invalidate the message list so React Query
            // refetches and the Inbox renders the new row. Conservative —
            // no optimistic patching here.
            queryClient.invalidateQueries({ queryKey: ['messages', conversationId] });
            queryClient.invalidateQueries({ queryKey: ['conversations', workspaceId] });
            handlersRef.current.onMessage?.(payload);
          },
          onTyping: (payload) => {
            rtDebug('inbox', 'event:typing', { vendor: provider.vendor, channel });
            handlersRef.current.onTyping?.(payload);
          },
          onSeen: () => {
            rtDebug('inbox', 'event:seen', { vendor: provider.vendor, channel });
            queryClient.invalidateQueries({ queryKey: ['messages', conversationId] });
          },
          // Phase 5 — operator-only `event` envelopes on the conv channel.
          // Note: notes routes publish ONLY note_added/_deleted (no
          // duplicate timeline_event echo), so we invalidate the notes
          // cache for those kinds and the timeline cache for everything
          // else operator-side. The widget runtime never sees these
          // because Supabase broadcast is event-name-scoped and the
          // Centrifugo widget runtime explicitly drops type !== message|typing.
          onEvent: (payload) => {
            const kind = (payload as { kind?: string })?.kind;
            rtDebug('inbox', 'event:event', { vendor: provider.vendor, channel, kind });
            if (kind === 'note_added' || kind === 'note_deleted') {
              queryClient.invalidateQueries({
                queryKey: ['conversation-notes', conversationId, workspaceId],
              });
              queryClient.invalidateQueries({
                queryKey: ['conversation-timeline', conversationId, workspaceId],
              });
            } else if (
              kind === 'conversation_updated' ||
              kind === 'conversation_resolved' ||
              kind === 'conversation_reopened' ||
              kind === 'timeline_event'
            ) {
              queryClient.invalidateQueries({
                queryKey: ['conversation-timeline', conversationId, workspaceId],
              });
              // Assignment transfers append an internal system message to the
              // thread — refresh the message list so it shows without reload.
              queryClient.invalidateQueries({ queryKey: ['messages', conversationId] });

            } else if (
              kind === 'ai_suggestion_created' ||
              kind === 'ai_suggestion_updated'
            ) {
              // Phase 2 — operator AI suggestion card refresh
              queryClient.invalidateQueries({
                queryKey: ['ai-agent', 'conv-suggestions', conversationId],
              });
            }
            handlersRef.current.onEvent?.(payload);
          },
          onStatus: (status, info) => {
            if (status === 'error') {
              rtWarn('inbox', 'status=error', { vendor: provider.vendor, reason: info?.reason });
            } else {
              rtDebug('inbox', `status=${status}`, { vendor: provider.vendor });
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
        rtWarn('inbox', 'subscribe failed, polling continues', { error: (err as any)?.message });
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
