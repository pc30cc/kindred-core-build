/**
 * WEB ANALYTICS — custom events + funnels.
 *
 * Events: one row per firing in `web_analytics_events`, written by the new
 * `POST /api/widget/event` route (server/routes/widget.ts) — the loader
 * snippet exposes `window.gsAnalytics.track(name, properties)` for the
 * workspace's own site code to call. Never auto-fired; a workspace opts in
 * per event by adding the call to their own pages.
 *
 * Funnels: a saved ordered list of steps (pageview-path-match or
 * event-name-match). Results are computed on demand from
 * visitor_page_views + web_analytics_events, never materialized — see
 * database/migrations/145_web_analytics.sql's header comment.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { normalizePath, type DateRange } from './reportService.js';

const ROW_CAP = 20_000;

function rangeToTimestamps(range: DateRange): { startIso: string; endIso: string } {
  const start = new Date(`${range.startDate}T00:00:00.000Z`);
  const end = new Date(`${range.endDate}T23:59:59.999Z`);
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}

// ─── Ingestion ──────────────────────────────────────────────────────────

const MAX_EVENT_NAME_LEN = 100;
const MAX_PROPERTY_KEYS = 20;
const MAX_PROPERTY_VALUE_LEN = 500;

/** Bounds a client-supplied properties object: fixed key cap, string-ified/truncated values, no nesting. */
function sanitizeProperties(raw: unknown): Record<string, string | number | boolean> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string | number | boolean> = {};
  let count = 0;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (count >= MAX_PROPERTY_KEYS) break;
    if (typeof key !== 'string' || !key.trim()) continue;
    if (value === null || value === undefined) continue;
    if (typeof value === 'number' || typeof value === 'boolean') {
      out[key.slice(0, 100)] = value;
    } else {
      out[key.slice(0, 100)] = String(value).slice(0, MAX_PROPERTY_VALUE_LEN);
    }
    count += 1;
  }
  return out;
}

export interface TrackEventInput {
  workspaceId: string;
  sessionId: string | null;
  eventName: string;
  properties?: unknown;
  pageUrl?: string | null;
}

export async function trackEvent(config: ServerConfig, input: TrackEventInput): Promise<{ ok: boolean }> {
  const eventName = input.eventName.trim().slice(0, MAX_EVENT_NAME_LEN);
  if (!eventName) return { ok: false };
  const sb = getServiceClient(config);
  const { error } = await sb.from('web_analytics_events').insert({
    workspace_id: input.workspaceId,
    visitor_session_id: input.sessionId,
    event_name: eventName,
    properties: sanitizeProperties(input.properties),
    page_url: input.pageUrl ? String(input.pageUrl).slice(0, 2048) : null,
  });
  return { ok: !error };
}

// ─── Tracked events / event properties reports ──────────────────────────

interface EventRow {
  visitor_session_id: string | null;
  event_name: string;
  properties: Record<string, unknown>;
  created_at: string;
}

async function loadEvents(config: ServerConfig, workspaceId: string, range: DateRange, eventName?: string): Promise<{ events: EventRow[]; truncated: boolean }> {
  const sb = getServiceClient(config);
  const { startIso, endIso } = rangeToTimestamps(range);
  let query = sb.from('web_analytics_events')
    .select('visitor_session_id, event_name, properties, created_at')
    .eq('workspace_id', workspaceId)
    .gte('created_at', startIso)
    .lte('created_at', endIso)
    .order('created_at', { ascending: true })
    .limit(ROW_CAP);
  if (eventName) query = query.eq('event_name', eventName);
  const { data, error } = await query;
  if (error) throw new Error(`web_analytics_events_query_failed: ${error.message}`);
  const events = (data || []) as EventRow[];
  return { events, truncated: events.length >= ROW_CAP };
}

export interface TrackedEventRow {
  eventName: string;
  count: number;
  uniqueSessions: number;
}

