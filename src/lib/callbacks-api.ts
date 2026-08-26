/**
 * Phase 8D — Callback request API client (operator-side).
 * Visitor-side callback creation flows through the widget runtime.
 */

const API_BASE = import.meta.env.VITE_API_BASE_URL || '';

export type CallbackChannel = 'audio' | 'video';
export type CallbackStatus =
  | 'requested'
  | 'scheduled'
  | 'in_progress'
  | 'completed'
  | 'cancelled';

export interface CallbackRow {
  id: string;
  workspace_id: string;
  conversation_id: string | null;
  contact_id: string | null;
  visitor_session_id: string | null;
  channel: CallbackChannel;
  status: CallbackStatus;
  contact_phone: string | null;
  contact_email: string | null;
  notes: string | null;
  metadata: Record<string, unknown>;
  requested_at: string;
  scheduled_at: string | null;
  /** Phase 8E — visitor-chosen callback time. NULL = immediate. */
  scheduled_for: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
  handled_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface CallbackCounts {
  requested: number;
  scheduled: number;
  in_progress: number;
  completed: number;
  cancelled: number;
}

export const callbacksApi = {
  async list(workspaceId: string, status?: CallbackStatus | 'open'): Promise<CallbackRow[]> {
    const url = `${API_BASE}/api/callbacks/${workspaceId}` + (status ? `?status=${status}` : '');
    const res = await fetch(url, {credentials: 'include', headers: {} });
    if (!res.ok) throw new Error(`Failed: ${res.status}`);
    const json = await res.json();
    return json.callbacks ?? [];
  },
  async update(workspaceId: string, callbackId: string, status: CallbackStatus): Promise<CallbackRow> {
    const res = await fetch(`${API_BASE}/api/callbacks/${workspaceId}/${callbackId}`, {credentials: 'include', 
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body?.error || `Failed: ${res.status}`);
    }
    const json = await res.json();
    return json.callback;
  },
  async getCounts(workspaceId: string): Promise<CallbackCounts> {
    const res = await fetch(`${API_BASE}/api/callbacks/${workspaceId}/counts`, {credentials: 'include', 
    });
    if (!res.ok) throw new Error(`Failed: ${res.status}`);
    return res.json();
  },
};
