import { API_BASE as RESOLVED_API_BASE } from '@/lib/apiBase';
/**
 * User availability API — self-hosted Express endpoint.
 * Always sends a fresh Supabase JWT to avoid stale tokens.
 */

const API_BASE = RESOLVED_API_BASE;

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((init?.headers as Record<string, string>) || {}),
  };
  const res = await fetch(`${API_BASE}${path}`, {credentials: 'include', ...init, headers });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as any)?.error || `Request failed: ${res.status}`);
  return body as T;
}

export interface AvailabilityInterval {
  from: string; // HH:mm
  to: string;
}

export interface AvailabilityDay {
  enabled: boolean;
  intervals: AvailabilityInterval[];
}

export type DayKey = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

export type WeeklySchedule = Record<DayKey, AvailabilityDay>;

export interface AvailabilityPrefs {
  force_offline: boolean;
  available_when_using_app: boolean;
  schedule_enabled: boolean;
  timezone: string;
  weekly_schedule: WeeklySchedule;
}

export interface LiveStatus {
  state: 'online' | 'offline';
  reason: string;
}

export interface AvailabilityResponse {
  prefs: AvailabilityPrefs;
  status: LiveStatus;
}

/**
 * `locale` lets the server pick a sensible default timezone for operators who
 * have never saved one (fa → Asia/Tehran, tr → Europe/Istanbul, else UTC).
 */
export function fetchAvailability(locale?: string) {
  const qs = locale ? `?locale=${encodeURIComponent(locale)}` : '';
  return request<AvailabilityResponse>(`/api/availability${qs}`);
}

export function updateAvailability(updates: Partial<AvailabilityPrefs>) {
  return request<AvailabilityResponse>('/api/availability', {
    method: 'PATCH',
    body: JSON.stringify(updates),
  });
}

// ── Team presence ───────────────────────────────────────────────

export type OperatorState = 'online' | 'offline';

export interface OperatorPresence {
  user_id: string;
  state: OperatorState;
  reason: string;
}

export interface TeamPresenceResponse {
  presence: OperatorPresence[];
  fetched_at: string;
}

export function fetchTeamPresence(workspaceId: string) {
  return request<TeamPresenceResponse>(`/api/availability/team/${workspaceId}`);
}