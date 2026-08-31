/**
 * Phase 5 — Workspace inbox-list realtime subscription.
 *
 * Subscribes to the operator-only channel `ws:<workspace_id>:inbox` and
 * patches the cached conversation list when conversation_updated /
 * _resolved / _reopened events arrive. Falls back to invalidation if the
 * payload doesn't match the expected shape.
 *
 * Polling fallback: when the resolved provider is `polling`/`disabled`,
 * subscribe is a no-op and the existing 10s React Query refetch on
 * `['conversations', workspace_id]` keeps the UI fresh — same behavior
 * as before this hook existed.
 */

import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { resolveClientRealtimeProvider } from '@/realtime';
import type {
  RealtimeSubscription,
  OperatorEventPayload,
} from '@/realtime/types';
import { rtDebug, rtWarn } from '@/realtime/debug';

interface ConversationCacheRow {
  id: string;
  status?: string;
  priority?: string;
  assigned_to?: string | null;
  tags?: string[];
  updated_at?: string;
  [k: string]: unknown;
}

function patchConversationInCache(
  rows: ConversationCacheRow[] | undefined,
  payload: OperatorEventPayload,
): { patched: ConversationCacheRow[] | undefined; matched: boolean } {
  if (!Array.isArray(rows)) return { patched: rows, matched: false };
  const idx = rows.findIndex((r) => r.id === payload.conversation_id);
  if (idx < 0) return { patched: rows, matched: false };

  const changes = (payload as any).changes as Record<string, any> | undefined;
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
  if ((payload as any).updated_at) {
    next.updated_at = String((payload as any).updated_at);
  }
  if (!touched) return { patched: rows, matched: false };

  const patched = rows.slice();
  patched[idx] = next;
  return { patched, matched: true };
}

export function useInboxListRealtime(workspaceId: string | undefined) {
  const qc = useQueryClient();

  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    let sub: RealtimeSubscription | null = null;
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
            // Phase 5b — visitor (or AI/agent) message arrived on some
            // conversation in this workspace. We don't know which list
            // filter it belongs to without re-reading the row, so just
            // invalidate every cached `['conversations', workspaceId, …]`
            // query. Cheap because the list endpoint is already paged and
            // React Query dedupes concurrent refetches.
            const convId = (payload as { conversation_id?: string })?.conversation_id;
            const senderType = (payload as { sender_type?: string })?.sender_type;
            rtDebug('inbox-list', 'event:message', { conv: convId, sender_type: senderType });
            qc.invalidateQueries({ queryKey: ['conversations', workspaceId] });
            qc.invalidateQueries({ queryKey: ['inbox-counts', workspaceId] });
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
            if (
              kind === 'ai_human_takeover' ||
              kind === 'ai_handoff_requested' ||
              kind === 'ai_managed' ||
              kind === 'spam_changed'
            ) {
              qc.invalidateQueries({ queryKey: ['conversations', workspaceId] });
              qc.invalidateQueries({ queryKey: ['conversation', payload.conversation_id] });
              qc.invalidateQueries({ queryKey: ['inbox-counts', workspaceId] });
              return;
            }

            // A permanently failed outbound delivery changes DERIVED state
            // (needs_reply) that the client cannot recompute from the patch
            // payload, so the list must be re-fetched rather than patched.
            if ((payload as { reason?: string }).reason === 'outbound_delivery_failed') {
              qc.invalidateQueries({ queryKey: ['conversations', workspaceId] });
              qc.invalidateQueries({ queryKey: ['conversation', payload.conversation_id] });
              qc.invalidateQueries({ queryKey: ['inbox-counts', workspaceId] });
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
            if (!allMatched) {
              qc.invalidateQueries({ queryKey: ['conversations', workspaceId] });
            }
            // Always refresh the per-conversation cache key if present.
            qc.invalidateQueries({ queryKey: ['conversation', payload.conversation_id] });
            qc.invalidateQueries({ queryKey: ['inbox-counts', workspaceId] });
          },
          onStatus: (status, info) => {
            if (status === 'error') rtWarn('inbox-list', 'status=error', { reason: info?.reason });
          },
        });
        if (cancelled) { subscription.unsubscribe(); return; }
        sub = subscription;
      } catch (err) {
        rtWarn('inbox-list', 'subscribe failed, polling continues', { error: (err as any)?.message });
      }
    })();

    return () => {
      cancelled = true;
      if (sub) { try { sub.unsubscribe(); } catch { /* noop */ } sub = null; }
    };
  }, [workspaceId, qc]);
}
