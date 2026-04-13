import { supabase } from '@/lib/supabase';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { Conversation, ConversationMessage } from '@/types/models';

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
      return data as ConversationMessage[];
    },
    enabled: !!conversationId,
  });
}

export function useSendMessage(conversationId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ body, senderId }: { body: string; senderId: string }) => {
      const { data, error } = await supabase
        .from('conversation_messages')
        .insert({
          conversation_id: conversationId!,
          sender_type: 'agent',
          sender_id: senderId,
          body,
        })
        .select()
        .single();
      if (error) throw error;

      // Update conversation timestamp
      await supabase
        .from('conversations')
        .update({ updated_at: new Date().toISOString() })
        .eq('id', conversationId!);

      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['messages', conversationId] }),
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
