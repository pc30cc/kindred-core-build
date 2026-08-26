/**
 * Visitor presence by conversation — Phase 1.
 *
 * Returns the latest visitor_presence row for the visitor session linked to
 * a given conversation. Polled every 10s so it stays correct even when the
 * realtime transport is unavailable. Polling-safe by design.
 *
 * Routed through the authenticated backend (`/api/visitor-intel/presence-by-conversation`)
 * rather than a direct `supabase.from()` read — visitor_presence's RLS
 * requires `auth.uid()`, which the browser no longer carries.
 *
 * The query is intentionally tolerant: returns null when no session is
 * linked yet (e.g. anonymous conversations created via API).
 */
import { useQuery } from '@tanstack/react-query';
import { API_BASE } from '@/lib/api';
import type { VisitorPresence } from '@/types/models';

export interface VisitorPresenceInfo {
  status: VisitorPresence['status'] | 'unknown';
  current_page: string | null;
  updated_at: string | null;
}

export function useVisitorPresenceForConversation(
  workspaceId: string | undefined,
  conversationId: string | undefined,
) {
  return useQuery<VisitorPresenceInfo>({
    queryKey: ['visitor-presence-conv', workspaceId, conversationId],
    enabled: !!workspaceId && !!conversationId,
    refetchInterval: 10_000,
    queryFn: async () => {
      const params = new URLSearchParams({ workspace_id: workspaceId!, conversation_id: conversationId! });
      const res = await fetch(`${API_BASE}/api/visitor-intel/presence-by-conversation?${params}`, {
        credentials: 'include',
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `Presence load failed: ${res.status}`);
      if (body.status === 'unknown' || !body.updated_at) {
        return { status: 'unknown', current_page: body.current_page ?? null, updated_at: null };
      }
      // Auto-degrade to "offline" if the row is stale (last update > 90s ago).
      // Heartbeat cadence is roughly every 30s, so 90s is a safe threshold.
      const ts = new Date(body.updated_at).getTime();
      const stale = Date.now() - ts > 90_000;
      const effective: VisitorPresenceInfo['status'] = stale ? 'offline' : body.status;
      return {
        status: effective,
        current_page: body.current_page ?? null,
        updated_at: body.updated_at ?? null,
      };
    },
  });
}
