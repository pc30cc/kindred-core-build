import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import type { Conversation, ConversationMessage } from '@/types/models';
import { conversationsApi } from '@/lib/conversations-api';
import { dedupeById } from '@/realtime/dedupe';
import {
  fetchVisitorNetworkForConversations,
  type VisitorNetworkProfile,
} from '@/hooks/useVisitorNetwork';

/**
 * Inbox queue selector.
 *   - undefined/'main'   → status-based default inbox (existing behavior)
 *   - 'automated'        → ai_state='ai_managed' AND status != 'closed' AND
 *                          assigned_to IS NULL (AI-managed queue)
 *   - 'spam'             → is_spam=true (operator-flagged conversations)
 *
 * Routing rules:
 *   • Spam is excluded from EVERY non-spam queue.
 *   • Main Inbox excludes ai_state='ai_managed' (those live in Automated)
 *     but INCLUDES needs_human + human_active because those are
 *     human-actionable threads. `needs_human` is NOT a separate queue —
 *     it is exposed as a Main Inbox filter chip / badge / count.
 *
 * Queue mode bypasses the `status` argument so the AI / Spam queues are not
 * accidentally narrowed by the operator's open/pending/resolved chip.
 */
export type InboxQueue = 'main' | 'automated' | 'spam';

export interface InboxExtraFilter {
  /** Restrict Main Inbox to ai_state='needs_human'. */
  needsHuman?: boolean;
  /** Restrict Main Inbox to conversations assigned to this user id. */
  assignedToMe?: string | null;
}

export function useConversations(
  workspaceId: string | undefined,
  status?: string,
  queue: InboxQueue = 'main',
  extra: InboxExtraFilter = {},
) {
  const needsHuman = !!extra.needsHuman;
  const assignedToMe = extra.assignedToMe || null;
  return useQuery({
    queryKey: ['conversations', workspaceId, queue, status, needsHuman, assignedToMe],
    // Tab switching must feel instant: keep showing the previous tab's rows
    // while the new one loads instead of flashing the skeleton, and treat
    // recently fetched data as fresh so going back to a tab is free.
    placeholderData: keepPreviousData,
    staleTime: 15_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      // List + queue filtering + message enrichment (last message, last
      // visitor message, unread count) + the "unanswered AI-intro thread"
      // exclusion are all computed server-side now — see GET
      // /api/conversations in server/routes/conversations.ts. Direct
      // supabase.from('conversations') relied on RLS scoped to auth.uid(),
      // which is NULL without a Supabase Auth session.
      const { conversations } = await conversationsApi.list({
        workspace_id: workspaceId!,
        queue,
        status,
        needsHuman,
        assignedToMe,
      });
      const convos = conversations as (Conversation & {
        contacts: {
          name: string | null;
          email: string | null;
          avatar_url: string | null;
          visitor_code: string | null;
          metadata: Record<string, unknown> | null;
        } | null;
        last_visitor_message?: { body: string; created_at: string; seen_at: string | null } | null;
        last_message?: { body: string; created_at: string; sender_type: string } | null;
        unread_count?: number;
        visitor_os?: string | null;
        visitor_device?: string | null;
        visitor_country_code?: string | null;
        visitor_country_name?: string | null;
        visitor_network?: VisitorNetworkProfile | null;
      })[];

      // Enrich with the visitor's network profile (geo + IP + device).
      //
      // This goes through the canonical server resolver
      // (services/visitors/networkProfile.ts) in ONE batched request — the
      // browser no longer reads `visitor_sessions` directly, so the IP
      // privacy / entitlement decision is never made client-side, and Inbox
      // can't disagree with Visitors or the Call Center.
      //
      // The server keys each conversation off its OWN `visitor_session_id`
      // (the contact's newest session is only a legacy fallback), so a
      // returning visitor no longer makes older threads show the newest
      // visit's country.
      const ids = convos.map((c) => c.id).filter(Boolean);
      try {
        const netByConv = await fetchVisitorNetworkForConversations(workspaceId!, ids);
        for (const c of convos) {
          const p = netByConv[c.id] ?? null;
          c.visitor_network = p;
          c.visitor_os = p?.device.os ?? null;
          c.visitor_device = p?.device.device ?? null;
          c.visitor_country_code = p?.geo.country_code ?? null;
          c.visitor_country_name = p?.geo.country ?? null;
        }
      } catch {
        // Enrichment is decorative for the list — never block the inbox.
      }

      return convos;
    },
    enabled: !!workspaceId,
  });
}

