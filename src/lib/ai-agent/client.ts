/**
 * AI Agent — shared HTTP transport core.
 *
 * Mechanically extracted from the original src/lib/ai-agent-api.ts (Phase 4
 * frontend API client split). Every domain module imports jsonFetch/
 * AiAgentApiError/API_BASE from here instead of duplicating this logic.
 * Auth: first-party gs_session HttpOnly cookie (credentials: 'include') —
 * no Supabase Auth session/Bearer token involved.
 */
export const API_BASE = (import.meta as any).env?.VITE_API_BASE_URL || '';

/**
 * Structured error for the AI Agent API client.
 * `message` keeps the previous behaviour (backend `error` string or a
 * `request_failed_<status>` fallback) so existing callers reading only
 * `err.message` keep working. Never carries headers or tokens.
 */
export class AiAgentApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly body: unknown;
  readonly url: string;
  readonly method: string;
  readonly reason?: unknown;

  constructor(params: {
    message: string;
    status: number;
    code: string | null;
    body: unknown;
    url: string;
    method: string;
    cause?: unknown;
  }) {
    super(params.message);
    this.name = 'AiAgentApiError';
    this.status = params.status;
    this.code = params.code;
    this.body = params.body;
    this.url = params.url;
    this.method = params.method;
    if (params.cause !== undefined) this.reason = params.cause;
  }
}

function readErrorCode(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const record = body as Record<string, unknown>;
  if (typeof record.code === 'string' && record.code) return record.code;
  if (typeof record.error === 'string' && record.error) return record.error;
  return null;
}

export async function jsonFetch<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method || 'GET').toUpperCase();
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {credentials: 'include', 
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(init.headers || {}),
      },
    });
  } catch (cause) {
    throw new AiAgentApiError({
      message: 'network_error',
      status: 0,
      code: 'network_error',
      body: null,
      url: path,
      method,
      cause,
    });
  }

  const raw = await res.text().catch(() => '');
  let data: unknown = null;
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    data = null;
  }

  if (!res.ok) {
    const code = readErrorCode(data);
    throw new AiAgentApiError({
      message: code || `request_failed_${res.status}`,
      status: res.status,
      code,
      body: data,
      url: path,
      method,
    });
  }
  return (data ?? {}) as T;
}
