/**
 * Phase 8D — Operator call availability API client.
 * All endpoints require workspace membership.
 */
import { supabase } from '@/integrations/supabase/client';

const API_BASE = import.meta.env.VITE_API_BASE_URL || '';

export type AvailabilityStatus =
  | 'unavailable'
  | 'available_audio'
  | 'available_video'
  | 'available_both'
  | 'busy';

export interface AvailabilityRow {
  user_id: string;
  workspace_id: string;
  status: AvailabilityStatus;
  in_call: boolean;
  in_call_since: string | null;
  active_call_session_id: string | null;
  last_heartbeat_at: string;
  updated_at: string;
}

async function authHeader(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export const callAvailabilityApi = {
  async getMyAvailability(workspaceId: string): Promise<AvailabilityRow | null> {
    const res = await fetch(`${API_BASE}/api/call-availability/${workspaceId}/me`, {credentials: 'include', 
      headers: await authHeader(),
    });
    if (!res.ok) throw new Error(`Failed: ${res.status}`);
    const json = await res.json();
    return json.availability ?? null;
  },
  async setMyAvailability(workspaceId: string, status: AvailabilityStatus): Promise<AvailabilityRow> {
    const res = await fetch(`${API_BASE}/api/call-availability/${workspaceId}/me`, {credentials: 'include', 
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
      body: JSON.stringify({ status }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body?.error || `Failed: ${res.status}`);
    }
    const json = await res.json();
    return json.availability;
  },
  async listWorkspaceAvailability(workspaceId: string): Promise<AvailabilityRow[]> {
    const res = await fetch(`${API_BASE}/api/call-availability/${workspaceId}`, {credentials: 'include', 
      headers: await authHeader(),
    });
    if (!res.ok) throw new Error(`Failed: ${res.status}`);
    const json = await res.json();
    return json.rows ?? [];
  },
};