export async function getTrackedEvents(config: ServerConfig, workspaceId: string, range: DateRange): Promise<{ rows: TrackedEventRow[]; truncated: boolean }> {
  const { events, truncated } = await loadEvents(config, workspaceId, range);
  const byName = new Map<string, { count: number; sessions: Set<string> }>();
  for (const e of events) {
    const bucket = byName.get(e.event_name) || { count: 0, sessions: new Set<string>() };
    bucket.count += 1;
    if (e.visitor_session_id) bucket.sessions.add(e.visitor_session_id);
    byName.set(e.event_name, bucket);
  }
  const rows = Array.from(byName.entries())
    .map(([eventName, v]) => ({ eventName, count: v.count, uniqueSessions: v.sessions.size }))
    .sort((a, b) => b.count - a.count);
  return { rows, truncated };
}

export interface EventPropertyValueRow {
  value: string;
  count: number;
}

/** Distinct property keys seen on an event, for the property picker. */
export async function getEventPropertyKeys(config: ServerConfig, workspaceId: string, range: DateRange, eventName: string): Promise<string[]> {
  const { events } = await loadEvents(config, workspaceId, range, eventName);
  const keys = new Set<string>();
  for (const e of events) for (const k of Object.keys(e.properties || {})) keys.add(k);
  return Array.from(keys).sort();
}

export async function getEventPropertyBreakdown(
  config: ServerConfig, workspaceId: string, range: DateRange, eventName: string, propertyKey: string,
): Promise<{ rows: EventPropertyValueRow[]; truncated: boolean }> {
  const { events, truncated } = await loadEvents(config, workspaceId, range, eventName);
  const counts = new Map<string, number>();
  for (const e of events) {
    const raw = e.properties?.[propertyKey];
    const value = raw === undefined || raw === null || raw === '' ? '(not set)' : String(raw);
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  const rows = Array.from(counts.entries()).map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count);
  return { rows, truncated };
}

// ─── Funnels ────────────────────────────────────────────────────────────

export type FunnelStep =
  | { type: 'pageview'; matcher: 'exact' | 'contains'; value: string; label?: string }
  | { type: 'event'; eventName: string; label?: string };

