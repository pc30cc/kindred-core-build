import { useAuth } from '@/features/auth/AuthContext';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useParams, useNavigate } from 'react-router-dom';
import { useMemo, useCallback } from 'react';
import type { Workspace, Account } from '@/types/models';

const API_BASE = import.meta.env.VITE_API_BASE_URL;

async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { credentials: 'include' });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || `API error: ${res.status}`);
  }
  return res.json();
}

/**
 * Fetch all workspaces the current user is a member of.
 *
 * Resolved via the first-party backend (GET /api/workspaces), not a direct
 * `supabase.from('workspaces')` query — this app's browser session no
 * longer carries a Supabase Auth JWT, so `auth.uid()`-scoped RLS on a
 * direct query would silently return zero rows for every user. This is
 * THE hook the whole dashboard's routing depends on to resolve which
 * workspace to enter, so it goes through requireUser +
 * service_role on the backend instead.
 */
export function useWorkspaces() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['workspaces', user?.id],
    queryFn: async () => {
      const { workspaces } = await apiGet<{ workspaces: Workspace[] }>('/api/workspaces');
      return workspaces;
    },
    enabled: !!user,
  });
}

/**
 * Route-based active workspace — STRICT resolution.
 * Reads :slug from /app/w/:slug/* and resolves against user's workspaces.
 * Returns `notFound: true` if slug doesn't match any workspace the user has access to.
 * NEVER falls back to a different workspace.
 */
export function useActiveWorkspace() {
  const { slug } = useParams<{ slug: string }>();
  const { data: workspaces, isLoading } = useWorkspaces();

  const result = useMemo(() => {
    if (!workspaces || isLoading) return { workspace: null, notFound: false };
    if (!slug) return { workspace: null, notFound: false };

    const match = workspaces.find(w => w.slug === slug);
    if (!match) return { workspace: null, notFound: true };
    return { workspace: match, notFound: false };
  }, [workspaces, slug, isLoading]);

  return { ...result, workspaces: workspaces ?? [], isLoading };
}

/** @deprecated Use useActiveWorkspace instead */
export function useCurrentWorkspace() {
  const { workspace } = useActiveWorkspace();
  return workspace;
}

/** Build a workspace-scoped path */
export function useWorkspacePath() {
  const { workspace } = useActiveWorkspace();
  return useCallback(
    (path: string) => workspace ? `/app/w/${workspace.slug}${path}` : `/app${path}`,
    [workspace]
  );
}

/** Create a workspace atomically via the backend (POST /api/workspaces). */
export function useCreateWorkspace() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async ({ accountId, name }: { accountId: string; name: string }) => {
      const res = await fetch(`${API_BASE}/api/workspaces`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId, name }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(body.error || `API error: ${res.status}`);
      }
      const { workspaceId } = await res.json();
      return workspaceId as string;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['workspaces'] }),
  });
}

/** Fetch the user's account (GET /api/workspaces/account) — see useWorkspaces() for why this doesn't query Supabase directly. */
export function useAccount() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['account', user?.id],
    queryFn: async () => {
      const { account } = await apiGet<{ account: Account }>('/api/workspaces/account');
      return account;
    },
    enabled: !!user,
  });
}
