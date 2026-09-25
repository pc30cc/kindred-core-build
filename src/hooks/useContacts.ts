import { useEffect } from 'react';
import { resolveClientRealtimeProvider } from '@/realtime';
import type { RealtimeSubscription } from '@/realtime/types';
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

/** Signed commerce profile changes refresh both list and open contact views. */
function useContactUpdates(workspaceId: string | undefined) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    let subscription: RealtimeSubscription | undefined;
    void (async () => {
      const provider = await resolveClientRealtimeProvider(workspaceId);
      if (cancelled) return;
      const sub = await provider.subscribe(`ws:${workspaceId}:inbox`, {
        onEvent: payload => {
          if (payload?.kind !== 'contact_updated' || payload.workspace_id !== workspaceId) return;
          void qc.invalidateQueries({ queryKey: ['contacts', workspaceId] });
          void qc.invalidateQueries({ queryKey: ['contact', payload.contact_id] });
          void qc.invalidateQueries({ queryKey: ['contact-conversations', payload.contact_id] });
          void qc.invalidateQueries({ queryKey: ['conversations', workspaceId] });
        },
      });
      if (cancelled) sub.unsubscribe();
      else subscription = sub;
    })().catch(() => { /* polling below remains available */ });
    return () => { cancelled = true; subscription?.unsubscribe(); };
  }, [workspaceId, qc]);
}

export function useContacts(workspaceId: string | undefined) {
  useContactUpdates(workspaceId);
  return useQuery({
    queryKey: ['contacts', workspaceId],
    queryFn: () => contactsApi.list(workspaceId!) as Promise<Contact[]>,
    enabled: !!workspaceId,
    refetchInterval: 10_000,
  });
}

export function useContact(id: string | undefined) {
  const query = useQuery({
    queryKey: ['contact', id],
    queryFn: () => contactsApi.get(id!) as Promise<Contact | null>,
    enabled: !!id,
    refetchInterval: 10_000,
  });
  useContactUpdates(query.data?.workspace_id);
  return query;
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
        email: contact.email ?? null,
        name: contact.name ?? null,
        phone: contact.phone ?? null,
        // No avatar field: a contact avatar is only ever stored by an
        // ingest path, which writes its canonical storage key.
        tags: contact.tags ?? [],
        notes: contact.notes ?? null,
        metadata: contact.metadata ?? {},
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
          email: c.email ?? null,
          name: c.name ?? null,
          phone: c.phone ?? null,
          tags: c.tags ?? [],
          notes: c.notes ?? null,
          metadata: c.metadata ?? {},
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
