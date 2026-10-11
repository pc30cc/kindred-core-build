/**
 * Seats the plan has paused (simple billing phase 4, design §5): the
 * server's answer, read as is. See src/components/members/SeatLocked.tsx.
 */
import { useQuery } from '@tanstack/react-query';
import { API_BASE as RESOLVED_API_BASE } from '@/lib/apiBase';

const API_BASE = RESOLVED_API_BASE;

/** A member row of GET /api/workspace-members, as far as the pause goes. */
export interface SeatLockable {
  seat_locked?: boolean | null;
}

/** Whether the server says this member's seat is paused by the plan. */
export function isSeatLocked(member: SeatLockable | null | undefined): boolean {
  return member?.seat_locked === true;
}

export interface OwnSeat {
  user_id: string;
  role: string | null;
  seat_locked: boolean;
}

/**
 * GET /api/workspace-members/me: the caller's own seat in the workspace —
 * the one workspace read a paused member still gets. Null when unreadable.
 */
export function useOwnSeat(workspaceId: string | null | undefined) {
  return useQuery({
    queryKey: ['workspace-own-seat', workspaceId],
    queryFn: async (): Promise<OwnSeat | null> => {
      const res = await fetch(`${API_BASE}/api/workspace-members/me?workspaceId=${workspaceId}`, {
        credentials: 'include',
        cache: 'no-store',
      });
      if (!res.ok) return null;
      return (await res.json()) as OwnSeat;
    },
    enabled: !!workspaceId,
    staleTime: 60_000,
  });
}