/**
 * Sidebar inbox counters — single hook, four small head-only queries.
 *
 * Counts are scoped to the workspace and align with the queue model:
 *   - main:        is_spam=false AND (ai_state IS NULL OR ai_state != 'ai_managed')
 *                  AND status != 'closed'
 *   - automated:   is_spam=false AND ai_state='ai_managed' AND status != 'closed'
 *   - needs_human: is_spam=false AND ai_state='needs_human' AND status != 'closed'
 *   - spam:        is_spam=true
 */
export function useInboxCounts(workspaceId: string | undefined) {
  return useQuery({
    queryKey: ['inbox-counts', workspaceId],
    enabled: !!workspaceId,
    staleTime: 15_000,
    queryFn: () => conversationsApi.getInboxCounts(workspaceId!),
  });
}

/**
 * Per-tab counters for the Main Inbox status tabs.
 *
 * All tabs get their number up-front (no more "count appears only after you
 * click the tab"). Implemented as parallel HEAD count queries — the server
 * does the counting, no conversation rows travel over the wire.
 *
 * Scope matches `useConversations(queue='main')`: spam excluded, AI-managed
 * threads excluded.
 */
export function useInboxTabCounts(workspaceId: string | undefined) {
  return useQuery({
    queryKey: ['inbox-tab-counts', workspaceId],
    enabled: !!workspaceId,
    staleTime: 15_000,
    gcTime: 5 * 60_000,
    placeholderData: keepPreviousData,
    refetchOnWindowFocus: false,
    queryFn: () => conversationsApi.getInboxTabCounts(workspaceId!),
  });
}

/**
 * Public-safe attachment shape mirrored from the server's
 * `enrichMessagesWithAttachments`. Provider URLs never reach the client —
 * the Inbox loads files via the same backend proxy as the widget:
 *   GET /api/widget/attachments/:id  (re-checks ownership)
 */
export interface MessageAttachment {
  id: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  kind: 'image' | 'file';
}
export type ConversationMessageWithAttachment = ConversationMessage & {
  attachment?: MessageAttachment | null;
  sender_name?: string | null;
  sender_avatar?: string | null;
};

export function useConversationMessages(conversationId: string | undefined) {
  return useQuery({
    queryKey: ['messages', conversationId],
    queryFn: async () => {
      // Attachment + sender enrichment now happens server-side — see GET
      // /api/conversations/:id/messages in server/routes/conversations.ts.
      const { messages } = await conversationsApi.getMessages(conversationId!);
      return messages as ConversationMessageWithAttachment[];
    },
    select: (rows) => dedupeById(rows as (ConversationMessageWithAttachment & { id: string })[]),
    enabled: !!conversationId,
  });
}

/**
 * Send an agent reply through the backend.
 *
 * Routes through POST /api/conversations/send-message which:
 *   1. Inserts into conversation_messages.
 *   2. Updates conversations.updated_at.
 *   3. Optionally binds an operator-uploaded attachment_id to the message.
 *   4. Publishes a `message` event so the visitor widget receives it live.
 *
 * If realtime is not configured, the publish is a no-op and the
 * widget falls back to polling (already wired in runtime.js).
 */
export function useSendMessage(
  conversationId: string | undefined,
  workspaceId: string | undefined,
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      body,
      attachmentId,
      postSendAction,
    }: { body: string; senderId?: string; attachmentId?: string | null; postSendAction?: 'none' | 'wait_for_customer' | 'resolve' }) => {
      if (!conversationId || !workspaceId) throw new Error('Missing conversation or workspace');
      const result = await conversationsApi.sendMessage({
        workspace_id: workspaceId,
        conversation_id: conversationId,
        body,
        attachment_id: attachmentId ?? null,
        post_send_action: postSendAction ?? 'none',
        metadata: { source: 'inbox' },
      });
      return result;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['messages', conversationId] });
      qc.invalidateQueries({ queryKey: ['conversations'] });
    },
  });
}

