/**
 * Phase 8C — Operator-side call queue API client.
 * All endpoints require workspace membership (server-enforced).
 */
import { supabase } from '@/integrations/supabase/client';

const API_BASE = import.meta.env.VITE_API_BASE_URL || '';

async function authHeader(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export type QueueChannel = 'audio' | 'video';
export type QueueState =
  | 'queued'
  | 'offered'
  | 'accepted'
  | 'cancelled'
  | 'expired'
  | 'missed'
  | 'callback_requested';

export interface CallQueueEntry {
  id: string;
  workspace_id: string;
  channel: QueueChannel;
  state: QueueState;
  visitor_session_id: string | null;
  contact_id: string | null;
  conversation_id: string | null;
  call_session_id: string | null;
  requested_by: string;
  priority: number;
  position_hint: number | null;
  offered_to_user_id: string | null;
  offered_at: string | null;
  accepted_at: string | null;
  ended_at: string | null;
  ended_reason: string | null;
  expires_at: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  // Phase 8D — SLA telemetry
  missed_offer_count?: number;
  last_offer_expires_at?: string | null;
  offer_timeout_seconds?: number;
  sla_breached?: boolean;
  callback_request_id?: string | null;
}

export const callQueueApi = {
  async list(workspaceId: string, channel?: QueueChannel): Promise<{ entries: CallQueueEntry[] }> {
    const url = new URL(`${API_BASE}/api/call-queue/${workspaceId}`, window.location.origin);
    if (channel) url.searchParams.set('channel', channel);
    const res = await fetch(url.toString().replace(window.location.origin, ''), {credentials: 'include', 
      headers: await authHeader(),
    });
    if (!res.ok) throw new Error(`Failed: ${res.status}`);
    return res.json();
  },
  async offer(workspaceId: string, entryId: string): Promise<{ entry: CallQueueEntry }> {
    const res = await fetch(`${API_BASE}/api/call-queue/${workspaceId}/${entryId}/offer`, {credentials: 'include', 
      method: 'POST',
      headers: await authHeader(),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body?.error || `Failed: ${res.status}`);
    }
    return res.json();
  },
  async accept(workspaceId: string, entryId: string, callSessionId?: string): Promise<{ entry: CallQueueEntry }> {
    const res = await fetch(`${API_BASE}/api/call-queue/${workspaceId}/${entryId}/accept`, {credentials: 'include', 
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
      body: JSON.stringify({ call_session_id: callSessionId }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body?.error || `Failed: ${res.status}`);
    }
    return res.json();
  },
  async cancel(workspaceId: string, entryId: string, reason?: string): Promise<{ entry: CallQueueEntry }> {
    const res = await fetch(`${API_BASE}/api/call-queue/${workspaceId}/${entryId}/cancel`, {credentials: 'include', 
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
      body: JSON.stringify({ reason }),
    });
    if (!res.ok) throw new Error(`Failed: ${res.status}`);
    return res.json();
  },
  async myPermissions(workspaceId: string): Promise<{
    can_start_audio_call: boolean;
    can_start_video_call: boolean;
    can_receive_audio_call: boolean;
    can_receive_video_call: boolean;
    can_record_calls: boolean;
    can_transfer_calls: boolean;
    can_join_queue_calls: boolean;
    can_manage_call_queue: boolean;
    role: 'owner' | 'admin' | 'agent' | 'viewer' | null;
  }> {
    const res = await fetch(`${API_BASE}/api/call-queue/${workspaceId}/me/permissions`, {credentials: 'include', 
      headers: await authHeader(),
    });
    if (!res.ok) throw new Error(`Failed: ${res.status}`);
    return res.json();
  },
};