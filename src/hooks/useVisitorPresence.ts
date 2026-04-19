/**
 * Visitor presence by conversation — Phase 1.
 *
 * Returns the latest visitor_presence row for the visitor session linked to
 * a given conversation. Polled every 10s so it stays correct even when the
 * realtime transport is unavailable. Polling-safe by design.
 *
 *   conversations.visitor_session_id ──► visitor_sessions.id
 *                                       └─► visitor_presence.visitor_session_id
 *
 * The query is intentionally tolerant: returns null when no session is
 * linked yet (e.g. anonymous conversations created via API).
 */
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
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
      const { data: conv, error: convErr } = await supabase
        .from('conversations')
        .select('visitor_session_id')
        .eq('id', conversationId!)
        .maybeSingle();
      if (convErr) throw convErr;
      const sessionId = conv?.visitor_session_id;
      if (!sessionId) {
        return { status: 'unknown', current_page: null, updated_at: null };
      }
      const { data: presence, error: pErr } = await supabase
        .from('visitor_presence')
        .select('status, current_page, updated_at')
        .eq('workspace_id', workspaceId!)
        .eq('visitor_session_id', sessionId)
        .maybeSingle();
      if (pErr) throw pErr;
      if (!presence) {
        return { status: 'unknown', current_page: null, updated_at: null };
      }
      // Auto-degrade to "offline" if the row is stale (last update > 90s ago).
      // Heartbeat cadence is roughly every 30s, so 90s is a safe threshold.
      const ts = presence.updated_at ? new Date(presence.updated_at).getTime() : 0;
      const stale = Date.now() - ts > 90_000;
      const effective: VisitorPresenceInfo['status'] = stale
        ? 'offline'
        : (presence.status as VisitorPresence['status']);
      return {
        status: effective,
        current_page: presence.current_page ?? null,
        updated_at: presence.updated_at ?? null,
      };
    },
  });
}