export function useDeleteAllConversations() {
  const qc = useQueryClient();
  return useMutation({
    // Owner/admin only — see server/routes/conversations.ts DELETE /.
    mutationFn: (workspaceId: string) => conversationsApi.deleteAll(workspaceId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['conversations'] });
      qc.invalidateQueries({ queryKey: ['messages'] });
    },
  });
}

/**
 * Phase 3 — Edit conversation fields via the authenticated backend route.
 *
 * Replaces the previous direct supabase.from('conversations').update(...)
 * path so:
 *   1. All edits flow through a workspace-membership-checked route.
 *   2. The server records normalized conversation_events + audit_logs.
 *   3. Tags get server-side normalization (trim/lowercase/dedupe).
 *
 * Optimistic update strategy:
 *   • We patch the cached row immediately for both ['conversations', wsId, *]
 *     list queries so the UI reflects the new value instantly.
 *   • On error we roll back to the snapshot.
 *   • On settle we invalidate to force a re-read so the cache is always
 *     reconciled with the authoritative server state (handles tag
 *     normalization, server-side rejections, and concurrent edits).
 */
export function useUpdateConversation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: {
      id: string;
      workspace_id: string;
      status?: 'open' | 'pending' | 'resolved' | 'closed';
      priority?: 'low' | 'normal' | 'high' | 'urgent';
      assigned_to?: string | null;
      tags?: string[];
    }) => {
      const result = await conversationsApi.patchConversation({
        workspace_id: vars.workspace_id,
        conversation_id: vars.id,
        status: vars.status,
        priority: vars.priority,
        assigned_to: vars.assigned_to,
        tags: vars.tags,
      });
      return result.conversation;
    },
    onMutate: async (vars) => {
      // Snapshot every cached conversation list for this workspace.
      await qc.cancelQueries({ queryKey: ['conversations', vars.workspace_id] });
      const previous = qc.getQueriesData<any[]>({ queryKey: ['conversations', vars.workspace_id] });
      for (const [key, data] of previous) {
        if (!Array.isArray(data)) continue;
        qc.setQueryData(
          key,
          data.map((c) =>
            c?.id === vars.id
              ? {
                  ...c,
                  ...(vars.status !== undefined ? { status: vars.status } : {}),
                  ...(vars.priority !== undefined ? { priority: vars.priority } : {}),
                  ...(vars.assigned_to !== undefined ? { assigned_to: vars.assigned_to } : {}),
                  ...(vars.tags !== undefined ? { tags: vars.tags } : {}),
                  updated_at: new Date().toISOString(),
                }
              : c,
          ),
        );
      }
      return { previous };
    },
    onError: (_err, _vars, ctx) => {
      // Roll back optimistic patch.
      if (ctx?.previous) {
        for (const [key, data] of ctx.previous) qc.setQueryData(key, data);
      }
    },
    onSettled: (_data, _err, vars) => {
      // Always reconcile against the authoritative server state.
      qc.invalidateQueries({ queryKey: ['conversations', vars.workspace_id] });
      qc.invalidateQueries({ queryKey: ['conversation-events', vars.id] });
    },
  });
}

/**
 * Phase 7 — Operator-side "seen" trigger.
 *
 * Calls the `mark_conversation_seen` Postgres function, which:
 *   - verifies the caller is a member of the conversation's workspace
 *   - sets `seen_at = now()` on every visitor message in that conversation
 *     where `seen_at IS NULL` (monotonic — never moves backwards)
 *
 * The widget reads `seen_at` back via /poll, /history, /identity/history
 * and renders a "Seen" indicator on the visitor's own messages.
 *
 * Fire-and-forget: failure to mark seen must never break the inbox UI.
 */
export function useMarkConversationSeen() {
  const qc = useQueryClient();
  return useMutation({
    // Server route (POST /:id/seen) reimplements the previous
    // mark_conversation_seen RPC's logic directly — that RPC checked
    // is_workspace_member(workspace_id, auth.uid()) internally, which
    // silently no-ops without a Supabase Auth session.
    mutationFn: async (conversationId: string) => {
      const { count } = await conversationsApi.markSeen(conversationId);
      return count;
    },
    onSuccess: (_count, conversationId) => {
      qc.invalidateQueries({ queryKey: ['messages', conversationId] });
    },
    onError: (err) => {
      console.warn('[seen] mark_conversation_seen failed', err);
    },
  });
}
