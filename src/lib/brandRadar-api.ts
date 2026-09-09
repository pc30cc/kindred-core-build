/**
 * Brand Radar — workspace-scoped API client. Auth is the first-party
 * gs_session HttpOnly cookie (credentials: 'include'), matching the other
 * SEO API clients.
 */
import { API_BASE as RESOLVED_API_BASE } from '@/lib/apiBase';

const API_BASE = RESOLVED_API_BASE || '';

export class BrandRadarApiError extends Error {
  status: number;
  code: string;
  upgradeRequired?: boolean;
  retryAfterHours?: number;
  constructor(status: number, body: any) {
    const code = typeof body?.error === 'string' ? body.error : 'brand_radar_request_failed';
    super(code);
    this.name = 'BrandRadarApiError';
    this.status = status;
    this.code = code;
    this.upgradeRequired = body?.upgrade_required === true;
    this.retryAfterHours = typeof body?.retryAfterHours === 'number' ? body.retryAfterHours : undefined;
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
  if (!res.ok) throw new BrandRadarApiError(res.status, body);
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

export interface BrandRadarLimits {
  planSlug: string | null;
  planName: string | null;
  limits: {
    brand_radar_max_topics: number;
    brand_radar_max_competitors: number;
    brand_radar_check_frequency_hours: number;
    [key: string]: number;
  };
}

export function getBrandRadarLimits(workspaceId: string) {
  return api<BrandRadarLimits>(`/api/brand-radar/${workspaceId}/limits`);
}

export interface BrandRadarSettings {
  id: string;
  workspaceId: string;
  brandName: string;
  competitorNames: string[];
  siteId: string | null;
  createdAt: string;
  updatedAt: string;
}

export function getSettings(workspaceId: string) {
  return api<{ settings: BrandRadarSettings | null }>(`/api/brand-radar/${workspaceId}/settings`);
}

export function saveSettings(workspaceId: string, input: { brandName: string; competitorNames: string[]; siteId: string | null }) {
  return api<{ settings: BrandRadarSettings }>(`/api/brand-radar/${workspaceId}/settings`, {
    method: 'PUT',
    body: JSON.stringify(input),
  });
}

export interface BrandRadarTopic {
  id: string;
  workspaceId: string;
  label: string;
  prompt: string;
  createdAt: string;
}

export function listTopics(workspaceId: string) {
  return api<{ topics: BrandRadarTopic[] }>(`/api/brand-radar/${workspaceId}/topics`);
}

export function createTopic(workspaceId: string, label: string, prompt: string) {
  return api<{ topic: BrandRadarTopic }>(`/api/brand-radar/${workspaceId}/topics`, {
    method: 'POST',
    body: JSON.stringify({ label, prompt }),
  });
}

export function deleteTopic(workspaceId: string, topicId: string) {
  return api<{ ok: boolean }>(`/api/brand-radar/${workspaceId}/topics/${topicId}`, { method: 'DELETE' });
}

export interface AiVisibilityCheckResult {
  id: string;
  topicId: string | null;
  topicLabel: string;
  prompt: string;
  provider: string;
  model: string;
  responseText: string;
  brandMentioned: boolean;
  brandMentionPosition: number | null;
  competitorsMentioned: string[];
  createdAt: string;
}

export function getAiVisibility(workspaceId: string) {
  return api<{ rows: AiVisibilityCheckResult[] }>(`/api/brand-radar/${workspaceId}/ai-visibility`);
}

export function getAiVisibilityHistory(workspaceId: string, topicId?: string) {
  return api<{ rows: AiVisibilityCheckResult[] }>(`/api/brand-radar/${workspaceId}/ai-visibility/history${qs({ topicId })}`);
}

export function runAiVisibility(workspaceId: string) {
  return api<{ results: AiVisibilityCheckResult[]; errors: Array<{ topicId: string; message: string }> }>(`/api/brand-radar/${workspaceId}/ai-visibility/run`, { method: 'POST' });
}

export interface WebVisibilityCheckResult {
  id: string;
  term: string;
  isOwnBrand: boolean;
  device: string;
  position: number | null;
  rankingUrl: string | null;
  createdAt: string;
}

export function getWebVisibility(workspaceId: string) {
  return api<{ available: boolean; rows: WebVisibilityCheckResult[] }>(`/api/brand-radar/${workspaceId}/web-visibility`);
}

export function runWebVisibility(workspaceId: string) {
  return api<{ results: WebVisibilityCheckResult[]; errors: Array<{ term: string; code: string }> }>(`/api/brand-radar/${workspaceId}/web-visibility/run`, { method: 'POST' });
}

export interface SearchDemandRow {
  term: string;
  isOwnBrand: boolean;
  clicks: number;
  impressions: number;
  ctr: number;
  avgPosition: number;
  matchedQueries: number;
}

export function getSearchDemand(workspaceId: string, range: DateRangeParams) {
  return api<{ available: boolean; propertyUrl: string | null; rows: SearchDemandRow[] }>(`/api/brand-radar/${workspaceId}/search-demand${qs({ ...range })}`);
}

export interface BrandRadarOverview {
  hasSettings: boolean;
  brandName: string | null;
  competitorCount: number;
  topicCount: number;
  aiVisibility: { totalChecks: number; mentionRate: number | null; latestCheckedAt: string | null };
  webVisibility: { available: boolean; ownPosition: number | null; checkedAt: string | null };
  searchDemand: { available: boolean; clicks: number; impressions: number };
}

export function getOverview(workspaceId: string, range: DateRangeParams) {
  return api<BrandRadarOverview>(`/api/brand-radar/${workspaceId}/overview${qs({ ...range })}`);
}

export interface CompetitorRow {
  name: string;
  isOwnBrand: boolean;
  aiMentionRate: number | null;
  webPosition: number | null;
  searchClicks: number | null;
}

export function getCompetitors(workspaceId: string, range: DateRangeParams) {
  return api<{ rows: CompetitorRow[]; webAvailable: boolean; searchDemand: { available: boolean; propertyUrl: string | null; rows: SearchDemandRow[] } }>(`/api/brand-radar/${workspaceId}/competitors${qs({ ...range })}`);
}
