import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { API_BASE } from '@/lib/api';

export interface SecurityEvent {
  id: string;
  event_type: string;
  severity: string;
  ip_address: string | null;
  user_id: string | null;
  user_email: string | null;
  workspace_id: string | null;
  endpoint: string | null;
  metadata: Record<string, any>;
  resolved: boolean;
  resolved_at: string | null;
  resolved_by: string | null;
  created_at: string;
}

export interface BlockedIP {
  id: string;
  ip_address: string;
  reason: string;
  blocked_by: string | null;
  blocked_until: string | null;
  created_at: string;
}

async function adminFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}/api/admin${path}`, {
    credentials: 'include',
    ...options,
    headers: { 'Content-Type': 'application/json', ...options?.headers },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed: ${res.status}`);
  return body as T;
}

export function useSecurityStats() {
  return useQuery({
    queryKey: ['admin-security-stats'],
    queryFn: () => adminFetch<{
      total_events_24h: number;
      failed_logins_24h: number;
      rate_limited_24h: number;
      captcha_failed_24h: number;
      blocked_ips: number;
      brute_force_24h: number;
      abuse_detected_24h: number;
      critical_events_24h: number;
      unresolved_events: number;
    }>('/security/stats'),
    refetchInterval: 30_000,
  });
}

export function useSecurityEvents(limit = 100) {
  return useQuery({
    queryKey: ['admin-security-events', limit],
    queryFn: async () => {
      const { events } = await adminFetch<{ events: SecurityEvent[] }>(`/security/events?limit=${limit}`);
      return events;
    },
    refetchInterval: 30_000,
  });
}

export function useBlockedIPs() {
  return useQuery({
    queryKey: ['admin-blocked-ips'],
    queryFn: async () => {
      const { ips } = await adminFetch<{ ips: BlockedIP[] }>('/security/blocked-ips');
      return ips;
    },
  });
}

export function useBlockIP() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ ip, reason }: { ip: string; reason: string }) =>
      adminFetch('/security/blocked-ips', { method: 'POST', body: JSON.stringify({ ip, reason }) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-blocked-ips'] });
      qc.invalidateQueries({ queryKey: ['admin-security-stats'] });
    },
  });
}

export function useUnblockIP() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => adminFetch(`/security/blocked-ips/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-blocked-ips'] });
      qc.invalidateQueries({ queryKey: ['admin-security-stats'] });
    },
  });
}

export function useResolveSecurityEvent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (eventId: string) => adminFetch(`/security/events/${eventId}/resolve`, { method: 'POST' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-security-events'] });
      qc.invalidateQueries({ queryKey: ['admin-security-stats'] });
    },
  });
}

// Log security event from frontend via self-hosted backend
const CLIENT_API_BASE = import.meta.env.VITE_API_BASE_URL;

export async function logClientSecurityEvent(
  eventType: string,
  severity: 'info' | 'warn' | 'error' | 'critical',
  metadata: Record<string, any> = {}
) {
  if (!CLIENT_API_BASE) return; // No backend configured — skip silently
  try {
    await fetch(`${CLIENT_API_BASE}/api/auth/record-result`, {credentials: 'include',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: metadata.email || 'unknown',
        success: false,
        eventType,
        severity,
        metadata,
      }),
    });
  } catch {
    // Silently fail — security logging should not break UX
  }
}
