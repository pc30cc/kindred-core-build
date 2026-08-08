/**
 * useVisitorNetwork — the ONE client read for a visitor's IP + geo.
 *
 * Every operator surface (Inbox, Call Center, Callbacks, Visitors drawer)
 * calls the same endpoint with whichever handle it has, so no two screens can
 * ever disagree about a visitor's IP or country. The raw-IP privacy and plan
 * gates are enforced server-side — the browser only receives what the viewer
 * is allowed to see.
 */
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';

const API_BASE = import.meta.env.VITE_API_BASE_URL || '';

export interface VisitorNetworkProfile {
  visitor_session_id: string;
  visitor_id: string | null;
  workspace_id: string;
  ip: { raw: string | null; display: string; hash: string | null; locked: boolean; can_view_raw: boolean };
  geo: {
    country_code: string | null;
    country: string | null;
    region: string | null;
    city: string | null;
    latitude: number | null;
    longitude: number | null;
    timezone: string | null;
    source: 'persisted' | 'cache' | 'provider' | 'centroid' | 'session' | 'none';
    provider: string | null;
    accuracy_level: 'city' | 'region' | 'country' | null;
    is_fallback: boolean;
    resolved_at: string | null;
  };
  device: { browser: string | null; os: string | null; device: string | null };
}

export type VisitorNetworkRef =
  | { sessionId: string | null | undefined }
  | { conversationId: string | null | undefined }
  | { callSessionId: string | null | undefined }
  | { callbackId: string | null | undefined };

function toParam(ref: VisitorNetworkRef): [string, string] | null {
  const r = ref as Record<string, string | null | undefined>;
  if (r.sessionId) return ['session_id', r.sessionId];
  if (r.conversationId) return ['conversation_id', r.conversationId];
  if (r.callSessionId) return ['call_session_id', r.callSessionId];
  if (r.callbackId) return ['callback_id', r.callbackId];
  return null;
}

export function useVisitorNetwork(workspaceId: string | undefined, ref: VisitorNetworkRef) {
  const param = toParam(ref);
  return useQuery<VisitorNetworkProfile | null>({
    queryKey: ['visitor-network', workspaceId, param?.[0], param?.[1]],
    enabled: !!workspaceId && !!param,
    staleTime: 60_000,
    retry: false,
    queryFn: async () => {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      const qs = new URLSearchParams({ workspace_id: workspaceId!, [param![0]]: param![1] });
      const res = await fetch(`${API_BASE}/api/visitor-intel/network?${qs.toString()}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error(`network lookup failed: ${res.status}`);
      const body = await res.json();
      return (body?.profile as VisitorNetworkProfile | null) ?? null;
    },
  });
}

/** 'TR' → '🇹🇷'. Presentation-only mirror of the server helper. */
export function flagEmoji(code: string | null | undefined): string {
  if (!code || !/^[A-Za-z]{2}$/.test(code)) return '';
  const A = 0x1f1e6;
  const base = 'A'.charCodeAt(0);
  const cc = code.toUpperCase();
  return String.fromCodePoint(A + cc.charCodeAt(0) - base) + String.fromCodePoint(A + cc.charCodeAt(1) - base);
}
