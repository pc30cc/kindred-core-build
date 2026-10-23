/**
 * Phase 5 — Workspace inbox-list realtime subscription.
 *
 * Subscribes to the operator-only channel `ws:<workspace_id>:inbox` and
 * patches the cached conversation list when conversation_updated /
 * _resolved / _reopened events arrive. Falls back to invalidation if the
 * payload doesn't match the expected shape. The Inbox's unread number (the
 * badge on Inbox, useInboxUnread) is re-read from the same pushes: a
 * visitor's message, a status, assignee, AI or spam change, a reconnect; a
 * `conversation_seen` drops the chat from it at once.
 *
 * Polling fallback: when the resolved provider is `polling`/`disabled`,
 * subscribe is a no-op. `['conversations', workspace_id]` has no refetch
 * interval, so the list then refreshes only on mount, tab switch and the
 * operator's own actions.
 *
 * On the web it is mounted ONCE, by the app shell (useOperatorInboxAlerts),
 * so the sidebar's counters, the chime and the banners work on every page,
 * not only while the Inbox is open; mounting it twice would ring every alert
 * twice. The phone app's shell has no such alerts and mounts its own
 * (MobileInboxPage).
 */

import { useEffect, useRef } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { resolveClientRealtimeProvider } from '@/realtime';
import type {
  RealtimeSubscription,
  OperatorEventPayload,
} from '@/realtime/types';
import { rtDebug, rtWarn } from '@/realtime/debug';
import { invalidateThrottled } from '@/realtime/invalidationThrottle';
import { isFirstSighting, refreshConversations } from '@/hooks/inboxListCache';
import { dropInboxUnread } from '@/hooks/useConversations';
import { laterReadMarker } from '@/lib/inboxSeen';

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

/**
 * The visitor read a conversation (`visitor_read`, I-03): its rows in a
 * cached list carry the newer `visitor_last_read_at`, so the open thread's
 * "Seen" moves at once. Nothing else a list or counter shows changes, so
 * nothing is re-read. Unchanged (the same array) when no row moved.
 */
export function patchVisitorReadInCache<T extends ConversationCacheRow>(
  rows: T[] | undefined,
  conversationId: string,
  readAt: string,
): T[] | undefined {
  if (!Array.isArray(rows)) return rows;
  const idx = rows.findIndex((r) => r.id === conversationId);
  if (idx < 0) return rows;
  const current = rows[idx].visitor_last_read_at as string | null | undefined;
  const next = laterReadMarker(current, readAt);
  if (!next || next === current) return rows;
  const patched = rows.slice();
  patched[idx] = { ...rows[idx], visitor_last_read_at: next };
  return patched;
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

/** The unread number's refresh window: every Inbox member's tab re-reads it. */
const UNREAD_REFRESH_WINDOW_MS = 3000;

/**
 * Whether a visitor message in `conversationId` can change this operator's
 * unread number, from what the panel already holds: not when that chat is
 * already counted, or when a cached row shows it out of their scope (the AI
 * handles it, or a colleague has it). Unknown chats may count, so they do.
 */
export function unreadMayChange(
  qc: QueryClient,
  workspaceId: string,
  conversationId: string,
  viewerId: string | null | undefined,
): boolean {
  const counted = qc.getQueryData<{ ids?: string[] }>(['inbox-unread', workspaceId]);
  if (Array.isArray(counted?.ids) && counted.ids.includes(conversationId)) return false;
  for (const [, rows] of qc.getQueriesData<ConversationCacheRow[]>({ queryKey: ['conversations', workspaceId] })) {
    const row = Array.isArray(rows) ? rows.find((r) => r?.id === conversationId) : undefined;
    if (!row) continue;
    if (row.ai_state === 'ai_managed') return false;
    if (viewerId && row.assigned_to && row.assigned_to !== viewerId) return false;
    return true;
  }
  return true;
}

export function useInboxListRealtime(workspaceId: string | undefined, viewerId?: string | null) {
  const qc = useQueryClient();
  const viewerRef = useRef(viewerId);
  viewerRef.current = viewerId;

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
            // The Inbox's unread number counts conversations with an unread
            // visitor message: a visitor message can add one, also on a thread
            // the lists already hold, so it re-reads it (throttled) unless the
            // chat cannot change it (unreadMayChange). Team and system
            // messages never do.
            if (senderType === 'contact' && (!convId || unreadMayChange(qc, workspaceId, convId, viewerRef.current))) {
              invalidateThrottled(qc, ['inbox-unread', workspaceId], UNREAD_REFRESH_WINDOW_MS);
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
            // Surface every operator event too: the "assigned to you" alert
            // (operatorAssignmentAlert.ts) and the assignee it remembers.
            try {
              window.dispatchEvent(new CustomEvent('inbox:conversation-event', {
                detail: { workspaceId, payload },
              }));
            } catch { /* noop */ }

            const kind = (payload as { kind?: string }).kind as string;
            // Someone read the conversation (POST /:id/seen): it leaves the
            // unread number and its row's count at once; the number is then
            // read again. Nothing a list shows besides changes.
            if (kind === 'conversation_seen') {
              if (payload.conversation_id) dropInboxUnread(qc, payload.conversation_id);
              invalidateThrottled(qc, ['inbox-unread', workspaceId]);
              return;
            }
            if (kind === 'visitor_read') {
              const readAt = (payload as { visitor_last_read_at?: unknown }).visitor_last_read_at;
              if (typeof readAt !== 'string' || !payload.conversation_id) return;
              for (const [key, data] of qc.getQueriesData<ConversationCacheRow[]>({ queryKey: ['conversations', workspaceId] })) {
                const patched = patchVisitorReadInCache(data, payload.conversation_id, readAt);
                if (patched !== data) qc.setQueryData(key, patched);
              }
              return;
            }
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
              invalidateThrottled(qc, ['inbox-unread', workspaceId]);
              return;
            }

            // A permanently failed outbound delivery changes DERIVED state
            // (needs_reply) that the client cannot recompute from the patch
            // payload, so the list must be re-fetched rather than patched.
            // Rare (a permanent delivery failure), so not throttled.
            if ((payload as { reason?: string }).reason === 'outbound_delivery_failed') {
              refreshConversations(qc, workspaceId, [payload.conversation_id]);
              invalidateThrottled(qc, ['inbox-counts', workspaceId]);
              invalidateThrottled(qc, ['inbox-unread', workspaceId]);
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
            // Its status or assignee may have moved it in or out of the
            // operator's unread number.
            invalidateThrottled(qc, ['inbox-unread', workspaceId]);
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
              void qc.invalidateQueries({ queryKey: ['inbox-unread', workspaceId] });
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
