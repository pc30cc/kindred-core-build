/**
 * Phase 5 — Workspace inbox-list realtime subscription.
 *
 * Subscribes to the operator-only channel `ws:<workspace_id>:inbox` and
 * patches the cached conversation list when conversation_updated /
 * _resolved / _reopened events arrive. Falls back to invalidation if the
 * payload doesn't match the expected shape.
 *
 * Polling fallback: when the resolved provider is `polling`/`disabled`,
 * subscribe is a no-op. `['conversations', workspace_id]` has no refetch
 * interval, so the list then refreshes only on mount, tab switch and the
 * operator's own actions.
 */

import { useEffect } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { resolveClientRealtimeProvider } from '@/realtime';
import type {
  RealtimeSubscription,
  OperatorEventPayload,
} from '@/realtime/types';
import { rtDebug, rtWarn } from '@/realtime/debug';
import { invalidateThrottled } from '@/realtime/invalidationThrottle';
import { isFirstSighting, refreshConversations } from '@/hooks/inboxListCache';

interface ConversationCacheRow {
  id: string;
  status?: string;
  priority?: string;
  assigned_to?: string | null;
  tags?: string[];
  updated_at?: string;
  [k: string]: unknown;
}

/** The `changes` diff a conversation_updated event carries. */
interface ConversationChanges {
  status?: { to?: string };
  priority?: { to?: string };
  assigned_to?: { to?: string | null };
  tags?: { added?: string[]; removed?: string[] };
}

function patchConversationInCache(
  rows: ConversationCacheRow[] | undefined,
  payload: OperatorEventPayload,
): { patched: ConversationCacheRow[] | undefined; matched: boolean } {
  if (!Array.isArray(rows)) return { patched: rows, matched: false };
  const idx = rows.findIndex((r) => r.id === payload.conversation_id);
  if (idx < 0) return { patched: rows, matched: false };

  const changes = payload.changes as ConversationChanges | undefined;
  if (!changes || typeof changes !== 'object') {
    return { patched: rows, matched: false }; // schema mismatch → caller invalidates
  }

  const next = { ...rows[idx] };
  let touched = false;
  if (changes.status?.to !== undefined)      { next.status = changes.status.to; touched = true; }
  if (changes.priority?.to !== undefined)    { next.priority = changes.priority.to; touched = true; }
  if (changes.assigned_to?.to !== undefined) { next.assigned_to = changes.assigned_to.to; touched = true; }
  if (changes.tags && (Array.isArray(changes.tags.added) || Array.isArray(changes.tags.removed))) {
    const set = new Set<string>(Array.isArray(next.tags) ? next.tags : []);
    for (const t of changes.tags.removed ?? []) set.delete(t);
    for (const t of changes.tags.added ?? []) set.add(t);
    next.tags = [...set];
    touched = true;
  }
  if (payload.updated_at) {
    next.updated_at = String(payload.updated_at);
  }
  if (!touched) return { patched: rows, matched: false };

  const patched = rows.slice();
  patched[idx] = next;
  return { patched, matched: true };
}

/** Every cached list that holds the conversation already shows it human-active. */
function isAlreadyHumanActive(qc: QueryClient, workspaceId: string, conversationId: string): boolean {
  let seen = false;
  for (const [, rows] of qc.getQueriesData<ConversationCacheRow[]>({ queryKey: ['conversations', workspaceId] })) {
    const row = Array.isArray(rows) ? rows.find((r) => r.id === conversationId) : undefined;
    if (!row) continue;
    if (row.ai_state !== 'human_active') return false;
    seen = true;
  }
  return seen;
}

