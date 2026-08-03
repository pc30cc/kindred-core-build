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
/**
 * Phase 6-S5-R7.4 §3 — the only fields the UI is allowed to read off an
 * error body. Anything else stays server-side.
 */
export interface AiKbApiErrorBody {
  error?: string;
  retryable?: boolean;
  upgrade_required?: boolean;
  current_status?: string | null;
}

export class AiKbApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly currentStatus: string | null;
  readonly retryable: boolean;
  /**
   * Phase 6-S5-R7.3 — true only when the denial is an authoritative PLAN
   * denial. Platform kill switches, customer-visibility switches and
   * infrastructure failures are never upgrade paths, so the UI must not
   * render an upgrade CTA for them.
   */
  readonly upgradeRequired: boolean;

  constructor(status: number, body: AiKbApiErrorBody) {
    const code = typeof body?.error === 'string' ? body.error : 'ai_kb_request_failed';
    super(code);
    this.name = 'AiKbApiError';
    this.status = status;
    this.code = code;
    this.currentStatus = typeof body?.current_status === 'string' ? body.current_status : null;
    this.retryable = status >= 500 || body?.retryable === true;
    this.upgradeRequired = body?.upgrade_required === true;
  }
}

async function parse<T>(res: Response): Promise<T> {
  const body: unknown = await res.json().catch(() => ({}));
  if (!res.ok) throw new AiKbApiError(res.status, (body ?? {}) as AiKbApiErrorBody);
  return body as T;
}

/** Codes that mean "retry later", not "your plan is too small". */
export const AI_KB_RETRYABLE_CODES = new Set([
  'ai_kb_status_unavailable',
  'ai_platform_status_unavailable',
  'entitlement_status_unavailable',
  'knowledge_base_permission_status_unavailable',
  'source_domain_status_unavailable',
  'plan_status_unavailable',
  'job_usage_status_unavailable',
  'credit_status_unavailable',
  'usage_status_unavailable',
]);

/** Platform-side blocks. Not fixable by upgrading — contact the operator. */
export const AI_KB_PLATFORM_DENIAL_CODES = new Set([
  'ai_platform_kill_switch',
  'ai_customer_visibility_disabled',
  'ai_workspace_disabled',
  'ai_platform_disabled',
]);

async function authHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// ─── Public DTO contract (mirrors server/services/ai-kb/dto.ts) ───
export interface AiKbJobDto {
  id: string;
  workspace_id: string;
  status: string;
  source_kind: string | null;
  source_domain: string | null;
  locale: string | null;
  progress: number;
  total_pages: number | null;
  processed_pages: number | null;
  failed_pages: number | null;
  generated_articles: number | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  error_code: string | null;
}

export interface AiKbGeneratedDto {
  id: string;
  job_id: string;
  title: string;
  slug: string | null;
  excerpt: string | null;
  locale: string;
  status: string;
  kb_article_id: string | null;
  suggested_category: string | null;
  confidence: number | null;
  created_at: string;
  updated_at: string;
  kb_article_slug: string | null;
  kb_article_locale: string | null;
  kb_article_status: string | null;
  /** Canonical Help Center path — non-null ONLY when genuinely published. */
  public_path: string | null;
}

export interface AiKbJobEventDto {
  id: string;
  job_id: string;
  event_type: string;
  status: string | null;
  created_at: string;
  error_code: string | null;
}

export interface AiKbJobDetailDto {
  job: AiKbJobDto;
  pages: AiKbPageDto[];
  generated: AiKbGeneratedDto[];
  events: AiKbJobEventDto[];
}

/** Redacted crawl-page projection. No raw URLs or provider text. */
export interface AiKbPageDto {
  id: string;
  job_id: string;
  status: string;
  path: string | null;
  title: string | null;
  chars: number | null;
  error_code: string | null;
  created_at: string;
}

/** Where a generated draft is actually visible today. */
export interface AiKbVisibilityDto {
  generated_status: string;
  kb_article_id: string | null;
  kb_article_status: string | null;
  visible_in_widget: boolean;
  used_by_ai: boolean;
  public_path: string | null;
}

/** Worker/queue health projection for the operator surface. */
export interface AiKbDiagnosticsDto {
  worker_seen_at: string | null;
  queued_jobs: number;
  running_jobs: number;
  stalled_jobs: number;
  provider_configured: boolean;
}

export interface AiKbPublishAllResponse {
  ok: true;
  published_count: number;
  failed_count: number;
  failed: Array<{ generated_id: string; error: string; current_status?: string | null }>;
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
    /** Non-null when the PLATFORM blocks this surface (not the plan). */
    platform_denial_code?: string | null;
  };
  upgrade_required?: boolean;
  is_global_admin?: boolean;
}

export const aiKbApi = {
  async getSource(workspaceId: string, domainId?: string): Promise<AiKbSourceResponse> {
    const url = new URL(`${API_BASE}/api/ai-kb/source`, window.location.origin);
    url.searchParams.set('workspaceId', workspaceId);
    if (domainId) url.searchParams.set('domain_id', domainId);
    return parse<AiKbSourceResponse>(
      await fetch(url.toString().replace(window.location.origin, ''), { headers: await authHeaders() }),
    );
  },
  async createJob(workspaceId: string, opts: { domain_id?: string; locale?: 'en' | 'fa' | 'tr' } = {}) {
    return parse<{ job: AiKbJobDto }>(
      await fetch(`${API_BASE}/api/ai-kb/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
        body: JSON.stringify({ workspaceId, ...opts }),
      }),
    );
  },
  async listJobs(workspaceId: string) {
    return parse<{ jobs: AiKbJobDto[] }>(
      await fetch(`${API_BASE}/api/ai-kb/jobs?workspaceId=${workspaceId}`, { headers: await authHeaders() }),
    );
  },
  async getJob(id: string) {
    return parse<AiKbJobDetailDto>(
      await fetch(`${API_BASE}/api/ai-kb/jobs/${id}`, { headers: await authHeaders() }),
    );
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
    return parse<AiKbPublishAllResponse>(
      await fetch(`${API_BASE}/api/ai-kb/jobs/${jobId}/publish-all`, {
        method: 'POST', headers: await authHeaders(),
      }),
    );
  },
  async getVisibility(id: string) {
    return parse<AiKbVisibilityDto>(
      await fetch(`${API_BASE}/api/ai-kb/generated/${id}/visibility`, { headers: await authHeaders() }),
    );
  },
  async getDiagnostics(workspaceId: string) {
    return parse<AiKbDiagnosticsDto>(
      await fetch(`${API_BASE}/api/ai-kb/worker/diagnostics?workspaceId=${workspaceId}`, {
        headers: await authHeaders(),
      }),
    );
  },
  async createTestJob(workspaceId: string, generate = false) {
    return parse<{ job: AiKbJobDto }>(
      await fetch(`${API_BASE}/api/ai-kb/jobs/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
        body: JSON.stringify({ workspaceId, generate }),
      }),
    );
  },
};
