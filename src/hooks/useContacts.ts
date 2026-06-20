import { supabase } from '@/lib/supabase';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { Contact } from '@/types/models';

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
      return data;
    },
    enabled: !!contactId,
  });
}

export function useCreateContact(workspaceId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (contact: Partial<Contact>) => {
      // Routes through SECURITY DEFINER RPC (canonical create boundary).
      const { data, error } = await supabase.rpc('create_contact', {
        _workspace_id: workspaceId!,
        _email: (contact as any).email ?? null,
        _name: (contact as any).name ?? null,
        _phone: (contact as any).phone ?? null,
        _avatar_url: (contact as any).avatar_url ?? null,
        _tags: (contact as any).tags ?? [],
        _notes: (contact as any).notes ?? null,
        _metadata: (contact as any).metadata ?? {},
      } as any);
      if (error) throw error;
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['contacts', workspaceId] }),
  });
}

export function useBulkCreateContacts(workspaceId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (contacts: Partial<Contact>[]) => {
      if (!contacts.length) return { inserted: 0 };
      // Routes through SECURITY DEFINER RPC (canonical import boundary).
      const { data, error } = await supabase.rpc('bulk_create_contacts', {
        _workspace_id: workspaceId!,
        _contacts: contacts as any,
      } as any);
      if (error) throw error;
      const row = Array.isArray(data) ? (data[0] as any) : (data as any);
      return { inserted: Number(row?.inserted ?? 0) };
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
