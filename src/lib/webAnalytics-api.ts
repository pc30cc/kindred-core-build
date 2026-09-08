/**
 * Web Analytics — workspace-scoped API client. Auth is the first-party
 * gs_session HttpOnly cookie (credentials: 'include'), matching seo-api.ts.
 */
import { API_BASE as RESOLVED_API_BASE } from '@/lib/apiBase';

const API_BASE = RESOLVED_API_BASE || '';

export class WebAnalyticsApiError extends Error {
  status: number;
  code: string;
  upgradeRequired?: boolean;
  constructor(status: number, body: any) {
    const code = typeof body?.error === 'string' ? body.error : 'web_analytics_request_failed';
    super(code);
    this.name = 'WebAnalyticsApiError';
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
  if (!res.ok) throw new WebAnalyticsApiError(res.status, body);
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

export interface WebAnalyticsLimits {
  planSlug: string | null;
  planName: string | null;
  limits: { web_analytics_max_funnels: number; [key: string]: number };
}

export function getWebAnalyticsLimits(workspaceId: string) {
  return api<WebAnalyticsLimits>(`/api/web-analytics/${workspaceId}/limits`);
}

export interface OverviewStats {
  sessions: number;
  pageviews: number;
  avgPagesPerSession: number;
  uniqueVisitors: number;
  trend: Array<{ date: string; sessions: number; pageviews: number }>;
  topChannels: BreakdownRow[];
  topPages: Array<{ path: string; views: number }>;
  truncated: boolean;
}

export function getOverview(workspaceId: string, range: DateRangeParams) {
  return api<OverviewStats>(`/api/web-analytics/${workspaceId}/overview${qs({ ...range })}`);
}

export interface BreakdownRow {
  key: string;
  label: string;
  sessions: number;
  pageviews: number;
}

export type TrafficSourceDimension = 'channel' | 'source' | 'campaign';
export function getTrafficSources(workspaceId: string, dimension: TrafficSourceDimension, range: DateRangeParams) {
  return api<{ rows: BreakdownRow[]; truncated: boolean }>(`/api/web-analytics/${workspaceId}/traffic-sources${qs({ dimension, ...range })}`);
}

export type GeographyDimension = 'continent' | 'country' | 'city' | 'language';
export function getGeography(workspaceId: string, dimension: GeographyDimension, range: DateRangeParams) {
  return api<{ rows: BreakdownRow[]; truncated: boolean }>(`/api/web-analytics/${workspaceId}/geography${qs({ dimension, ...range })}`);
}

export type BrowsersSystemsDimension = 'browser' | 'os' | 'device';
export function getBrowsersSystems(workspaceId: string, dimension: BrowsersSystemsDimension, range: DateRangeParams) {
  return api<{ rows: BreakdownRow[]; truncated: boolean }>(`/api/web-analytics/${workspaceId}/browsers-systems${qs({ dimension, ...range })}`);
}

export interface PageRow {
  path: string;
  views: number;
}

export type PagesKind = 'top' | 'entry' | 'exit' | 'new';
export function getPages(workspaceId: string, kind: PagesKind, range: DateRangeParams) {
  return api<{ rows: PageRow[]; truncated: boolean }>(`/api/web-analytics/${workspaceId}/pages${qs({ kind, ...range })}`);
}

export interface ClonedPageGroup {
  normalizedPath: string;
  totalViews: number;
  variants: Array<{ url: string; views: number }>;
}

export function getClonedPages(workspaceId: string, range: DateRangeParams) {
  return api<{ rows: ClonedPageGroup[]; truncated: boolean }>(`/api/web-analytics/${workspaceId}/pages/cloned${qs({ ...range })}`);
}

export interface SiteStructureNode {
  segment: string;
  path: string;
  views: number;
  children: SiteStructureNode[];
}

export function getSiteStructure(workspaceId: string, range: DateRangeParams) {
  return api<{ root: SiteStructureNode; truncated: boolean }>(`/api/web-analytics/${workspaceId}/pages/site-structure${qs({ ...range })}`);
}

export interface Possible404Row {
  path: string;
  views: number;
  httpStatus: number;
}

export function getPossible404s(workspaceId: string, range: DateRangeParams) {
  return api<{ available: boolean; rows: Possible404Row[] }>(`/api/web-analytics/${workspaceId}/pages/possible-404${qs({ ...range })}`);
}

export interface TrackedEventRow {
  eventName: string;
  count: number;
  uniqueSessions: number;
}

export function getTrackedEvents(workspaceId: string, range: DateRangeParams) {
  return api<{ rows: TrackedEventRow[]; truncated: boolean }>(`/api/web-analytics/${workspaceId}/events${qs({ ...range })}`);
}

export function getEventPropertyKeys(workspaceId: string, eventName: string, range: DateRangeParams) {
  return api<{ keys: string[] }>(`/api/web-analytics/${workspaceId}/events/properties${qs({ eventName, ...range })}`);
}

export interface EventPropertyValueRow {
  value: string;
  count: number;
}

export function getEventPropertyBreakdown(workspaceId: string, eventName: string, propertyKey: string, range: DateRangeParams) {
  return api<{ rows: EventPropertyValueRow[]; truncated: boolean }>(`/api/web-analytics/${workspaceId}/events/properties/values${qs({ eventName, propertyKey, ...range })}`);
}

export type FunnelStep =
  | { type: 'pageview'; matcher: 'exact' | 'contains'; value: string; label?: string }
  | { type: 'event'; eventName: string; label?: string };

export interface Funnel {
  id: string;
  workspace_id: string;
  name: string;
  steps: FunnelStep[];
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export function listFunnels(workspaceId: string) {
  return api<{ funnels: Funnel[] }>(`/api/web-analytics/${workspaceId}/funnels`);
}

export function createFunnel(workspaceId: string, name: string, steps: FunnelStep[]) {
  return api<{ funnel: Funnel }>(`/api/web-analytics/${workspaceId}/funnels`, {
    method: 'POST',
    body: JSON.stringify({ name, steps }),
  });
}

export function deleteFunnel(workspaceId: string, funnelId: string) {
  return api<{ ok: boolean }>(`/api/web-analytics/${workspaceId}/funnels/${funnelId}`, { method: 'DELETE' });
}

export interface FunnelStepResult {
  label: string;
  sessions: number;
  conversionFromPrevious: number;
  conversionFromStart: number;
}

export function getFunnelResults(workspaceId: string, funnelId: string, range: DateRangeParams) {
  return api<{ funnel: Funnel; results: FunnelStepResult[] }>(`/api/web-analytics/${workspaceId}/funnels/${funnelId}/results${qs({ ...range })}`);
}
