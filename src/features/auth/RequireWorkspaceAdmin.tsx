/**
 * Route guard — workspace owner/admin only.
 *
 * Operators (agent/viewer/etc.) are not merely hidden from these surfaces in
 * the navigation: any direct URL access is redirected back to the workspace
 * overview, so the pages never mount and their data queries never fire.
 */
import { Navigate } from 'react-router-dom';
import { useCurrentWorkspace, useWorkspacePath } from '@/hooks/useWorkspace';
import { useWorkspaceRole, isWorkspaceAdmin } from '@/hooks/useWorkspaceRole';

export function RequireWorkspaceAdmin({ children }: { children: React.ReactNode }) {
  const workspace = useCurrentWorkspace();
  const wsPath = useWorkspacePath();
  const { data: role, isPending } = useWorkspaceRole(workspace?.id);

  if (!workspace?.id || isPending) return <div className="h-full w-full" />;
  if (!isWorkspaceAdmin(role)) return <Navigate to={wsPath('/')} replace />;
  return <>{children}</>;
}
