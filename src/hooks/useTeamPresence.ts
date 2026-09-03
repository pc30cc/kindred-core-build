/**
 * Team presence — live operator availability for a workspace.
 *
 * Hits the self-hosted Express endpoint
 *   GET /api/availability/team/:workspaceId
 * which derives status from `user_availability_prefs` for every member.
 *
 * Polled every 10s (cheap, server-computed, no realtime subscription
 * needed for this slice). Components can also call `refetch()` after
 * the operator changes their own availability to refresh immediately.
 */

import { useQuery } from '@tanstack/react-query';
import {
  fetchTeamPresence,
  type OperatorPresence,
  type OperatorState,
} from '@/lib/availability-api';

export type { OperatorPresence, OperatorState };

export function useTeamPresence(workspaceId: string | undefined) {
  return useQuery({
    queryKey: ['team-presence', workspaceId],
    queryFn: () => fetchTeamPresence(workspaceId!),
    enabled: !!workspaceId,
    // Near-realtime: presence is heartbeat-driven, so poll fast and refresh
    // whenever the operator comes back to the tab.
    refetchInterval: 10_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    staleTime: 5_000,
  });
}

/**
 * Build a fast lookup map keyed by user_id for components that render
 * many member rows.
 */
export function presenceMap(list: OperatorPresence[] | undefined | null) {
  const m = new Map<string, OperatorPresence>();
  if (!Array.isArray(list)) return m;
  for (const p of list) if (p?.user_id) m.set(p.user_id, p);
  return m;
}