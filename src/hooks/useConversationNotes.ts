/**
 * Phase 4b — Operator-only notes for a conversation.
 *
 * All reads/writes go through the authenticated backend route
 * (/api/conversations/:id/notes). The widget never touches this table.
 *
 * Cache key: ['conversation-notes', conversationId, workspaceId]
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

const API_BASE = import.meta.env.VITE_API_BASE_URL || '';

export interface ConversationNote {
  id: string;
  conversation_id: string;
  workspace_id: string;
  author_id: string;
  body: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  author?: {
    id: string;
    full_name: string | null;
    email: string | null;
    avatar_url: string | null;
  } | null;
}

async function authHeaders(): Promise<Record<string, string>> {
  const { data: { session } } = await supabase.auth.getSession();
  return session?.access_token
    ? { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' }
    : { 'Content-Type': 'application/json' };
}

export function useConversationNotes(
  conversationId: string | undefined,
  workspaceId: string | undefined,
) {
  return useQuery({
    queryKey: ['conversation-notes', conversationId, workspaceId],
    queryFn: async (): Promise<ConversationNote[]> => {
      const headers = await authHeaders();
      const url = `${API_BASE}/api/conversations/${encodeURIComponent(conversationId!)}/notes`
        + `?workspace_id=${encodeURIComponent(workspaceId!)}`;
      const res = await fetch(url, {credentials: 'include', headers });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `Notes load failed: ${res.status}`);
      return (json.notes ?? []) as ConversationNote[];
    },
    enabled: !!conversationId && !!workspaceId,
    staleTime: 15_000,
  });
}

export function useCreateNote(
  conversationId: string | undefined,
  workspaceId: string | undefined,
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: string) => {
      if (!conversationId || !workspaceId) throw new Error('Missing conversation or workspace');
      const res = await fetch(`${API_BASE}/api/conversations/${encodeURIComponent(conversationId)}/notes`, {credentials: 'include', 
        method: 'POST',
        headers: await authHeaders(),
        body: JSON.stringify({ workspace_id: workspaceId, body }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `Create failed: ${res.status}`);
      return json.note as ConversationNote;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['conversation-notes', conversationId, workspaceId] });
      qc.invalidateQueries({ queryKey: ['conversation-timeline', conversationId, workspaceId] });
    },
  });
}

export function useUpdateNote(
  conversationId: string | undefined,
  workspaceId: string | undefined,
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ noteId, body }: { noteId: string; body: string }) => {
      if (!conversationId || !workspaceId) throw new Error('Missing conversation or workspace');
      const res = await fetch(
        `${API_BASE}/api/conversations/${encodeURIComponent(conversationId)}/notes/${encodeURIComponent(noteId)}`,
        {credentials: 'include', 
          method: 'PATCH',
          headers: await authHeaders(),
          body: JSON.stringify({ workspace_id: workspaceId, body }),
        },
      );
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `Update failed: ${res.status}`);
      return json.note as ConversationNote;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['conversation-notes', conversationId, workspaceId] });
    },
  });
}

export function useDeleteNote(
  conversationId: string | undefined,
  workspaceId: string | undefined,
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (noteId: string) => {
      if (!conversationId || !workspaceId) throw new Error('Missing conversation or workspace');
      const url = `${API_BASE}/api/conversations/${encodeURIComponent(conversationId)}/notes/${encodeURIComponent(noteId)}`
        + `?workspace_id=${encodeURIComponent(workspaceId)}`;
      const res = await fetch(url, {credentials: 'include', method: 'DELETE', headers: await authHeaders() });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error || `Delete failed: ${res.status}`);
      }
      return noteId;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['conversation-notes', conversationId, workspaceId] });
      qc.invalidateQueries({ queryKey: ['conversation-timeline', conversationId, workspaceId] });
    },
  });
}
