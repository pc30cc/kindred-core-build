/**
 * WEB ANALYTICS — REPORTING LAYER
 *
 * Reads `visitor_sessions` + `visitor_page_views` (populated by the chat
 * widget's tracking snippet, public/widget/loader.js -> POST
 * /api/widget/track, server/routes/widget.ts) — see the header comment of
 * database/migrations/145_web_analytics.sql for why this is a reporting
 * layer over existing data rather than a second tracking pipeline.
 *
 * Every report is computed from a BOUNDED query (ROW_CAP rows per range),
 * aggregated in-process. That is the right tradeoff at this app's traffic
 * scale (a workspace's own site, not ad-tech volume) — a real OLAP rollup
 * pipeline is not warranted for a first version, and this never fabricates
 * data: a truncated result is flagged, never silently padded.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { classifyChannel, referrerDomain, type Channel } from './channels.js';
import { continentForCountry, CONTINENT_NAMES } from './continents.js';
import { getCrawlPages } from '../seo/canonicalRepository.js';

const ROW_CAP = 20_000;

export interface DateRange {
  /** Inclusive, YYYY-MM-DD. */
  startDate: string;
  /** Inclusive, YYYY-MM-DD. */
  endDate: string;
}

function rangeToTimestamps(range: DateRange): { startIso: string; endIso: string } {
  const start = new Date(`${range.startDate}T00:00:00.000Z`);
  const end = new Date(`${range.endDate}T23:59:59.999Z`);
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}

interface SessionRow {
  id: string;
  referrer: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  browser: string | null;
  os: string | null;
  device: string | null;
  language: string | null;
  country: string | null;
  city: string | null;
  geo_country_code: string | null;
  geo_country_name: string | null;
  geo_city: string | null;
  started_at: string;
  last_seen_at: string;
}

interface PageViewRow {
  visitor_session_id: string;
  url: string;
  title: string | null;
  viewed_at: string;
}

export interface LoadedRangeData {
  sessions: SessionRow[];
  pageViews: PageViewRow[];
  truncatedSessions: boolean;
  truncatedPageViews: boolean;
}

async function loadRangeData(config: ServerConfig, workspaceId: string, range: DateRange): Promise<LoadedRangeData> {
  const sb = getServiceClient(config);
  const { startIso, endIso } = rangeToTimestamps(range);

  const [sessionsRes, pageViewsRes] = await Promise.all([
    sb.from('visitor_sessions')
      .select('id, referrer, utm_source, utm_medium, utm_campaign, browser, os, device, language, country, city, geo_country_code, geo_country_name, geo_city, started_at, last_seen_at')
      .eq('workspace_id', workspaceId)
      .gte('started_at', startIso)
      .lte('started_at', endIso)
      .order('started_at', { ascending: true })
      .limit(ROW_CAP),
    sb.from('visitor_page_views')
      .select('visitor_session_id, url, title, viewed_at')
      .eq('workspace_id', workspaceId)
      .gte('viewed_at', startIso)
      .lte('viewed_at', endIso)
      .order('viewed_at', { ascending: true })
      .limit(ROW_CAP),
  ]);
  if (sessionsRes.error) throw new Error(`web_analytics_sessions_query_failed: ${sessionsRes.error.message}`);
  if (pageViewsRes.error) throw new Error(`web_analytics_page_views_query_failed: ${pageViewsRes.error.message}`);

  const sessions = (sessionsRes.data || []) as SessionRow[];
  const pageViews = (pageViewsRes.data || []) as PageViewRow[];
  return {
    sessions,
    pageViews,
    truncatedSessions: sessions.length >= ROW_CAP,
    truncatedPageViews: pageViews.length >= ROW_CAP,
  };
}

function resolveCountryCode(s: SessionRow): string | null {
  return s.geo_country_code || s.country || null;
}
function resolveCountryName(s: SessionRow): string | null {
  return s.geo_country_name || s.country || null;
}
function resolveCity(s: SessionRow): string | null {
  return s.geo_city || s.city || null;
}

function pageviewCountBySession(pageViews: PageViewRow[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const pv of pageViews) map.set(pv.visitor_session_id, (map.get(pv.visitor_session_id) || 0) + 1);
  return map;
}

