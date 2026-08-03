/**
 * AI Knowledge Base Builder — operator-side API client.
 * All work runs through the project's own Express backend (no edge functions).
 */
import { supabase } from '@/integrations/supabase/client';

const API_BASE = (import.meta as any).env?.VITE_API_BASE_URL || '';

/**
 * Phase 6-S5-R7.2 — review mutations return real HTTP status codes:
 *   409 invalid_state          → another operator already moved this draft
 *   503 ai_kb_status_unavailable → transient, retry
 * Previously accept/reject/publish returned `res.json()` unconditionally, so
 * a refused transition rendered as a success toast.
 */
export class AiKbApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly currentStatus: string | null;
  readonly retryable: boolean;

  constructor(status: number, body: Record<string, any>) {
    const code = typeof body?.error === 'string' ? body.error : 'ai_kb_request_failed';
    super(code);
    this.name = 'AiKbApiError';
    this.status = status;
    this.code = code;
    this.currentStatus = typeof body?.current_status === 'string' ? body.current_status : null;
    this.retryable = status >= 500;
  }
}

async function parse<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new AiKbApiError(res.status, body);
  return body as T;
}

async function authHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export interface AiKbSourceResponse {
  source: {
    domain: string | null;
    kind: 'workspace_domain' | 'profile_domain' | null;
    workspace_domain_id: string | null;
    verified: boolean;
    is_primary: boolean;
    can_scan: boolean;
    reason_if_blocked: string | null;
    available_domains: Array<{ id: string; domain: string; verified: boolean; is_primary: boolean }>;
  };
  plan: {
    slug: string | null;
    limits: {
      maxPages: number; maxDepth: number; jobsPerMonth: number;
      maxArticles: number; maxChars: number; monthlyCredits: number;
    };
    jobs_used_this_month: number;
    can_start_job: boolean;
  };
  credits: { used: number; limit: number; remaining: number; period: string };
  modules: {
    knowledge_base: boolean;
    ai_assistant: boolean;
    ai_kb_builder: boolean;
    platform_enabled: boolean;
    /** Platform state unreadable — show a retry state, never an upgrade CTA. */
    platform_status_unavailable: boolean;
    /** Plan lookup unreadable — the booleans above are NOT authoritative. */
    entitlement_status_unavailable: boolean;
  };
  is_global_admin?: boolean;
}

export const aiKbApi = {
  async getSource(workspaceId: string, domainId?: string): Promise<AiKbSourceResponse> {
    const url = new URL(`${API_BASE}/api/ai-kb/source`, window.location.origin);
    url.searchParams.set('workspaceId', workspaceId);
    if (domainId) url.searchParams.set('domain_id', domainId);
    const res = await fetch(url.toString().replace(window.location.origin, ''), { headers: await authHeaders() });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'failed');
    return res.json();
  },
  async createJob(workspaceId: string, opts: { domain_id?: string; locale?: 'en' | 'fa' | 'tr' } = {}) {
    const res = await fetch(`${API_BASE}/api/ai-kb/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify({ workspaceId, ...opts }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'failed');
    return data;
  },
  async listJobs(workspaceId: string) {
    const res = await fetch(`${API_BASE}/api/ai-kb/jobs?workspaceId=${workspaceId}`, { headers: await authHeaders() });
    if (!res.ok) throw new Error('failed');
    return res.json();
  },
  async getJob(id: string) {
    const res = await fetch(`${API_BASE}/api/ai-kb/jobs/${id}`, { headers: await authHeaders() });
    if (!res.ok) throw new Error('failed');
    return res.json();
  },
  async accept(id: string) {
    return parse<{ ok: true; kb_article_id?: string }>(
      await fetch(`${API_BASE}/api/ai-kb/generated/${id}/accept`, {
        method: 'POST', headers: await authHeaders(),
      }),
    );
  },
  async reject(id: string) {
    return parse<{ ok: true }>(
      await fetch(`${API_BASE}/api/ai-kb/generated/${id}/reject`, {
        method: 'POST', headers: await authHeaders(),
      }),
    );
  },
  async publish(id: string) {
    return parse<{ ok: true; kb_article_id?: string; slug?: string; locale?: string }>(
      await fetch(`${API_BASE}/api/ai-kb/generated/${id}/publish`, {
        method: 'POST', headers: await authHeaders(),
      }),
    );
  },
  async publishAll(jobId: string) {
    const res = await fetch(`${API_BASE}/api/ai-kb/jobs/${jobId}/publish-all`, {
      method: 'POST', headers: await authHeaders(),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'failed');
    return data;
  },
  async getVisibility(id: string) {
    const res = await fetch(`${API_BASE}/api/ai-kb/generated/${id}/visibility`, { headers: await authHeaders() });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'failed');
    return res.json();
  },
  async getDiagnostics(workspaceId: string) {
    const res = await fetch(`${API_BASE}/api/ai-kb/worker/diagnostics?workspaceId=${workspaceId}`, {
      headers: await authHeaders(),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'failed');
    return res.json();
  },
  async createTestJob(workspaceId: string, generate = false) {
    const res = await fetch(`${API_BASE}/api/ai-kb/jobs/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify({ workspaceId, generate }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'failed');
    return data;
  },
};
