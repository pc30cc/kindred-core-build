/**
 * Contacts API client — canonical create / bulk-import chokepoint.
 * Calls POST /api/contacts and POST /api/contacts/bulk on the
 * self-hosted backend. The server enforces `max_contacts` via the
 * shared TypeScript entitlement stack before inserting.
 *
 * Auth: Bearer = Supabase user access token (same pattern as
 * conversations-api.ts).
 */
import { supabase } from '@/integrations/supabase/client';

const API_BASE = import.meta.env.VITE_API_BASE_URL || '';

async function authHeaders(): Promise<Record<string, string>> {
  const { data: { session } } = await supabase.auth.getSession();
  return session?.access_token
    ? { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' }
    : { 'Content-Type': 'application/json' };
}

export interface CreateContactInput {
  workspace_id: string;
  email?: string | null;
  name?: string | null;
  phone?: string | null;
  avatar_url?: string | null;
  tags?: string[];
  notes?: string | null;
  metadata?: Record<string, unknown>;
}

export interface BulkCreateResult {
  ok: boolean;
  inserted: number;
}

export const contactsApi = {
  async create(payload: CreateContactInput) {
    const res = await fetch(`${API_BASE}/api/contacts`, {credentials: 'include', 
      method: 'POST',
      headers: await authHeaders(),
      body: JSON.stringify(payload),
    });
    const json = await res.json();
    if (!res.ok) {
      const err: any = new Error(json.error || `Create failed: ${res.status}`);
      err.status = res.status;
      err.body = json;
      throw err;
    }
    return json.contact;
  },

  async bulkCreate(workspace_id: string, contacts: Array<Omit<CreateContactInput, 'workspace_id'>>): Promise<BulkCreateResult> {
    if (!contacts.length) return { ok: true, inserted: 0 };
    const res = await fetch(`${API_BASE}/api/contacts/bulk`, {credentials: 'include',
      method: 'POST',
      headers: await authHeaders(),
      body: JSON.stringify({ workspace_id, contacts }),
    });
    const json = await res.json();
    if (!res.ok) {
      const err: any = new Error(json.error || `Bulk create failed: ${res.status}`);
      err.status = res.status;
      err.body = json;
      throw err;
    }
    return { ok: true, inserted: Number(json.inserted ?? 0) };
  },

  // ─── List / read / update / delete ──────────────────────────
  // See server/routes/contacts.ts — replaces the previous direct
  // supabase.from('contacts'/'conversations'/...) reads/writes.
  async list(workspaceId: string) {
    const res = await fetch(`${API_BASE}/api/contacts?workspace_id=${encodeURIComponent(workspaceId)}`, {credentials: 'include', headers: await authHeaders() });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || `List failed: ${res.status}`);
    return json.contacts;
  },

  async get(id: string) {
    const res = await fetch(`${API_BASE}/api/contacts/${encodeURIComponent(id)}`, {credentials: 'include', headers: await authHeaders() });
    if (res.status === 404) return null;
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || `Get failed: ${res.status}`);
    return json.contact;
  },

  async getConversations(contactId: string) {
    const res = await fetch(`${API_BASE}/api/contacts/${encodeURIComponent(contactId)}/conversations`, {credentials: 'include', headers: await authHeaders() });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || `Get conversations failed: ${res.status}`);
    return json.conversations;
  },

  async update(id: string, patch: Record<string, unknown>) {
    const res = await fetch(`${API_BASE}/api/contacts/${encodeURIComponent(id)}`, {credentials: 'include',
      method: 'PATCH',
      headers: await authHeaders(),
      body: JSON.stringify(patch),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || `Update failed: ${res.status}`);
    return json.contact;
  },

  async delete(id: string): Promise<void> {
    const res = await fetch(`${API_BASE}/api/contacts/${encodeURIComponent(id)}`, {credentials: 'include',
      method: 'DELETE',
      headers: await authHeaders(),
    });
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      throw new Error(json.error || `Delete failed: ${res.status}`);
    }
  },

  async bulkDelete(ids: string[]): Promise<{ deleted: number }> {
    if (!ids.length) return { deleted: 0 };
    const res = await fetch(`${API_BASE}/api/contacts/bulk-delete`, {credentials: 'include',
      method: 'POST',
      headers: await authHeaders(),
      body: JSON.stringify({ ids }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || `Bulk delete failed: ${res.status}`);
    return json;
  },
};