/** Normalizes a tracked URL for grouping: strips query/hash and a single trailing slash (except root). */
export function normalizePath(url: string): string {
  const withoutHash = url.split('#')[0] || '/';
  const withoutQuery = withoutHash.split('?')[0] || '/';
  if (withoutQuery.length > 1 && withoutQuery.endsWith('/')) return withoutQuery.slice(0, -1);
  return withoutQuery || '/';
}

export interface BreakdownRow {
  key: string;
  label: string;
  sessions: number;
  pageviews: number;
}

function buildBreakdown(
  sessions: SessionRow[],
  pvBySession: Map<string, number>,
  keyOf: (s: SessionRow) => string | null,
  labelOf: (key: string) => string = (k) => k,
): BreakdownRow[] {
  const buckets = new Map<string, { sessions: number; pageviews: number }>();
  for (const s of sessions) {
    const key = keyOf(s) || '(unknown)';
    const bucket = buckets.get(key) || { sessions: 0, pageviews: 0 };
    bucket.sessions += 1;
    bucket.pageviews += pvBySession.get(s.id) || 0;
    buckets.set(key, bucket);
  }
  return Array.from(buckets.entries())
    .map(([key, v]) => ({ key, label: labelOf(key), sessions: v.sessions, pageviews: v.pageviews }))
    .sort((a, b) => b.sessions - a.sessions);
}

// ─── Overview ────────────────────────────────────────────────────────────

export interface OverviewStats {
  sessions: number;
  pageviews: number;
  avgPagesPerSession: number;
  uniqueVisitors: number;
  /** Percentage (0-100) of sessions with a single pageview. */
  bounceRate: number;
  /** Average time between a session's first and most recent tracked activity. */
  avgVisitDurationSeconds: number;
  trend: Array<{ date: string; sessions: number; pageviews: number }>;
  topChannels: BreakdownRow[];
  topPages: Array<{ path: string; views: number }>;
  truncated: boolean;
}

