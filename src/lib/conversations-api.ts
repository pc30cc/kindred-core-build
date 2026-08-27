import { API_BASE as RESOLVED_API_BASE } from '@/lib/apiBase';
/**
 * Conversations API client — backend-mediated agent reply send.
 * Calls POST /api/conversations/send-message on the self-hosted backend,
 * which inserts the message AND publishes to Centrifugo (if active) so
 * the visitor widget receives it live.
 *
 * Auth: first-party gs_session HttpOnly cookie (credentials: 'include').
 */
const API_BASE = RESOLVED_API_BASE || '';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

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
    attachment?: {
      id: string;
      file_name: string;
      mime_type: string;
      size_bytes: number;
      kind: 'image' | 'file';
    };
  };
  realtime: { published: boolean; reason: string | null };
}

export interface OperatorAttachmentInit {
  attachment_id: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
}

export const conversationsApi = {
  async sendMessage(payload: {
    workspace_id: string;
    conversation_id: string;
    body: string;
    metadata?: Record<string, unknown>;
    attachment_id?: string | null;
  }): Promise<SendMessageResult> {
    const res = await fetch(`${API_BASE}/api/conversations/send-message`, {credentials: 'include', 
      method: 'POST',
      headers: JSON_HEADERS,
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
      await fetch(`${API_BASE}/api/conversations/typing`, {credentials: 'include', 
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify(payload),
      });
    } catch {
      /* noop — typing is best-effort */
    }
  },

  // ─── Phase 2 — Operator attachment upload (Inbox composer) ─────
  /**
   * Reserve an attachment row server-side. Returns attachment_id +
   * server-normalized metadata. Storage path is built by the server.
   */
  async initAttachment(payload: {
    workspace_id: string;
    conversation_id: string | null;
    file: File;
  }): Promise<OperatorAttachmentInit> {
    const res = await fetch(`${API_BASE}/api/conversation-attachments/init`, {credentials: 'include', 
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({
        workspace_id: payload.workspace_id,
        conversation_id: payload.conversation_id,
        file_name: payload.file.name,
        mime_type: payload.file.type || 'application/octet-stream',
        size_bytes: payload.file.size,
      }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || `Init failed: ${res.status}`);
    return json as OperatorAttachmentInit;
  },

  /**
   * Upload base64-encoded file bytes against a previously initialized
   * attachment. Server streams to the active storage provider.
   */
  async uploadAttachment(payload: {
    workspace_id: string;
    attachment_id: string;
    file: File;
    onProgress?: (pct: number) => void;
  }): Promise<{ attachment_id: string; status: string }> {
    // Read file as base64 (mirrors widget flow). Progress is granular at
    // read-completion since we use a single POST; consumers get 0→40→100.
    payload.onProgress?.(5);
    const b64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result || '');
        const idx = result.indexOf(',');
        resolve(idx >= 0 ? result.slice(idx + 1) : result);
      };
      reader.onerror = () => reject(reader.error || new Error('FileReader error'));
      reader.readAsDataURL(payload.file);
    });
    payload.onProgress?.(40);

    const res = await fetch(
      `${API_BASE}/api/conversation-attachments/${encodeURIComponent(payload.attachment_id)}/upload`,
      {credentials: 'include', 
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ workspace_id: payload.workspace_id, data: b64 }),
      },
    );
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || `Upload failed: ${res.status}`);
    payload.onProgress?.(100);
    return json;
  },

  async deleteAttachment(payload: {
    workspace_id: string;
    attachment_id: string;
  }): Promise<void> {
    await fetch(
      `${API_BASE}/api/conversation-attachments/${encodeURIComponent(payload.attachment_id)}?workspace_id=${encodeURIComponent(payload.workspace_id)}`,
      {credentials: 'include', method: 'DELETE', headers: JSON_HEADERS },
    );
  },

  /**
   * Operator-initiated outreach from the Visitors page. Returns an open
   * conversation for the visitor (reused if one already exists, otherwise
   * created). The caller then navigates to /inbox?c=<id> to compose the
   * first message through the normal send-message flow.
   */
  async startFromVisitor(payload: {
    workspace_id: string;
    visitor_session_id: string;
  }): Promise<{ ok: boolean; conversation_id: string; created: boolean }> {
    const res = await fetch(`${API_BASE}/api/conversations/start-from-visitor`, {credentials: 'include', 
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(payload),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || `Start failed: ${res.status}`);
    return json;
  },

  // ─── Phase 3 — Editable conversation fields ────────────────────
  /**
   * Patch one or more editable conversation fields. Allowed:
   *   - status: 'open' | 'pending' | 'resolved' | 'closed'
   *   - priority: 'low' | 'normal' | 'high' | 'urgent'
   *   - assigned_to: workspace member uuid | null
   *   - tags: string[]  (server normalizes: trim, lowercase, dedupe)
   *
   * Server records a normalized conversation_events row + an audit_log
   * row per changed field. Widget unaffected (no realtime envelope added).
   */
  async patchConversation(payload: {
    workspace_id: string;
    conversation_id: string;
    status?: 'open' | 'pending' | 'resolved' | 'closed';
    priority?: 'low' | 'normal' | 'high' | 'urgent';
    assigned_to?: string | null;
    tags?: string[];
  }): Promise<{
    ok: boolean;
    conversation: {
      id: string;
      workspace_id: string;
      status: string;
      priority: string;
      assigned_to: string | null;
      tags: string[];
      updated_at: string;
    };
  }> {
    const { workspace_id, conversation_id, ...rest } = payload;
    const res = await fetch(
      `${API_BASE}/api/conversations/${encodeURIComponent(conversation_id)}`,
      {credentials: 'include', 
        method: 'PATCH',
        headers: JSON_HEADERS,
        body: JSON.stringify({ workspace_id, ...rest }),
      },
    );
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || `Update failed: ${res.status}`);
    return json;
  },

  /**
   * Mark a conversation (and its contact, if any) as spam.
   * Soft routing only — does not block the visitor.
   */
  async markSpam(payload: { workspace_id: string; conversation_id: string }) {
    const res = await fetch(`${API_BASE}/api/conversations/spam`, {credentials: 'include', 
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(payload),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || `Mark spam failed: ${res.status}`);
    return json as { ok: true; conversation_ids: string[]; contact_id: string | null };
  },

  /** Clear the spam flag (and the contact's flag, if any). */
  async unmarkSpam(payload: { workspace_id: string; conversation_id: string }) {
    const res = await fetch(`${API_BASE}/api/conversations/not-spam`, {credentials: 'include',
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(payload),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || `Unmark spam failed: ${res.status}`);
    return json as { ok: true; conversation_ids: string[]; contact_id: string | null };
  },

  // ─── Inbox list + counts ──────────────────────────────────────
  // See server/routes/conversations.ts (GET /) — replaces the previous
  // direct supabase.from('conversations') read in useConversations.ts.
  async list(params: {
    workspace_id: string;
    queue?: 'main' | 'automated' | 'spam';
    status?: string;
    needsHuman?: boolean;
    assignedToMe?: string | null;
  }): Promise<{ conversations: any[] }> {
    const q = new URLSearchParams({ workspace_id: params.workspace_id });
    if (params.queue) q.set('queue', params.queue);
    if (params.status) q.set('status', params.status);
    if (params.needsHuman) q.set('needs_human', 'true');
    if (params.assignedToMe) q.set('assigned_to_me', params.assignedToMe);
    const res = await fetch(`${API_BASE}/api/conversations?${q}`, { credentials: 'include', headers: JSON_HEADERS });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || `List failed: ${res.status}`);
    return json;
  },

  async getInboxCounts(workspaceId: string): Promise<{ main: number; automated: number; needs_human: number; spam: number }> {
    const res = await fetch(`${API_BASE}/api/conversations/inbox-counts?workspace_id=${encodeURIComponent(workspaceId)}`, { credentials: 'include', headers: JSON_HEADERS });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || `Counts failed: ${res.status}`);
    return json;
  },

  async getInboxTabCounts(workspaceId: string): Promise<Record<string, number>> {
    const res = await fetch(`${API_BASE}/api/conversations/inbox-tab-counts?workspace_id=${encodeURIComponent(workspaceId)}`, { credentials: 'include', headers: JSON_HEADERS });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || `Tab counts failed: ${res.status}`);
    return json;
  },

  /** Thread for one conversation, enriched with attachment + sender identity. */
  async getMessages(conversationId: string): Promise<{ messages: any[] }> {
    const res = await fetch(`${API_BASE}/api/conversations/${encodeURIComponent(conversationId)}/messages`, { credentials: 'include', headers: JSON_HEADERS });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || `Messages failed: ${res.status}`);
    return json;
  },

  /** Mark every unseen visitor message in a conversation as seen. */
  async markSeen(conversationId: string): Promise<{ ok: boolean; count: number }> {
    const res = await fetch(`${API_BASE}/api/conversations/${encodeURIComponent(conversationId)}/seen`, {credentials: 'include',
      method: 'POST',
      headers: JSON_HEADERS,
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || `Mark seen failed: ${res.status}`);
    return json;
  },

  /** Delete every conversation (and its messages) in a workspace. Owner/admin only. */
  async deleteAll(workspaceId: string): Promise<{ deleted: number }> {
    const res = await fetch(`${API_BASE}/api/conversations`, {credentials: 'include',
      method: 'DELETE',
      headers: JSON_HEADERS,
      body: JSON.stringify({ workspace_id: workspaceId }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || `Delete all failed: ${res.status}`);
    return json;
  },
};
