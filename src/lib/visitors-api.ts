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
  const res = await fetch(`${API_BASE}${path}`, { headers: await authHeaders() });
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
  source: 'cache' | 'provider' | 'centroid' | 'session' | 'none';
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
  contact: { id: string; name: string | null; email: string | null; avatar_url: string | null } | null;
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
}

export function fetchLiveVisitors(workspaceId: string, includeOffline = false) {
  const q = new URLSearchParams({ workspace_id: workspaceId });
  if (includeOffline) q.set('include_offline', '1');
  return get<{ items: VisitorIntelItem[] }>(`/api/visitor-intel/live?${q}`);
}

export function fetchVisitorMap(workspaceId: string) {
  const q = new URLSearchParams({ workspace_id: workspaceId });
  return get<{ markers: MapMarker[]; total: number }>(`/api/visitor-intel/map?${q}`);
}

export function fetchVisitorMapConfig(workspaceId: string) {
  const q = new URLSearchParams({ workspace_id: workspaceId });
  return get<MapTilesConfig>(`/api/visitor-intel/map-config?${q}`);
}

export function fetchVisitorDetail(workspaceId: string, sessionId: string) {
  const q = new URLSearchParams({ workspace_id: workspaceId });
  return get<VisitorIntelItem>(`/api/visitor-intel/${sessionId}?${q}`);
}