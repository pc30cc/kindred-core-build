import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { Contact } from '@/types/models';
import { contactsApi } from '@/lib/contacts-api';

// Reads/writes below go through server/routes/contacts.ts (gs_session
// cookie + service_role) rather than direct supabase.from() calls — the
// dashboard's browser session no longer carries a Supabase Auth JWT, so
// auth.uid()-scoped RLS on a direct query would silently return/write
// nothing (reads), or — for the old direct update/delete calls, which
// carried no workspace check of their own — accept a bare id with no
// tenant validation at all (writes).

export function useContacts(workspaceId: string | undefined) {
  return useQuery({
    queryKey: ['contacts', workspaceId],
    queryFn: () => contactsApi.list(workspaceId!) as Promise<Contact[]>,
    enabled: !!workspaceId,
  });
}

export function useContact(id: string | undefined) {
  return useQuery({
    queryKey: ['contact', id],
    queryFn: () => contactsApi.get(id!) as Promise<Contact | null>,
    enabled: !!id,
  });
}

export function useContactConversations(contactId: string | undefined) {
  return useQuery({
    queryKey: ['contact-conversations', contactId],
    queryFn: () => contactsApi.getConversations(contactId!),
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
    mutationFn: ({ id, ...updates }: Partial<Contact> & { id: string }) => contactsApi.update(id, updates),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['contacts'] });
      qc.invalidateQueries({ queryKey: ['contact'] });
    },
  });
}

export function useDeleteContact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => contactsApi.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['contacts'] }),
  });
}

export function useBulkDeleteContacts() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[]) => contactsApi.bulkDelete(ids),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['contacts'] }),
  });
}
