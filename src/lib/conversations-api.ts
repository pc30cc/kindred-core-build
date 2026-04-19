/**
 * Conversations API client — backend-mediated agent reply send.
 * Calls POST /api/conversations/send-message on the self-hosted backend,
 * which inserts the message AND publishes to Centrifugo (if active) so
 * the visitor widget receives it live.
 *
 * Auth: Bearer = Supabase user access token (same pattern as
 * realtime-admin-api.ts).
 */
import { supabase } from '@/integrations/supabase/client';

const API_BASE = import.meta.env.VITE_API_BASE_URL || '';

async function authHeaders(): Promise<Record<string, string>> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  return session?.access_token
    ? { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' }
    : { 'Content-Type': 'application/json' };
}

export interface SendMessageResult {
  ok: boolean;
  message: {
    id: string;
    conversation_id: string;
    sender_type: 'agent' | 'contact' | 'system' | 'bot' | 'ai';
    sender_id: string | null;
    body: string;
    created_at: string;
    metadata: Record<string, unknown>;
    seen_at: string | null;
  };
  realtime: { published: boolean; reason: string | null };
}

export const conversationsApi = {
  async sendMessage(payload: {
    workspace_id: string;
    conversation_id: string;
    body: string;
    metadata?: Record<string, unknown>;
  }): Promise<SendMessageResult> {
    const res = await fetch(`${API_BASE}/api/conversations/send-message`, {
      method: 'POST',
      headers: await authHeaders(),
      body: JSON.stringify(payload),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || `Send failed: ${res.status}`);
    return json as SendMessageResult;
  },

  /**
   * Phase 1 — emit ephemeral operator typing.
   * Fire-and-forget; failure is silently ignored (typing is best-effort).
   */
  async sendTyping(payload: {
    workspace_id: string;
    conversation_id: string;
  }): Promise<void> {
    try {
      await fetch(`${API_BASE}/api/conversations/typing`, {
        method: 'POST',
        headers: await authHeaders(),
        body: JSON.stringify(payload),
      });
    } catch {
      /* noop — typing is best-effort */
    }
  },
};
