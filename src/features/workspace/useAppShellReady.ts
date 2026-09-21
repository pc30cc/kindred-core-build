/**
 * The panel's boot gate.
 *
 * Only three things block the first render of the dashboard:
 *   1. the signed-in user   (handled upstream by RequireAuth)
 *   2. the active workspace (so we never paint another workspace's chrome)
 *   3. the plan entitlements (so gated menus never flash in and then vanish)
 *
 * Nothing else waits. Data surfaces render their own skeletons.
 *
 * Two escape hatches keep the gate from ever becoming a dead end:
 *   • an entitlement error resolves the gate (the panel renders, the plan
 *     layer degrades to its own error/locked handling), and
 *   • a hard timeout resolves it regardless, so one slow endpoint can never
 *     leave the user staring at a skeleton forever.
 */
import { useEffect, useState } from 'react';
import { useWorkspaceEffectiveEntitlements } from '@/hooks/useEntitlements';

/** Upper bound on how long the shell is allowed to stay gated. */
export const APP_SHELL_BOOT_TIMEOUT_MS = 6000;

export function useAppShellReady(
  workspaceId: string | null | undefined,
  workspacesLoading: boolean,
): boolean {
  const { data, loading, error } = useWorkspaceEffectiveEntitlements(workspaceId);
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    const id = setTimeout(() => setTimedOut(true), APP_SHELL_BOOT_TIMEOUT_MS);
    return () => clearTimeout(id);
  }, []);

  if (timedOut) return true;
  if (workspacesLoading) return false;
  // No workspace in scope (route has no slug yet) — nothing plan-shaped to
  // wait for; the router decides what to show next.
  if (!workspaceId) return true;
  if (error) return true;
  return !loading && !!data;
}
