/**
 * Bot Analytics — workspace-scoped API client. Auth is the first-party
 * gs_session HttpOnly cookie (credentials: 'include'), matching seo-api.ts
 * and webAnalytics-api.ts.
 */
import { API_BASE as RESOLVED_API_BASE } from '@/lib/apiBase';

const API_BASE = RESOLVED_API_BASE || '';

export class BotAnalyticsApiError extends Error {
  status: number;
  code: string;
  upgradeRequired?: boolean;
  constructor(status: number, body: any) {
    const code = typeof body?.error === 'string' ? body.error : 'bot_analytics_request_failed';
    super(code);
    this.name = 'BotAnalyticsApiError';
    this.status = status;
    this.code = code;
    this.upgradeRequired = body?.upgrade_required === true;
  }
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
  });
  const text = await res.text();
  const body = text ? safeJson(text) : null;
  if (!res.ok) throw new BotAnalyticsApiError(res.status, body);
  return body as T;
}

function safeJson(t: string): any {
  try { return JSON.parse(t); } catch { return null; }
}

function qs(params: Record<string, string | number | boolean | undefined>): string {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== '');
  if (!entries.length) return '';
  return '?' + entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&');
}

export interface DateRangeParams {
  startDate: string;
  endDate: string;
}

export interface BotAnalyticsLimits {
  planSlug: string | null;
  planName: string | null;
  limits: { bot_analytics_max_log_lines: number; [key: string]: number };
}

export function getBotAnalyticsLimits(workspaceId: string) {
  return api<BotAnalyticsLimits>(`/api/bot-analytics/${workspaceId}/limits`);
}

export interface BreakdownRow {
  key: string;
  label: string;
  visits: number;
}

export interface BotOverviewStats {
  hasImports: boolean;
  totalVisits: number;
  uniqueBots: number;
  uniquePaths: number;
  trend: Array<{ date: string; visits: number }>;
  topBots: BreakdownRow[];
  topCategories: BreakdownRow[];
  truncated: boolean;
}

export function getBotOverview(workspaceId: string, range: DateRangeParams) {
  return api<BotOverviewStats>(`/api/bot-analytics/${workspaceId}/overview${qs({ ...range })}`);
}

export function getBotCategories(workspaceId: string, range: DateRangeParams) {
  return api<{ rows: Array<BreakdownRow & { uniqueBots: number }>; truncated: boolean }>(`/api/bot-analytics/${workspaceId}/categories${qs({ ...range })}`);
}

export interface CrawledPageRow {
  path: string;
  visits: number;
  uniqueBots: number;
  topBot: string;
}

export function getCrawledPages(workspaceId: string, range: DateRangeParams) {
  return api<{ rows: CrawledPageRow[]; truncated: boolean }>(`/api/bot-analytics/${workspaceId}/crawled-pages${qs({ ...range })}`);
}

export interface AiBotRow {
  botName: string;
  visits: number;
  uniquePaths: number;
  lastSeen: string;
}

export function getAiBots(workspaceId: string, range: DateRangeParams) {
  return api<{ rows: AiBotRow[]; totalAiVisits: number; totalVisits: number; truncated: boolean }>(`/api/bot-analytics/${workspaceId}/ai-bots${qs({ ...range })}`);
}

export interface BotImportSummary {
  id: string;
  filename: string;
  format: string;
  totalLines: number;
  matchedBotLines: number;
  unparsedLines: number;
  truncated: boolean;
  dateRangeStart: string | null;
  dateRangeEnd: string | null;
  createdAt: string;
}

export function listBotImports(workspaceId: string) {
  return api<{ imports: BotImportSummary[] }>(`/api/bot-analytics/${workspaceId}/imports`);
}

export function uploadBotLog(workspaceId: string, filename: string, base64Data: string) {
  return api<{ import: BotImportSummary }>(`/api/bot-analytics/${workspaceId}/imports`, {
    method: 'POST',
    body: JSON.stringify({ filename, data: base64Data }),
  });
}

export function deleteBotImport(workspaceId: string, importId: string) {
  return api<{ ok: boolean }>(`/api/bot-analytics/${workspaceId}/imports/${importId}`, { method: 'DELETE' });
}