export async function getOverview(config: ServerConfig, workspaceId: string, range: DateRange): Promise<OverviewStats> {
  const { sessions, pageViews, truncatedSessions, truncatedPageViews } = await loadRangeData(config, workspaceId, range);
  const pvBySession = pageviewCountBySession(pageViews);

  const byDate = new Map<string, { sessions: number; pageviews: number }>();
  for (const s of sessions) {
    const day = s.started_at.slice(0, 10);
    const bucket = byDate.get(day) || { sessions: 0, pageviews: 0 };
    bucket.sessions += 1;
    byDate.set(day, bucket);
  }
  for (const pv of pageViews) {
    const day = pv.viewed_at.slice(0, 10);
    const bucket = byDate.get(day) || { sessions: 0, pageviews: 0 };
    bucket.pageviews += 1;
    byDate.set(day, bucket);
  }
  const trend = Array.from(byDate.entries())
    .map(([date, v]) => ({ date, ...v }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  const channelRows = buildBreakdown(sessions, pvBySession, (s) => classifyChannel({ referrer: s.referrer, utmSource: s.utm_source, utmMedium: s.utm_medium }));
  const uniqueVisitors = new Set(sessions.map((s) => s.id)).size;

  const pageCounts = new Map<string, number>();
  for (const pv of pageViews) {
    const path = normalizePath(pv.url);
    pageCounts.set(path, (pageCounts.get(path) || 0) + 1);
  }
  const topPages = Array.from(pageCounts.entries())
    .map(([path, views]) => ({ path, views }))
    .sort((a, b) => b.views - a.views)
    .slice(0, 5);

  let bouncedSessions = 0;
  let totalDurationSeconds = 0;
  for (const s of sessions) {
    if ((pvBySession.get(s.id) || 0) <= 1) bouncedSessions += 1;
    const start = new Date(s.started_at).getTime();
    const end = new Date(s.last_seen_at).getTime();
    if (Number.isFinite(start) && Number.isFinite(end)) totalDurationSeconds += Math.max(0, (end - start) / 1000);
  }

  return {
    sessions: sessions.length,
    pageviews: pageViews.length,
    avgPagesPerSession: sessions.length > 0 ? Math.round((pageViews.length / sessions.length) * 10) / 10 : 0,
    uniqueVisitors,
    bounceRate: sessions.length > 0 ? Math.round((bouncedSessions / sessions.length) * 1000) / 10 : 0,
    avgVisitDurationSeconds: sessions.length > 0 ? Math.round(totalDurationSeconds / sessions.length) : 0,
    trend,
    topChannels: channelRows.slice(0, 5),
    topPages,
    truncated: truncatedSessions || truncatedPageViews,
  };
}

/** Cheap count-only query — total sessions started within `range`, used to compute event conversion rates. */
export async function getSessionCount(config: ServerConfig, workspaceId: string, range: DateRange): Promise<number> {
  const sb = getServiceClient(config);
  const { startIso, endIso } = rangeToTimestamps(range);
  const { count, error } = await sb
    .from('visitor_sessions')
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', workspaceId)
    .gte('started_at', startIso)
    .lte('started_at', endIso);
  if (error) throw new Error(`web_analytics_session_count_failed: ${error.message}`);
  return count || 0;
}

const LIVE_VISITOR_WINDOW_MS = 5 * 60 * 1000;

/** Distinct sessions with tracking activity in the last 5 minutes — the same "active now" signal the Visitors page uses (visitor_sessions.last_seen_at, bumped on every /track hit). */
export async function getLiveVisitorCount(config: ServerConfig, workspaceId: string): Promise<number> {
  const sb = getServiceClient(config);
  const since = new Date(Date.now() - LIVE_VISITOR_WINDOW_MS).toISOString();
  const { count, error } = await sb
    .from('visitor_sessions')
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', workspaceId)
    .gte('last_seen_at', since);
  if (error) throw new Error(`web_analytics_live_visitor_count_failed: ${error.message}`);
  return count || 0;
}

// ─── Traffic sources ────────────────────────────────────────────────────

export type TrafficSourceDimension = 'channel' | 'source' | 'campaign';

const CHANNEL_LABELS: Record<Channel, string> = {
  direct: 'Direct',
  organic_search: 'Organic Search',
  paid_search: 'Paid Search',
  organic_social: 'Organic Social',
  paid_social: 'Paid Social',
  email: 'Email',
  referral: 'Referral',
  other: 'Other',
};

export async function getTrafficSources(
  config: ServerConfig, workspaceId: string, range: DateRange, dimension: TrafficSourceDimension,
): Promise<{ rows: BreakdownRow[]; truncated: boolean }> {
  const { sessions, pageViews, truncatedSessions, truncatedPageViews } = await loadRangeData(config, workspaceId, range);
  const pvBySession = pageviewCountBySession(pageViews);

  let rows: BreakdownRow[];
  if (dimension === 'channel') {
    rows = buildBreakdown(
      sessions, pvBySession,
      (s) => classifyChannel({ referrer: s.referrer, utmSource: s.utm_source, utmMedium: s.utm_medium }),
      (k) => CHANNEL_LABELS[k as Channel] || k,
    );
  } else if (dimension === 'source') {
    rows = buildBreakdown(sessions, pvBySession, (s) => s.utm_source || referrerDomain(s.referrer));
  } else {
    rows = buildBreakdown(sessions, pvBySession, (s) => s.utm_campaign);
  }
  return { rows, truncated: truncatedSessions || truncatedPageViews };
}

// ─── Geography ──────────────────────────────────────────────────────────

export type GeographyDimension = 'continent' | 'country' | 'city' | 'language';

export async function getGeography(
  config: ServerConfig, workspaceId: string, range: DateRange, dimension: GeographyDimension,
): Promise<{ rows: BreakdownRow[]; truncated: boolean }> {
  const { sessions, pageViews, truncatedSessions, truncatedPageViews } = await loadRangeData(config, workspaceId, range);
  const pvBySession = pageviewCountBySession(pageViews);

  let rows: BreakdownRow[];
  if (dimension === 'continent') {
    rows = buildBreakdown(
      sessions, pvBySession,
      (s) => continentForCountry(resolveCountryCode(s)),
      (k) => CONTINENT_NAMES[k] || k,
    );
  } else if (dimension === 'country') {
    rows = buildBreakdown(sessions, pvBySession, (s) => resolveCountryName(s));
  } else if (dimension === 'city') {
    rows = buildBreakdown(sessions, pvBySession, (s) => resolveCity(s));
  } else {
    rows = buildBreakdown(sessions, pvBySession, (s) => s.language);
  }
  return { rows, truncated: truncatedSessions || truncatedPageViews };
}

// ─── Browsers & systems ─────────────────────────────────────────────────

export type BrowsersSystemsDimension = 'browser' | 'os' | 'device';

export async function getBrowsersSystems(
  config: ServerConfig, workspaceId: string, range: DateRange, dimension: BrowsersSystemsDimension,
): Promise<{ rows: BreakdownRow[]; truncated: boolean }> {
  const { sessions, pageViews, truncatedSessions, truncatedPageViews } = await loadRangeData(config, workspaceId, range);
  const pvBySession = pageviewCountBySession(pageViews);
  const keyOf = dimension === 'browser' ? (s: SessionRow) => s.browser : dimension === 'os' ? (s: SessionRow) => s.os : (s: SessionRow) => s.device;
  const rows = buildBreakdown(sessions, pvBySession, keyOf);
  return { rows, truncated: truncatedSessions || truncatedPageViews };
}

// ─── Pages ──────────────────────────────────────────────────────────────

export type PagesKind = 'top' | 'entry' | 'exit' | 'new';

export interface PageRow {
  path: string;
  views: number;
}

export async function getPages(
  config: ServerConfig, workspaceId: string, range: DateRange, kind: PagesKind,
): Promise<{ rows: PageRow[]; truncated: boolean }> {
  const { pageViews, truncatedPageViews } = await loadRangeData(config, workspaceId, range);

  if (kind === 'top') {
    const counts = new Map<string, number>();
    for (const pv of pageViews) {
      const path = normalizePath(pv.url);
      counts.set(path, (counts.get(path) || 0) + 1);
    }
    const rows = Array.from(counts.entries()).map(([path, views]) => ({ path, views })).sort((a, b) => b.views - a.views);
    return { rows, truncated: truncatedPageViews };
  }

  // Entry/exit: group page views by session, take the first/last chronologically.
  const bySession = new Map<string, PageViewRow[]>();
  for (const pv of pageViews) {
    const list = bySession.get(pv.visitor_session_id) || [];
    list.push(pv);
    bySession.set(pv.visitor_session_id, list);
  }

  if (kind === 'entry' || kind === 'exit') {
    const counts = new Map<string, number>();
    for (const list of bySession.values()) {
      const sorted = [...list].sort((a, b) => (a.viewed_at < b.viewed_at ? -1 : 1));
      const target = kind === 'entry' ? sorted[0] : sorted[sorted.length - 1];
      if (!target) continue;
      const path = normalizePath(target.url);
      counts.set(path, (counts.get(path) || 0) + 1);
    }
    const rows = Array.from(counts.entries()).map(([path, views]) => ({ path, views })).sort((a, b) => b.views - a.views);
    return { rows, truncated: truncatedPageViews };
  }

  // "new": pages whose FIRST EVER view (across all time, not just the
  // range) falls inside the selected range — a real "first seen" signal,
  // computed against the workspace's full page-view history.
  if (pageViews.length === 0) return { rows: [], truncated: truncatedPageViews };
  const sb = getServiceClient(config);
  const { startIso } = rangeToTimestamps(range);

  const { data: earlierViews, error } = await sb
    .from('visitor_page_views')
    .select('url, viewed_at')
    .eq('workspace_id', workspaceId)
    .lt('viewed_at', startIso)
    .limit(ROW_CAP);
  if (error) throw new Error(`web_analytics_new_pages_query_failed: ${error.message}`);
  const seenBefore = new Set((earlierViews || []).map((r) => normalizePath((r as { url: string }).url)));

  const counts = new Map<string, number>();
  for (const pv of pageViews) {
    const path = normalizePath(pv.url);
    if (seenBefore.has(path)) continue;
    counts.set(path, (counts.get(path) || 0) + 1);
  }
  const rows = Array.from(counts.entries()).map(([path, views]) => ({ path, views })).sort((a, b) => b.views - a.views);
  return { rows, truncated: truncatedPageViews };
}

// ─── Cloned pages ───────────────────────────────────────────────────────

export interface ClonedPageGroup {
  normalizedPath: string;
  totalViews: number;
  variants: Array<{ url: string; views: number }>;
}

/** Groups of raw tracked URLs that normalize to the same path — traffic split across URL variants (trailing slash, casing, duplicate query forms). */
export async function getClonedPages(config: ServerConfig, workspaceId: string, range: DateRange): Promise<{ rows: ClonedPageGroup[]; truncated: boolean }> {
  const { pageViews, truncatedPageViews } = await loadRangeData(config, workspaceId, range);

  const groups = new Map<string, Map<string, number>>();
  for (const pv of pageViews) {
    const normalized = normalizePath(pv.url);
    const raw = pv.url;
    const variants = groups.get(normalized) || new Map<string, number>();
    variants.set(raw, (variants.get(raw) || 0) + 1);
    groups.set(normalized, variants);
  }

  const rows: ClonedPageGroup[] = [];
  for (const [normalizedPath, variants] of groups.entries()) {
    if (variants.size < 2) continue;
    const variantRows = Array.from(variants.entries()).map(([url, views]) => ({ url, views })).sort((a, b) => b.views - a.views);
    rows.push({ normalizedPath, totalViews: variantRows.reduce((sum, v) => sum + v.views, 0), variants: variantRows });
  }
  rows.sort((a, b) => b.totalViews - a.totalViews);
  return { rows, truncated: truncatedPageViews };
}

// ─── Site structure ─────────────────────────────────────────────────────

export interface SiteStructureNode {
  segment: string;
  path: string;
  views: number;
  children: SiteStructureNode[];
}

export async function getSiteStructure(config: ServerConfig, workspaceId: string, range: DateRange): Promise<{ root: SiteStructureNode; truncated: boolean }> {
  const { pageViews, truncatedPageViews } = await loadRangeData(config, workspaceId, range);

  const root: SiteStructureNode = { segment: '/', path: '/', views: 0, children: [] };
  const nodeByPath = new Map<string, SiteStructureNode>([['/', root]]);

  for (const pv of pageViews) {
    const normalized = normalizePath(pv.url);
    root.views += 1;
    if (normalized === '/') continue;
    const segments = normalized.split('/').filter(Boolean);
    let currentPath = '';
    let parent = root;
    for (const segment of segments) {
      currentPath += `/${segment}`;
      let node = nodeByPath.get(currentPath);
      if (!node) {
        node = { segment, path: currentPath, views: 0, children: [] };
        nodeByPath.set(currentPath, node);
        parent.children.push(node);
      }
      node.views += 1;
      parent = node;
    }
  }

  const sortChildren = (node: SiteStructureNode) => {
    node.children.sort((a, b) => b.views - a.views);
    node.children.forEach(sortChildren);
  };
  sortChildren(root);

  return { root, truncated: truncatedPageViews };
}

// ─── Possible 404s ──────────────────────────────────────────────────────

export interface Possible404Row {
  path: string;
  views: number;
  httpStatus: number;
}

/**
 * Cross-references tracked page URLs against the workspace's most recent
 * Site Audit crawl (seo_pages.http_status) — reuses real crawl data instead
 * of a second link-checker. Returns an explicit `available: false` when no
 * crawl exists yet, rather than fabricating a result.
 */
export async function getPossible404s(config: ServerConfig, workspaceId: string, range: DateRange): Promise<{ available: boolean; rows: Possible404Row[] }> {
  const sb = getServiceClient(config);
  const { data: latestCrawl } = await sb
    .from('seo_crawls')
    .select('id')
    .eq('workspace_id', workspaceId)
    .eq('status', 'completed')
    .order('finished_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!latestCrawl) return { available: false, rows: [] };

  const crawlPages = await getCrawlPages(config, (latestCrawl as { id: string }).id);
  const statusByPath = new Map<string, number>();
  for (const entry of crawlPages) {
    const status = entry.page.http_status as number | null;
    if (typeof status !== 'number' || status < 400) continue;
    try { statusByPath.set(normalizePath(new URL(entry.url).pathname + new URL(entry.url).search), status); }
    catch { /* skip unparseable crawl URL */ }
  }
  if (statusByPath.size === 0) return { available: true, rows: [] };

  const { pageViews } = await loadRangeData(config, workspaceId, range);
  const counts = new Map<string, number>();
  for (const pv of pageViews) {
    const path = normalizePath(pv.url);
    if (statusByPath.has(path)) counts.set(path, (counts.get(path) || 0) + 1);
  }
  const rows = Array.from(counts.entries())
    .map(([path, views]) => ({ path, views, httpStatus: statusByPath.get(path)! }))
    .sort((a, b) => b.views - a.views);
  return { available: true, rows };
}
