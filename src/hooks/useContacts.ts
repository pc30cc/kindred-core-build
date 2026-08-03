import { supabase } from '@/lib/supabase';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { Contact } from '@/types/models';
import { contactsApi } from '@/lib/contacts-api';

export function useContacts(workspaceId: string | undefined) {
  return useQuery({
    queryKey: ['contacts', workspaceId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('contacts')
        .select('*')
        .eq('workspace_id', workspaceId!)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data as Contact[];
    },
    enabled: !!workspaceId,
  });
}

export function useContact(id: string | undefined) {
  return useQuery({
    queryKey: ['contact', id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('contacts')
        .select('*')
        .eq('id', id!)
        .maybeSingle();
      if (error) throw error;
      return data as Contact | null;
    },
    enabled: !!id,
  });
}

export function useContactConversations(contactId: string | undefined) {
  return useQuery({
    queryKey: ['contact-conversations', contactId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('conversations')
        .select('*')
        .eq('contact_id', contactId!)
        .order('updated_at', { ascending: false });
      if (error) throw error;
      const convs = (data ?? []) as any[];
      if (!convs.length) return convs;

      const ids = convs.map((c) => c.id);

      // Who handled each conversation: AI replies vs. human operator replies.
      const { data: msgs } = await supabase
        .from('conversation_messages')
        .select('conversation_id, sender_type, sender_id, created_at')
        .in('conversation_id', ids)
        .order('created_at', { ascending: true });

      const operatorIds = new Set<string>();
      for (const c of convs) if (c.assigned_to) operatorIds.add(c.assigned_to);
      for (const m of (msgs ?? []) as any[]) {
        if (m.sender_type === 'agent' && m.sender_id) operatorIds.add(m.sender_id);
      }

      let profiles: Record<string, { full_name: string | null; email: string; avatar_url: string | null }> = {};
      if (operatorIds.size) {
        const { data: profs } = await supabase
          .from('profiles')
          .select('id, full_name, email, avatar_url')
          .in('id', Array.from(operatorIds));
        for (const p of (profs ?? []) as any[]) {
          profiles[p.id] = { full_name: p.full_name, email: p.email, avatar_url: p.avatar_url };
        }
      }

      return convs.map((c) => {
        const mine = ((msgs ?? []) as any[]).filter((m) => m.conversation_id === c.id);
        const hasAi = mine.some((m) => m.sender_type === 'ai' || m.sender_type === 'bot');
        const agentMsgs = mine.filter((m) => m.sender_type === 'agent' && m.sender_id);
        const lastAgentId = agentMsgs.length ? agentMsgs[agentMsgs.length - 1].sender_id : null;
        const operatorId = lastAgentId || c.assigned_to || null;
        const operator = operatorId ? profiles[operatorId] ?? null : null;
        const lastMessage = mine.length ? mine[mine.length - 1] : null;
        return {
          ...c,
          handled_by_ai: hasAi,
          handled_by_operator: !!operator,
          operator_name: operator ? operator.full_name || operator.email : null,
          operator_avatar: operator?.avatar_url ?? null,
          last_message_body: lastMessage?.body ?? null,
          message_count: mine.length,
        };
      });
    },
    enabled: !!contactId,
  });
}

export function useCreateContact(workspaceId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (contact: Partial<Contact>) => {
      // Canonical TS-first chokepoint: POST /api/contacts on the
      // self-hosted server enforces max_contacts via requireLimit.
      return await contactsApi.create({
        workspace_id: workspaceId!,
        email: (contact as any).email ?? null,
        name: (contact as any).name ?? null,
        phone: (contact as any).phone ?? null,
        avatar_url: (contact as any).avatar_url ?? null,
        tags: (contact as any).tags ?? [],
        notes: (contact as any).notes ?? null,
        metadata: (contact as any).metadata ?? {},
      });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['contacts', workspaceId] }),
  });
}

export function useBulkCreateContacts(workspaceId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (contacts: Partial<Contact>[]) => {
      if (!contacts.length) return { inserted: 0 };
      // Canonical TS-first chokepoint: POST /api/contacts/bulk
      // enforces max_contacts as all-or-nothing per batch.
      const result = await contactsApi.bulkCreate(
        workspaceId!,
        contacts.map((c) => ({
          email: (c as any).email ?? null,
          name: (c as any).name ?? null,
          phone: (c as any).phone ?? null,
          avatar_url: (c as any).avatar_url ?? null,
          tags: (c as any).tags ?? [],
          notes: (c as any).notes ?? null,
          metadata: (c as any).metadata ?? {},
        })),
      );
      return { inserted: result.inserted };
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['contacts', workspaceId] }),
  });
}

export function useUpdateContact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...updates }: Partial<Contact> & { id: string }) => {
      const { data, error } = await supabase
        .from('contacts')
        .update({ ...updates, updated_at: new Date().toISOString() } as any)
        .eq('id', id)
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['contacts'] });
      qc.invalidateQueries({ queryKey: ['contact'] });
    },
  });
}

export function useDeleteContact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('contacts').delete().eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['contacts'] }),
  });
}

export function useBulkDeleteContacts() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (ids: string[]) => {
      if (!ids.length) return { deleted: 0 };
      const { error } = await supabase.from('contacts').delete().in('id', ids);
      if (error) throw error;
      return { deleted: ids.length };
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['contacts'] }),
  });
}
