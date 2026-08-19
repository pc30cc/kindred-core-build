import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';

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

export function useSecurityStats() {
  return useQuery({
    queryKey: ['admin-security-stats'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('admin_security_stats');
      if (error) throw error;
      return data as {
        total_events_24h: number;
        failed_logins_24h: number;
        rate_limited_24h: number;
        captcha_failed_24h: number;
        blocked_ips: number;
        brute_force_24h: number;
        abuse_detected_24h: number;
        critical_events_24h: number;
        unresolved_events: number;
      };
    },
    refetchInterval: 30_000,
  });
}

export function useSecurityEvents(limit = 100) {
  return useQuery({
    queryKey: ['admin-security-events', limit],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('security_events')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(limit);
      if (error) throw error;
      return data as SecurityEvent[];
    },
    refetchInterval: 30_000,
  });
}

export function useBlockedIPs() {
  return useQuery({
    queryKey: ['admin-blocked-ips'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('ip_blocklist')
        .select('*')
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data as BlockedIP[];
    },
  });
}

export function useBlockIP() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ ip, reason }: { ip: string; reason: string }) => {
      const { error } = await supabase.from('ip_blocklist').insert({
        ip_address: ip,
        reason,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-blocked-ips'] });
      qc.invalidateQueries({ queryKey: ['admin-security-stats'] });
    },
  });
}

export function useUnblockIP() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('ip_blocklist').delete().eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-blocked-ips'] });
      qc.invalidateQueries({ queryKey: ['admin-security-stats'] });
    },
  });
}

export function useResolveSecurityEvent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (eventId: string) => {
      const { error } = await supabase
        .from('security_events')
        .update({ resolved: true, resolved_at: new Date().toISOString() })
        .eq('id', eventId);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-security-events'] });
      qc.invalidateQueries({ queryKey: ['admin-security-stats'] });
    },
  });
}

// Log security event from frontend via self-hosted backend
const API_BASE = import.meta.env.VITE_API_BASE_URL;

export async function logClientSecurityEvent(
  eventType: string,
  severity: 'info' | 'warn' | 'error' | 'critical',
  metadata: Record<string, any> = {}
) {
  if (!API_BASE) return; // No backend configured — skip silently
  try {
    await fetch(`${API_BASE}/api/auth/record-result`, {credentials: 'include', 
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
