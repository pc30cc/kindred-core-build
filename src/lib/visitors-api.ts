/**
 * Visitor Intelligence API client.
 * Talks to the new /api/visitor-intel/* backend routes (auth + membership enforced).
 */
import { supabase } from '@/lib/supabase';

const API_BASE = import.meta.env.VITE_API_BASE_URL || '';

async function authHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data?.session?.access_token || '';
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {credentials: 'include', headers: await authHeaders() });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || `API error: ${res.status}`);
  }
  return res.json();
}

export interface VisitorGeo {
  country: string | null;
  country_code: string | null;
  region: string | null;
  city: string | null;
  latitude: number | null;
  longitude: number | null;
  source: 'cache' | 'provider' | 'centroid' | 'session' | 'disabled' | 'none';
}

export interface VisitorIntelItem {
  id: string;
  visitor_id: string;
  workspace_id: string;
  status: 'online' | 'idle' | 'offline' | 'unknown';
  current_page: string | null;
  last_activity_at: string;
  started_at: string;
  browser: string | null;
  device: string | null;
  os: string | null;
  referrer: string | null;
  geo: VisitorGeo;
  /** Always present — masked or hash-derived placeholder. Safe for any role. */
  ip_display: string;
  /** Raw IP — populated only when can_view_raw_ip is true AND backend has it. */
  ip_raw: string | null;
  /** Whether the requester (workspace role) is allowed to see the raw IP. */
  can_view_raw_ip: boolean;
  /** True when the workspace plan does not include IP visibility — no IP is sent. */
  ip_locked?: boolean;
  contact: { id: string; name: string | null; email: string | null; avatar_url: string | null; visitor_code?: string | null; metadata?: Record<string, unknown> | null } | null;
  conversation: { id: string; status: string | null; subject: string | null } | null;
}

export interface MapTilesConfig {
  enabled: boolean;
  provider: string;
  tile_url: string | null;
  attribution: string;
  max_zoom: number;
  min_zoom: number;
  fallback_no_map: boolean;
  // Observability fields (added in hardening pass)
  requested_provider?: string | null;
  resolved_provider?: string;
  fallback_provider?: string | null;
  fallback_reason?: string | null;
  health_status?: 'healthy' | 'unconfigured' | 'fallback' | 'disabled';
  // Display + initial framing — populated by /map-config
  display?: { height_px: number; fill_viewport: boolean };
  default_center?: { lat: number; lng: number; zoom: number; mode: 'auto' | 'fixed' };
  /** Realtime cadence — drives polling intervals on the Visitors page. */
  presence?: { heartbeat_interval_ms: number; live_refresh_ms: number; stale_after_ms: number };
}

export interface MapMarker {
  id: string;
  status: VisitorIntelItem['status'];
  lat: number;
  lng: number;
  country: string | null;
  country_code: string | null;
  city: string | null;
  current_page: string | null;
  source: VisitorGeo['source'];
  /** ISO timestamp of last presence/page activity — drives "x min ago" in tooltip. */
  last_activity_at?: string;
}

export function fetchLiveVisitors(workspaceId: string, includeOffline = false) {
  const q = new URLSearchParams({ workspace_id: workspaceId });
  if (includeOffline) q.set('include_offline', '1');
  return get<{ items: VisitorIntelItem[] }>(`/api/visitor-intel/live?${q}`);
}

export function fetchVisitorMap(workspaceId: string) {
  const q = new URLSearchParams({ workspace_id: workspaceId });
  return get<{
    markers: MapMarker[];
    total: number;
    without_location: number;
    source_counts: { precise: number; approximate: number; unavailable: number; disabled?: number };
  }>(
    `/api/visitor-intel/map?${q}`,
  );
}

export function fetchVisitorMapConfig(workspaceId: string) {
  const q = new URLSearchParams({ workspace_id: workspaceId });
  return get<MapTilesConfig>(`/api/visitor-intel/map-config?${q}`);
}

export function fetchVisitorDetail(workspaceId: string, sessionId: string) {
  const q = new URLSearchParams({ workspace_id: workspaceId });
  return get<VisitorIntelItem>(`/api/visitor-intel/${sessionId}?${q}`);
}

export interface VisitorPageView {
  id: number;
  url: string;
  title: string | null;
  viewed_at: string;
}

export interface VisitorPageHistoryEntry {
  landing_url: string | null;
  landing_title: string | null;
  landed_at: string | null;
  referrer: string | null;
}

export interface VisitorPageHistoryCurrent {
  url: string;
  title: string | null;
  viewed_at: string | null;
}

export function fetchVisitorPageHistory(
  workspaceId: string,
  sessionId: string,
  limit = 20,
) {
  const q = new URLSearchParams({ workspace_id: workspaceId, limit: String(limit) });
  return get<{
    items: VisitorPageView[];
    entry: VisitorPageHistoryEntry | null;
    current: VisitorPageHistoryCurrent | null;
  }>(
    `/api/visitor-intel/${sessionId}/page-history?${q}`,
  );
}

// ────────────────────────────────────────────────────────────────────
// Admin: warm visitor geo cache through the active provider.
// Bounded server-side (admin role + cooldown + lookback/limit caps).
// ────────────────────────────────────────────────────────────────────
export interface WarmGeoResult {
  status: 'ok' | 'noop';
  provider: string | null;
  reason?: 'provider_disabled' | 'provider_unconfigured';
  lookback_days?: number;
  processed: number;
  enriched: number;
  cached: number;
  centroid: number;
  skipped: number;
  failed: number;
}

export async function warmVisitorGeo(
  workspaceId: string,
  opts: { lookback_days?: number; limit?: number; force?: boolean } = {},
): Promise<WarmGeoResult> {
  const res = await fetch(`${API_BASE}/api/visitor-intel/warm-geo`, {credentials: 'include', 
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
    body: JSON.stringify({ workspace_id: workspaceId, ...opts }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || `API error: ${res.status}`);
  }
  return res.json();
}