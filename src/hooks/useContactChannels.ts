import { useQuery } from '@tanstack/react-query';
import { API_BASE } from '@/lib/api';

/**
 * Contacts are shared between the chat widget and the call center.
 * Channel-origin derivation now lives server-side
 * (server/routes/workspaceIntegrations.ts), replicating the exact logic
 * that used to run here against direct supabase.from() calls.
 */
export type ContactChannelInfo = {
  chat: boolean;
  call: boolean;
  calls: number;
  lastCallAt: string | null;
};

async function integrationsFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    ...options,
    headers: { 'Content-Type': 'application/json', ...options?.headers },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed: ${res.status}`);
  return body as T;
}

/** Channel origin badges for the whole contacts list. */
export function useContactChannels(workspaceId: string | undefined) {
  return useQuery({
    queryKey: ['contact-channels', workspaceId],
    queryFn: async () => {
      const { channels } = await integrationsFetch<{ channels: Record<string, ContactChannelInfo> }>(
        `/api/workspace-integrations/${workspaceId}/contact-channels`,
      );
      return channels;
    },
    enabled: !!workspaceId,
    staleTime: 60_000,
  });
}

export type ContactCall = {
  id: string;
  call_type: string;
  direction: string;
  state: string;
  entry_source: string | null;
  duration_seconds: number | null;
  wait_seconds: number | null;
  created_at: string;
  ended_at: string | null;
  end_reason: string | null;
  agent_name: string | null;
  agent_avatar: string | null;
  recording_state: string | null;
  recording_available: boolean;
  recording_duration: number | null;
  recording_size_bytes: number | null;
  conversation_id: string | null;
};

/** Full call history (with recordings + operator) for one contact. */
export function useContactCalls(workspaceId: string | undefined, contactId: string | undefined) {
  return useQuery({
    queryKey: ['contact-calls', workspaceId, contactId],
    queryFn: async (): Promise<ContactCall[]> => {
      const { calls } = await integrationsFetch<{ calls: ContactCall[] }>(
        `/api/workspace-integrations/${workspaceId}/contacts/${contactId}/calls`,
      );
      return calls;
    },
    enabled: !!workspaceId && !!contactId,
  });
}
