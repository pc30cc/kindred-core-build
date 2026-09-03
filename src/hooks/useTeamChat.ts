/**
 * Team chat — operator-to-operator direct messages inside a workspace.
 * All I/O goes through the self-hosted Express API (/api/team-chat).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { API_BASE as RESOLVED_API_BASE } from '@/lib/apiBase';

const API_BASE = RESOLVED_API_BASE || '';

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    ...init,
    headers: { 'Content-Type': 'application/json', ...((init?.headers as any) || {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as any)?.error || `Request failed: ${res.status}`);
  return body as T;
}

export interface TeamAttachment {
  id: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  kind: 'image' | 'audio' | 'video' | 'file';
}

export interface Colleague {
  user_id: string;
  role: string;
  full_name: string | null;
  email: string | null;
  avatar_url: string | null;
  unread: number;
  last_message: {
    body: string;
    created_at: string;
    outgoing: boolean;
    attachment_kind?: 'image' | 'audio' | 'video' | 'file' | null;
  } | null;
}

export interface TeamMessage {
  id: string;
  sender_id: string;
  recipient_id: string;
  body: string;
  attachment_id?: string | null;
  attachment?: TeamAttachment | null;
  read_at: string | null;
  created_at: string;
}

export function useColleagues(workspaceId: string | undefined) {
  return useQuery({
    queryKey: ['team-chat', 'colleagues', workspaceId],
    queryFn: () =>
      api<{ colleagues: Colleague[]; total_unread: number; me: string }>(
        `/api/team-chat/colleagues?workspace_id=${encodeURIComponent(workspaceId!)}`,
      ),
    enabled: !!workspaceId,
    staleTime: 10_000,
    refetchInterval: 20_000,
  });
}

export function useTeamThread(workspaceId: string | undefined, peerId: string | null) {
  return useQuery({
    queryKey: ['team-chat', 'thread', workspaceId, peerId],
    queryFn: () =>
      api<{ messages: TeamMessage[]; me: string }>(
        `/api/team-chat/thread?workspace_id=${encodeURIComponent(workspaceId!)}&peer_id=${encodeURIComponent(peerId!)}`,
      ),
    enabled: !!workspaceId && !!peerId,
    staleTime: 5_000,
    refetchInterval: 10_000,
    placeholderData: (prev) => prev,
  });
}

export function useSendTeamMessage(workspaceId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { recipient_id: string; body: string; attachment_id?: string | null }) =>
      api<{ message: TeamMessage }>('/api/team-chat/messages', {
        method: 'POST',
        body: JSON.stringify({ workspace_id: workspaceId, ...vars }),
      }),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ['team-chat', 'thread', workspaceId, vars.recipient_id] });
      qc.invalidateQueries({ queryKey: ['team-chat', 'colleagues', workspaceId] });
    },
  });
}

export function useMarkTeamThreadRead(workspaceId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (peerId: string) =>
      api<{ ok: true }>('/api/team-chat/read', {
        method: 'POST',
        body: JSON.stringify({ workspace_id: workspaceId, peer_id: peerId }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['team-chat', 'colleagues', workspaceId] });
    },
  });
}
