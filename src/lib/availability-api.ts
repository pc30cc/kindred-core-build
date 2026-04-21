/**
 * User availability API — self-hosted Express endpoint.
 * Always sends a fresh Supabase JWT to avoid stale tokens.
 */
import { supabase } from '@/lib/supabase';

const API_BASE = import.meta.env.VITE_API_BASE_URL;

async function authHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data?.session?.access_token || '';
  return { Authorization: `Bearer ${token}` };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(await authHeaders()),
    ...((init?.headers as Record<string, string>) || {}),
  };
  const res = await fetch(`${API_BASE}${path}`, { ...init, headers });
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

export function fetchAvailability() {
  return request<AvailabilityResponse>('/api/availability');
}

export function updateAvailability(updates: Partial<AvailabilityPrefs>) {
  return request<AvailabilityResponse>('/api/availability', {
    method: 'PATCH',
    body: JSON.stringify(updates),
  });
}