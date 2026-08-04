import { supabase } from '@/lib/supabase';
import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import type { Conversation, ConversationMessage } from '@/types/models';
import { conversationsApi } from '@/lib/conversations-api';
import { dedupeById } from '@/realtime/dedupe';

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
      let q = supabase
        .from('conversations')
        .select('*, contacts(name, email, avatar_url)')
        .eq('workspace_id', workspaceId!)
        .order('updated_at', { ascending: false });
      if (queue === 'automated') {
        q = q
          .eq('ai_state', 'ai_managed')
          .neq('status', 'closed')
          .is('assigned_to', null)
          .eq('is_spam', false);
      } else if (queue === 'spam') {
        q = q.eq('is_spam', true);
      } else {
        // Main Inbox — human-actionable. Exclude spam and AI-managed
        // threads; needs_human + human_active stay visible because the
        // operator should act on them. Include rows where ai_state IS NULL
        // (e.g. classic conversations, or ones restored after platform AI
        // was disabled) — PostgREST .neq() filters NULL out otherwise.
        q = q.eq('is_spam', false);
        if (needsHuman) {
          q = q.eq('ai_state', 'needs_human');
        } else {
          q = q.or('ai_state.is.null,ai_state.neq.ai_managed');
        }
        if (assignedToMe) q = q.eq('assigned_to', assignedToMe);
        // `status` may be a comma-separated group (e.g. 'resolved,closed')
        // so one tab can cover several underlying statuses.
        if (status && status !== 'all') {
          const parts = status.split(',').map((x) => x.trim()).filter(Boolean);
          q = parts.length > 1 ? q.in('status', parts) : q.eq('status', parts[0]);
        }
      }
      const { data, error } = await q;
      if (error) throw error;
      const convos = (data || []) as (Conversation & {
        contacts: { name: string; email: string; avatar_url: string } | null;
        last_visitor_message?: { body: string; created_at: string; seen_at: string | null } | null;
        last_message?: { body: string; created_at: string; sender_type: string } | null;
        unread_count?: number;
        visitor_os?: string | null;
        visitor_device?: string | null;
        visitor_country_code?: string | null;
        visitor_country_name?: string | null;
      })[];

      // Enrich each conversation with the latest visitor (sender_type='contact')
      // message preview so the inbox list can show what the visitor last said
      // instead of just the conversation subject. Single batched query keyed
      // on conversation_id IN (...).
      const ids = convos.map((c) => c.id).filter(Boolean);
      if (ids.length > 0) {
        const { data: msgs } = await supabase
          .from('conversation_messages')
          .select('conversation_id, body, created_at, sender_type, seen_at')
          .in('conversation_id', ids)
          .order('created_at', { ascending: false })
          .limit(1000);
        const byConv: Record<string, { body: string; created_at: string; seen_at: string | null }> = {};
        const lastByConv: Record<string, { body: string; created_at: string; sender_type: string }> = {};
        const unreadByConv: Record<string, number> = {};
        for (const m of (msgs || []) as Array<{
          conversation_id: string; body: string | null; created_at: string; seen_at: string | null; sender_type: string;
        }>) {
          if (!m.conversation_id) continue;
          // Latest message of ANY sender — drives the list preview so the
          // operator sees their own reply / the AI reply, not "no messages".
          if (!lastByConv[m.conversation_id]) {
            lastByConv[m.conversation_id] = {
              body: m.body ?? '',
              created_at: m.created_at,
              sender_type: m.sender_type,
            };
          }
          // Visitor-only stream — drives unread counts and "last visitor said".
          if (m.sender_type !== 'contact') continue;
          if (!byConv[m.conversation_id]) {
            byConv[m.conversation_id] = {
              body: m.body ?? '',
              created_at: m.created_at,
              seen_at: m.seen_at ?? null,
            };
          }
          if (!m.seen_at) {
            unreadByConv[m.conversation_id] = (unreadByConv[m.conversation_id] ?? 0) + 1;
          }
        }
        for (const c of convos) {
          c.last_visitor_message = byConv[c.id] ?? null;
          c.last_message = lastByConv[c.id] ?? null;
          c.unread_count = unreadByConv[c.id] ?? 0;
        }
      }

      // Enrich with the visitor's device/OS so avatars can fall back to an
      // OS-branded glyph when the contact has no profile picture.
      const contactIds = Array.from(
        new Set(convos.map((c) => (c as any).contact_id).filter(Boolean) as string[]),
      );
      if (contactIds.length > 0) {
        const { data: sessions } = await supabase
          .from('visitor_sessions')
          .select('contact_id, os, device, last_seen_at, geo_country_code, geo_country_name, country')
          .in('contact_id', contactIds)
          .order('last_seen_at', { ascending: false })
          .limit(500);
        const osByContact: Record<string, { os: string | null; device: string | null; cc: string | null; cn: string | null }> = {};
        for (const s of (sessions || []) as Array<{
          contact_id: string | null; os: string | null; device: string | null;
          geo_country_code: string | null; geo_country_name: string | null; country: string | null;
        }>) {
          if (!s.contact_id || osByContact[s.contact_id]) continue;
          osByContact[s.contact_id] = {
            os: s.os ?? null,
            device: s.device ?? null,
            cc: s.geo_country_code ?? null,
            cn: s.geo_country_name ?? s.country ?? null,
          };
        }
        for (const c of convos) {
          const info = osByContact[(c as any).contact_id as string];
          c.visitor_os = info?.os ?? null;
          c.visitor_device = info?.device ?? null;
          c.visitor_country_code = info?.cc ?? null;
          c.visitor_country_name = info?.cn ?? null;
        }
      }
      if (queue === 'main') {
        // AI greeting threads (source='ai_agent_intro') that the visitor never
        // answered are not human-actionable — they only clutter Main Inbox and
        // make it look like AI conversations are mixed into the human queue.
        // They stay reachable from the Automated queue / direct link.
        return convos.filter((c) => {
          const meta = (c as any)?.metadata || {};
          const introOnly = meta.source === 'ai_agent_intro' && !c.last_visitor_message;
          const humanTouched = !!(c as any).assigned_to
            || (c as any).ai_state === 'human_active'
            || (c.last_message && c.last_message.sender_type === 'agent');
          return !introOnly || humanTouched;
        });
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
    queryFn: async () => {
      const base = () =>
        supabase
          .from('conversations')
          .select('id', { count: 'exact', head: true })
          .eq('workspace_id', workspaceId!);
      const [mainRes, autoRes, needsRes, spamRes] = await Promise.all([
        base()
          .eq('is_spam', false)
          .neq('status', 'closed')
          .or('ai_state.is.null,ai_state.neq.ai_managed'),
        base()
          .eq('is_spam', false)
          .neq('status', 'closed')
          .eq('ai_state', 'ai_managed')
          .is('assigned_to', null),
        base()
          .eq('is_spam', false)
          .neq('status', 'closed')
          .eq('ai_state', 'needs_human'),
        base().eq('is_spam', true),
      ]);
      return {
        main: mainRes.count ?? 0,
        automated: autoRes.count ?? 0,
        needs_human: needsRes.count ?? 0,
        spam: spamRes.count ?? 0,
      };
    },
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
    queryFn: async () => {
      const base = () =>
        supabase
          .from('conversations')
          .select('id', { count: 'exact', head: true })
          .eq('workspace_id', workspaceId!)
          .eq('is_spam', false)
          .or('ai_state.is.null,ai_state.neq.ai_managed');
      const [openRes, pendingRes, resolvedRes, allRes, needsRes] = await Promise.all([
        base().eq('status', 'open'),
        base().eq('status', 'pending'),
        base().in('status', ['resolved', 'closed']),
        base(),
        base().eq('ai_state', 'needs_human'),
      ]);
      return {
        open: openRes.count ?? 0,
        pending: pendingRes.count ?? 0,
        resolved: resolvedRes.count ?? 0,
        all: allRes.count ?? 0,
        needs_human: needsRes.count ?? 0,
      } as Record<string, number>;
    },
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
      const { data, error } = await supabase
        .from('conversation_messages')
        .select('*')
        .eq('conversation_id', conversationId!)
        .order('created_at', { ascending: true });
      if (error) throw error;
      const messages = (data || []) as ConversationMessage[];

      // Phase 2 — Enrich messages with attachment metadata. The widget's
      // server route already does this for visitor reads; for the inbox we
      // do it client-side via a single batched query keyed on message_id +
      // metadata.attachment_id (covers both operator and visitor uploads).
      const ids = new Set<string>();
      const fromMeta = new Set<string>();
      for (const m of messages) {
        if (m?.id) ids.add(m.id);
        const aid = (m?.metadata as any)?.attachment_id;
        if (typeof aid === 'string') fromMeta.add(aid);
      }
      const attMap: Record<string, MessageAttachment> = {};
      const byMsg: Record<string, MessageAttachment> = {};
      if (ids.size || fromMeta.size) {
        const orFilters: string[] = [];
        if (ids.size) orFilters.push(`message_id.in.(${Array.from(ids).join(',')})`);
        if (fromMeta.size) orFilters.push(`id.in.(${Array.from(fromMeta).join(',')})`);
        const { data: atts } = await supabase
          .from('conversation_attachments')
          .select('id, file_name, mime_type, size_bytes, status, message_id')
          .or(orFilters.join(','));
        for (const a of (atts || []) as Array<{
          id: string; file_name: string; mime_type: string;
          size_bytes: number; status: string; message_id: string | null;
        }>) {
          if (a.status !== 'attached' && a.status !== 'uploaded') continue;
          const meta: MessageAttachment = {
            id: a.id,
            file_name: a.file_name,
            mime_type: a.mime_type,
            size_bytes: a.size_bytes,
            kind: a.mime_type.startsWith('image/') ? 'image' : 'file',
          };
          attMap[a.id] = meta;
          if (a.message_id) byMsg[a.message_id] = meta;
        }
      }

      // Resolve operator/AI sender identity (name + avatar) so the thread can
      // show who replied instead of a generic "Support" label.
      const senderIds = Array.from(new Set(
        messages
          .filter((m) => (m.sender_type === 'agent' || m.sender_type === 'ai') && m.sender_id)
          .map((m) => m.sender_id as string),
      ));
      const senderMap: Record<string, { name: string | null; avatar: string | null }> = {};
      if (senderIds.length) {
        const { data: profiles } = await supabase
          .from('profiles')
          .select('id, full_name, avatar_url')
          .in('id', senderIds);
        for (const p of (profiles || []) as Array<{ id: string; full_name: string | null; avatar_url: string | null }>) {
          senderMap[p.id] = { name: p.full_name || null, avatar: p.avatar_url || null };
        }
      }

      return messages.map<ConversationMessageWithAttachment>((m) => {
        const aid = (m?.metadata as any)?.attachment_id;
        const att =
          (typeof aid === 'string' && attMap[aid]) ||
          (m.id && byMsg[m.id]) ||
          null;
        const prof = m.sender_id ? senderMap[m.sender_id] : null;
        return {
          ...m,
          ...(att ? { attachment: att } : {}),
          sender_name: prof?.name ?? null,
          sender_avatar: prof?.avatar ?? null,
        };
      });
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
    }: { body: string; senderId?: string; attachmentId?: string | null }) => {
      if (!conversationId || !workspaceId) throw new Error('Missing conversation or workspace');
      const result = await conversationsApi.sendMessage({
        workspace_id: workspaceId,
        conversation_id: conversationId,
        body,
        attachment_id: attachmentId ?? null,
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
    mutationFn: async (workspaceId: string) => {
      // Fetch conversation ids for this workspace
      const { data: convs, error: fetchErr } = await supabase
        .from('conversations')
        .select('id')
        .eq('workspace_id', workspaceId);
      if (fetchErr) throw fetchErr;
      const ids = (convs ?? []).map((c) => c.id);
      if (ids.length === 0) return { deleted: 0 };

      // Delete messages first (no FK cascade guaranteed)
      const { error: msgErr } = await supabase
        .from('conversation_messages')
        .delete()
        .in('conversation_id', ids);
      if (msgErr) throw msgErr;

      const { error: convErr } = await supabase
        .from('conversations')
        .delete()
        .in('id', ids);
      if (convErr) throw convErr;

      return { deleted: ids.length };
    },
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
    mutationFn: async (conversationId: string) => {
      const { data, error } = await (supabase.rpc as any)('mark_conversation_seen', {
        _conversation_id: conversationId,
      });
      if (error) throw error;
      return (data as number) ?? 0;
    },
    onSuccess: (_count, conversationId) => {
      qc.invalidateQueries({ queryKey: ['messages', conversationId] });
    },
    onError: (err) => {
      console.warn('[seen] mark_conversation_seen failed', err);
    },
  });
}
