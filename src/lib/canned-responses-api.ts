/**
 * Phase 6 — Canned responses API client.
 *
 * Thin wrapper over the self-hosted backend at /api/canned-responses.
 * Auth: Bearer = Supabase user access token (mirrors conversation-notes).
 *
 * The 6 approved interpolation variables are documented here for the UI;
 * the server stores raw `{{var}}` placeholders verbatim and never expands
 * them. Expansion happens in the composer at insertion time.
 */

import { supabase } from '@/integrations/supabase/client';

const API_BASE = import.meta.env.VITE_API_BASE_URL || '';

export type CannedLocale = 'en' | 'fa' | 'tr';

export interface CannedResponse {
  id: string;
  workspace_id: string;
  created_by: string;
  locale: CannedLocale;
  shortcut: string;
  title: string;
  body: string;
  is_active: boolean;
  usage_count: number;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CannedListResponse {
  ok: true;
  items: CannedResponse[];
  /** The operator locale the server used to rank results. */
  locale: CannedLocale;
}

export interface CannedCreateInput {
  workspace_id: string;
  locale: CannedLocale;
  shortcut: string;
  title: string;
  body: string;
  is_active?: boolean;
}

/**
 * PATCH input — server enforces the same whitelist. We forbid sending
 * workspace_id changes / created_by / usage_count / last_used_at from the
 * client by simply not exposing them in the type.
 */
export interface CannedUpdateInput {
  workspace_id: string;
  locale?: CannedLocale;
  shortcut?: string;
  title?: string;
  body?: string;
  is_active?: boolean;
}

/** The 6 approved interpolation variables. UI must not introduce new ones. */
export const CANNED_VARIABLES = [
  'contact.name',
  'contact.email',
  'workspace.name',
  'agent.name',
  'agent.first_name',
  'agent.email',
] as const;
export type CannedVariable = (typeof CANNED_VARIABLES)[number];

async function authHeaders(): Promise<Record<string, string>> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  return session?.access_token
    ? { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' }
    : { 'Content-Type': 'application/json' };
}

async function parse<T>(res: Response, fallback: string): Promise<T> {
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json as any)?.error || `${fallback}: ${res.status}`);
  return json as T;
}

export const cannedResponsesApi = {
  async list(params: {
    workspace_id: string;
    locale: CannedLocale;
    q?: string;
    limit?: number;
  }): Promise<CannedListResponse> {
    const search = new URLSearchParams({
      workspace_id: params.workspace_id,
      locale: params.locale,
    });
    if (params.q) search.set('q', params.q);
    if (params.limit) search.set('limit', String(params.limit));
    const res = await fetch(`${API_BASE}/api/canned-responses?${search.toString()}`, {credentials: 'include', 
      headers: await authHeaders(),
    });
    return parse<CannedListResponse>(res, 'Canned responses load failed');
  },

  async create(input: CannedCreateInput): Promise<CannedResponse> {
    const res = await fetch(`${API_BASE}/api/canned-responses`, {credentials: 'include', 
      method: 'POST',
      headers: await authHeaders(),
      body: JSON.stringify(input),
    });
    const json = await parse<{ ok: true; item: CannedResponse }>(res, 'Create failed');
    return json.item;
  },

  async update(id: string, input: CannedUpdateInput): Promise<CannedResponse> {
    const res = await fetch(`${API_BASE}/api/canned-responses/${encodeURIComponent(id)}`, {credentials: 'include', 
      method: 'PATCH',
      headers: await authHeaders(),
      body: JSON.stringify(input),
    });
    const json = await parse<{ ok: true; item: CannedResponse }>(res, 'Update failed');
    return json.item;
  },

  async remove(id: string, workspace_id: string): Promise<void> {
    const url =
      `${API_BASE}/api/canned-responses/${encodeURIComponent(id)}` +
      `?workspace_id=${encodeURIComponent(workspace_id)}`;
    const res = await fetch(url, {credentials: 'include', method: 'DELETE', headers: await authHeaders() });
    await parse<{ ok: true }>(res, 'Delete failed');
  },

  /**
   * Track a successful insertion → send. NEVER call on preview or open.
   * Server atomically bumps usage_count and refreshes last_used_at.
   */
  async trackUse(
    id: string,
    workspace_id: string,
  ): Promise<{ ok: true; usage_count: number; last_used_at: string }> {
    const res = await fetch(
      `${API_BASE}/api/canned-responses/${encodeURIComponent(id)}/track-use`,
      {credentials: 'include', 
        method: 'POST',
        headers: await authHeaders(),
        body: JSON.stringify({ workspace_id }),
      },
    );
    return parse<{ ok: true; usage_count: number; last_used_at: string }>(res, 'Track failed');
  },
};
