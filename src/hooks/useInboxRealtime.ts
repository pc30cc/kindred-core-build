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
 * The thread's operator-only `event` envelopes (notes, status, tags,
 * assignee, timeline, AI suggestions, calls) come from the workspace inbox
 * channel `ws:<workspace_id>:inbox`, filtered to this conversation: the
 * server never publishes them on the conversation channel, which the
 * visitor's widget subscribes to (server/services/realtime/publish.ts,
 * WIDGET_EVENT_FIELDS). The few `event` kinds the widget acts on also reach
 * the conversation channel, cut down to the visitor's fields; they are taken
 * whole from the inbox channel, so the conversation channel's `event`
 * envelopes are ignored here.
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
import { invalidateThrottled } from '@/realtime/invalidationThrottle';
import { refreshConversations } from '@/hooks/inboxListCache';

/**
 * The open thread's message list is small and latency-visible, so its burst
 * window is shorter than the lists' default: an isolated message still shows
 * at once, a burst lands within half a second.
 */
const MESSAGES_WINDOW_MS = 500;

export interface InboxRealtimeOptions {
  workspaceId: string | undefined;
  conversationId: string | undefined;
  /** Called with the normalized message payload (envelope.payload). */
  onMessage?: (payload: NormalizedMessagePayload) => void;
  onTyping?: (payload: Record<string, unknown>) => void;
  /**
   * Phase 5 — operator-only events of this conversation (heard on the
   * workspace inbox channel). Polling/disabled adapters are no-ops; React
   * Query refetch keeps the UI fresh in that case.
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
    const subs: RealtimeSubscription[] = [];
    const channel = `ws:${workspaceId}:conv:${conversationId}`;
    const inboxChannel = `ws:${workspaceId}:inbox`;

    // Phase 5 — this conversation's operator-only events. Notes routes
    // publish ONLY note_added/_deleted (no duplicate timeline_event echo), so
    // we invalidate the notes cache for those kinds and the timeline cache
    // for everything else operator-side.
    const onOperatorEvent = (payload: OperatorEventPayload, vendor: string) => {
      const kind = (payload as { kind?: string })?.kind;
      rtDebug('inbox', 'event:event', { vendor, channel: inboxChannel, kind });
      if (kind === 'note_added' || kind === 'note_deleted') {
        invalidateThrottled(queryClient, ['conversation-notes', conversationId, workspaceId]);
        invalidateThrottled(queryClient, ['conversation-timeline', conversationId, workspaceId]);
      } else if (
        kind === 'conversation_updated' ||
        kind === 'conversation_resolved' ||
        kind === 'conversation_reopened' ||
        kind === 'timeline_event'
      ) {
        invalidateThrottled(queryClient, ['conversation-timeline', conversationId, workspaceId]);
        // Assignment transfers append an internal system message to the
        // thread — refresh the message list so it shows without reload.
        invalidateThrottled(queryClient, ['messages', conversationId], MESSAGES_WINDOW_MS);

      } else if (
        kind === 'ai_suggestion_created' ||
        kind === 'ai_suggestion_updated'
      ) {
        // Phase 2 — operator AI suggestion card refresh
        invalidateThrottled(queryClient, ['ai-agent', 'conv-suggestions', conversationId]);
      }
      handlersRef.current.onEvent?.(payload);
    };

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
              id: payload?.id,
              sender_type: payload?.sender_type,
            });
            // Default behavior: invalidate the message list so React Query
            // refetches and the Inbox renders the new row. Conservative —
            // no optimistic patching here.
            invalidateThrottled(queryClient, ['messages', conversationId], MESSAGES_WINDOW_MS);
            // The list re-reads just this conversation; coalesced with the
            // same message arriving on the workspace inbox channel.
            refreshConversations(queryClient, workspaceId, [conversationId]);
            handlersRef.current.onMessage?.(payload);
          },
          onTyping: (payload) => {
            rtDebug('inbox', 'event:typing', { vendor: provider.vendor, channel });
            handlersRef.current.onTyping?.(payload);
          },
          onSeen: () => {
            rtDebug('inbox', 'event:seen', { vendor: provider.vendor, channel });
            invalidateThrottled(queryClient, ['messages', conversationId], MESSAGES_WINDOW_MS);
          },
          // No onEvent: an `event` here is the visitor's copy of one the
          // inbox channel below delivers whole.
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
        subs.push(subscription);

        const inbox = await provider.subscribe(inboxChannel, {
          onEvent: (payload) => {
            if (!payload || typeof payload !== 'object') return;
            if (payload.conversation_id !== conversationId) return;
            if (payload.workspace_id && payload.workspace_id !== workspaceId) return;
            onOperatorEvent(payload, provider.vendor);
          },
        });
        if (cancelled) {
          inbox.unsubscribe();
          return;
        }
        subs.push(inbox);
      } catch (err) {
        // Resolver itself never throws; this catches subscribe-time errors
        // from a primary transport. Polling fallback is implicit.
        rtWarn('inbox', 'subscribe failed, polling continues', { error: (err as Error | undefined)?.message });
      }
    })();

    return () => {
      cancelled = true;
      for (const sub of subs.splice(0)) {
        try {
          sub.unsubscribe();
        } catch {
          /* noop */
        }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, conversationId, enabled]);
}
