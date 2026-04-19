import { supabase } from '@/lib/supabase';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { Conversation, ConversationMessage } from '@/types/models';
import { conversationsApi } from '@/lib/conversations-api';
import { dedupeById } from '@/realtime/dedupe';

export function useConversations(workspaceId: string | undefined, status?: string) {
  return useQuery({
    queryKey: ['conversations', workspaceId, status],
    queryFn: async () => {
      let q = supabase
        .from('conversations')
        .select('*, contacts(name, email, avatar_url)')
        .eq('workspace_id', workspaceId!)
        .order('updated_at', { ascending: false });
      if (status && status !== 'all') q = q.eq('status', status);
      const { data, error } = await q;
      if (error) throw error;
      return data as (Conversation & { contacts: { name: string; email: string; avatar_url: string } | null })[];
    },
    enabled: !!workspaceId,
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

      return messages.map<ConversationMessageWithAttachment>((m) => {
        const aid = (m?.metadata as any)?.attachment_id;
        const att =
          (typeof aid === 'string' && attMap[aid]) ||
          (m.id && byMsg[m.id]) ||
          null;
        return att ? { ...m, attachment: att } : m;
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

export function useUpdateConversation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...updates }: Partial<Conversation> & { id: string }) => {
      const { data, error } = await supabase
        .from('conversations')
        .update({ ...updates, updated_at: new Date().toISOString() })
        .eq('id', id)
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['conversations'] }),
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
