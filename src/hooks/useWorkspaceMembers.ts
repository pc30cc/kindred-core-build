/**
 * Phase 3 — Workspace member directory for the assignee dropdown.
 *
 * Returns the union of (workspace_members JOIN profiles) so the UI can
 * display avatar + name + email and select a uuid for assigned_to.
 *
 * Reuses GET /api/workspace-members (gs_session cookie + service_role,
 * server/routes/workspaceMembers.ts) rather than direct supabase.from()
 * calls — the dashboard's browser session no longer carries a Supabase
 * Auth JWT, so auth.uid()-scoped RLS on a direct query would silently
 * return nothing. Same any-member read access as before.
 */

import { useQuery } from '@tanstack/react-query';
import { API_BASE as RESOLVED_API_BASE } from '@/lib/apiBase';

const API_BASE = RESOLVED_API_BASE;

export interface WorkspaceMember {
  user_id: string;
  role: string;
  full_name: string | null;
  email: string | null;
  avatar_url: string | null;
  /** When they joined the workspace (the widget's team is its first four to join, shared/widgetTeam.ts). */
  created_at: string | null;
  /** Suspended by the owner: keeps history, takes no chats. */
  suspended_at?: string | null;
  /** The plan paused this seat (billing locks): cannot open a chat. */
  seat_locked?: boolean;
  /** The departments they are in, by name. */
  department_names?: string[];
}

/** A row of GET /api/workspace-members, as far as this hook reads it. */
interface MemberRow {
  user_id: string;
  role: string;
  created_at?: string | null;
  suspended_at?: string | null;
  seat_locked?: boolean | null;
  department_names?: string[] | null;
  profile?: { full_name?: string | null; email?: string | null; avatar_url?: string | null } | null;
}

export function useWorkspaceMembers(workspaceId: string | undefined) {
  return useQuery({
    queryKey: ['workspace-members', workspaceId],
    queryFn: async (): Promise<WorkspaceMember[]> => {
      const res = await fetch(`${API_BASE}/api/workspace-members?workspaceId=${workspaceId}`, { credentials: 'include' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(body.error || `API error: ${res.status}`);
      }
      const { members } = (await res.json()) as { members?: MemberRow[] | null };
      return (members ?? []).map((m) => ({
        user_id: m.user_id,
        role: m.role,
        full_name: m.profile?.full_name ?? null,
        email: m.profile?.email ?? null,
        avatar_url: m.profile?.avatar_url ?? null,
        created_at: m.created_at ?? null,
        suspended_at: m.suspended_at ?? null,
        seat_locked: m.seat_locked === true,
        department_names: Array.isArray(m.department_names) ? m.department_names : [],
      }));
    },
    enabled: !!workspaceId,
    staleTime: 60_000,
  });
}