export interface FunnelRow {
  id: string;
  workspace_id: string;
  name: string;
  steps: FunnelStep[];
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

function isValidStep(s: unknown): s is FunnelStep {
  if (!s || typeof s !== 'object') return false;
  const step = s as Record<string, unknown>;
  if (step.type === 'pageview') {
    return (step.matcher === 'exact' || step.matcher === 'contains') && typeof step.value === 'string' && step.value.trim() !== '';
  }
  if (step.type === 'event') {
    return typeof step.eventName === 'string' && step.eventName.trim() !== '';
  }
  return false;
}

export class FunnelValidationError extends Error {
  reason: 'invalid_steps' | 'invalid_name' | 'limit_reached' | 'not_found';
  constructor(reason: FunnelValidationError['reason']) {
    super(reason);
    this.reason = reason;
  }
}

export async function listFunnels(config: ServerConfig, workspaceId: string): Promise<FunnelRow[]> {
  const sb = getServiceClient(config);
  const { data, error } = await sb.from('web_analytics_funnels').select('*').eq('workspace_id', workspaceId).order('created_at', { ascending: false });
  if (error) throw new Error(`list_funnels_failed: ${error.message}`);
  return (data || []) as FunnelRow[];
}

export async function createFunnel(
  config: ServerConfig, args: { workspaceId: string; name: string; steps: unknown[]; userId: string; maxFunnels: number },
): Promise<FunnelRow> {
  const name = args.name.trim().slice(0, 200);
  if (!name) throw new FunnelValidationError('invalid_name');
  if (!Array.isArray(args.steps) || args.steps.length < 2 || args.steps.length > 10 || !args.steps.every(isValidStep)) {
    throw new FunnelValidationError('invalid_steps');
  }
  const sb = getServiceClient(config);
  const { count } = await sb.from('web_analytics_funnels').select('id', { count: 'exact', head: true }).eq('workspace_id', args.workspaceId);
  if ((count || 0) >= args.maxFunnels) throw new FunnelValidationError('limit_reached');

  const { data, error } = await sb.from('web_analytics_funnels').insert({
    workspace_id: args.workspaceId,
    name,
    steps: args.steps,
    created_by: args.userId,
  }).select('*').single();
  if (error || !data) throw new Error(`create_funnel_failed: ${error?.message}`);
  return data as FunnelRow;
}

export async function deleteFunnel(config: ServerConfig, workspaceId: string, funnelId: string): Promise<void> {
  const sb = getServiceClient(config);
  await sb.from('web_analytics_funnels').delete().eq('workspace_id', workspaceId).eq('id', funnelId);
}

export interface FunnelStepResult {
  label: string;
  sessions: number;
  conversionFromPrevious: number;
  conversionFromStart: number;
}

export async function computeFunnel(
  config: ServerConfig, workspaceId: string, funnelId: string, range: DateRange,
): Promise<{ funnel: FunnelRow; results: FunnelStepResult[] } | null> {
  const sb = getServiceClient(config);
  const { data: funnelRow, error: funnelError } = await sb
    .from('web_analytics_funnels').select('*').eq('workspace_id', workspaceId).eq('id', funnelId).maybeSingle();
  if (funnelError) throw new Error(`get_funnel_failed: ${funnelError.message}`);
  if (!funnelRow) return null;
  const funnel = funnelRow as FunnelRow;
  const steps = funnel.steps;

  const { startIso, endIso } = rangeToTimestamps(range);
  const [pageViewsRes, eventsRes] = await Promise.all([
    sb.from('visitor_page_views').select('visitor_session_id, url, viewed_at').eq('workspace_id', workspaceId).gte('viewed_at', startIso).lte('viewed_at', endIso).limit(ROW_CAP),
    sb.from('web_analytics_events').select('visitor_session_id, event_name, created_at').eq('workspace_id', workspaceId).gte('created_at', startIso).lte('created_at', endIso).limit(ROW_CAP),
  ]);
  if (pageViewsRes.error) throw new Error(`funnel_page_views_query_failed: ${pageViewsRes.error.message}`);
  if (eventsRes.error) throw new Error(`funnel_events_query_failed: ${eventsRes.error.message}`);

  type TimelineEntry = { type: 'pageview' | 'event'; value: string; at: string };
  const bySession = new Map<string, TimelineEntry[]>();
  for (const pv of (pageViewsRes.data || []) as Array<{ visitor_session_id: string; url: string; viewed_at: string }>) {
    const list = bySession.get(pv.visitor_session_id) || [];
    list.push({ type: 'pageview', value: normalizePath(pv.url), at: pv.viewed_at });
    bySession.set(pv.visitor_session_id, list);
  }
  for (const e of (eventsRes.data || []) as Array<{ visitor_session_id: string | null; event_name: string; created_at: string }>) {
    if (!e.visitor_session_id) continue;
    const list = bySession.get(e.visitor_session_id) || [];
    list.push({ type: 'event', value: e.event_name, at: e.created_at });
    bySession.set(e.visitor_session_id, list);
  }
  for (const list of bySession.values()) list.sort((a, b) => (a.at < b.at ? -1 : 1));

  function stepMatches(step: FunnelStep, entry: TimelineEntry): boolean {
    if (step.type === 'event') return entry.type === 'event' && entry.value === step.eventName;
    if (entry.type !== 'pageview') return false;
    return step.matcher === 'exact' ? entry.value === step.value : entry.value.includes(step.value);
  }

  const stepSessionCounts: number[] = new Array(steps.length).fill(0);
  for (const timeline of bySession.values()) {
    let cursor = -1;
    let matchedThrough = 0;
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const foundIndex = timeline.findIndex((entry, idx) => idx > cursor && stepMatches(step, entry));
      if (foundIndex === -1) break;
      cursor = foundIndex;
      matchedThrough = i + 1;
    }
    for (let i = 0; i < matchedThrough; i++) stepSessionCounts[i] += 1;
  }

  const startCount = stepSessionCounts[0] || 0;
  const results: FunnelStepResult[] = steps.map((step, i) => ({
    label: step.label || (step.type === 'event' ? step.eventName : step.value),
    sessions: stepSessionCounts[i],
    conversionFromPrevious: i === 0 ? 100 : stepSessionCounts[i - 1] > 0 ? Math.round((stepSessionCounts[i] / stepSessionCounts[i - 1]) * 1000) / 10 : 0,
    conversionFromStart: startCount > 0 ? Math.round((stepSessionCounts[i] / startCount) * 1000) / 10 : 0,
  }));

  return { funnel, results };
}