export function useInboxListRealtime(workspaceId: string | undefined) {
  const qc = useQueryClient();

  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    let sub: RealtimeSubscription | null = null;
    let wasDown = false;
    const channel = `ws:${workspaceId}:inbox`;

    (async () => {
      try {
        const provider = await resolveClientRealtimeProvider(workspaceId);
        if (cancelled) return;
        // Polling/disabled adapters: subscribe is a safe no-op; React Query
        // refetch on `['conversations', workspaceId]` continues to drive the UI.
        rtDebug('inbox-list', 'subscribing', { vendor: provider.vendor, channel });

        const subscription = await provider.subscribe(channel, {
          onMessage: (payload) => {
            // Phase 5b — a message arrived on some conversation in this
            // workspace. Only that conversation is re-read (inboxListCache):
            // the server decides whether it belongs in each visible list and
            // recomputes its preview / unread / needs-reply. A message on a
            // thread the lists already hold cannot change the queue or tab
            // counters (those follow status and AI state, which arrive as
            // their own events). A conversation seen for the first time, and
            // held by no list, may be new: only then are they refreshed.
            const convId = (payload as { conversation_id?: string })?.conversation_id;
            const senderType = (payload as { sender_type?: string })?.sender_type;
            rtDebug('inbox-list', 'event:message', { conv: convId, sender_type: senderType });
            if (convId) {
              const isNew = isFirstSighting(qc, workspaceId, convId);
              refreshConversations(qc, workspaceId, [convId]);
              if (isNew) {
                invalidateThrottled(qc, ['inbox-counts', workspaceId]);
                invalidateThrottled(qc, ['inbox-tab-counts', workspaceId]);
              }
            } else {
              invalidateThrottled(qc, ['conversations', workspaceId]);
              invalidateThrottled(qc, ['inbox-counts', workspaceId]);
            }
            // Surface to subscribers (e.g. notification chime).
            try {
              window.dispatchEvent(new CustomEvent('inbox:new-message', {
                detail: { workspaceId, conversation_id: convId, sender_type: senderType, payload },
              }));
            } catch { /* noop */ }
          },
          onEvent: (payload) => {
            if (!payload || typeof payload !== 'object') return;
            if (payload.workspace_id && payload.workspace_id !== workspaceId) return;

            const kind = (payload as { kind?: string }).kind as string;
            if (
              kind !== 'conversation_updated' &&
              kind !== 'conversation_resolved' &&
              kind !== 'conversation_reopened' &&
              kind !== 'ai_human_takeover' &&
              kind !== 'ai_handoff_requested' &&
              kind !== 'ai_managed' &&
              kind !== 'spam_changed'
            ) {
              return; // Other kinds are handled by per-conversation subscription.
            }

            rtDebug('inbox-list', 'event', { kind, conv: payload.conversation_id });

            // AI lifecycle and spam_changed events shift conversations
            // between queues (Main / Automated / Needs human / Spam). The
            // lightweight patch path can't represent that, so always
            // invalidate every cached list for this workspace.
            // The server announces a takeover only when the thread was not
            // human-active yet (older servers did on every operator reply).
            // When the cached lists already show it human-active, nothing a
            // list or counter shows changes (the reply's own message push
            // re-reads the row), so there is nothing to refresh.
            if (kind === 'ai_human_takeover' && isAlreadyHumanActive(qc, workspaceId, payload.conversation_id)) {
              return;
            }
            if (
              kind === 'ai_human_takeover' ||
              kind === 'ai_handoff_requested' ||
              kind === 'ai_managed' ||
              kind === 'spam_changed'
            ) {
              refreshConversations(qc, workspaceId, [payload.conversation_id]);
              invalidateThrottled(qc, ['inbox-counts', workspaceId]);
              invalidateThrottled(qc, ['inbox-tab-counts', workspaceId]);
              return;
            }

            // A permanently failed outbound delivery changes DERIVED state
            // (needs_reply) that the client cannot recompute from the patch
            // payload, so the list must be re-fetched rather than patched.
            // Rare (a permanent delivery failure), so not throttled.
            if ((payload as { reason?: string }).reason === 'outbound_delivery_failed') {
              refreshConversations(qc, workspaceId, [payload.conversation_id]);
              invalidateThrottled(qc, ['inbox-counts', workspaceId]);
              return;
            }

            // Patch every cached `['conversations', workspaceId, …]` query.
            // Filter chips share workspaceId but vary by status, so we
            // iterate. Fallback to invalidation if patch can't apply.
            let allMatched = true;
            const queries = qc.getQueriesData<ConversationCacheRow[]>({
              queryKey: ['conversations', workspaceId],
            });
            for (const [key, data] of queries) {
              const { patched, matched } = patchConversationInCache(data, payload);
              if (matched && patched) qc.setQueryData(key, patched);
              else allMatched = false;
            }
            // A list the patch could not update (the row is not in it, or the
            // event moved it between tabs) re-reads just this conversation.
            if (!allMatched) {
              refreshConversations(qc, workspaceId, [payload.conversation_id]);
            }
            invalidateThrottled(qc, ['inbox-counts', workspaceId]);
            invalidateThrottled(qc, ['inbox-tab-counts', workspaceId]);
          },
          onStatus: (status, info) => {
            if (status === 'error') rtWarn('inbox-list', 'status=error', { reason: info?.reason });
            // Pushes sent while the socket was down are lost: after a
            // reconnect, read the lists and counters in full once.
            if (status === 'closed' || status === 'error') {
              wasDown = true;
            } else if (status === 'open' && wasDown) {
              wasDown = false;
              void qc.invalidateQueries({ queryKey: ['conversations', workspaceId] });
              void qc.invalidateQueries({ queryKey: ['inbox-counts', workspaceId] });
              void qc.invalidateQueries({ queryKey: ['inbox-tab-counts', workspaceId] });
            }
          },
        });
        if (cancelled) { subscription.unsubscribe(); return; }
        sub = subscription;
      } catch (err) {
        rtWarn('inbox-list', 'subscribe failed, polling continues', { error: (err as Error | undefined)?.message });
      }
    })();

    return () => {
      cancelled = true;
      if (sub) { try { sub.unsubscribe(); } catch { /* noop */ } sub = null; }
    };
  }, [workspaceId, qc]);
}
