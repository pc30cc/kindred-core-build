/**
 * WorkspaceRedirect: Redirects /app to /app/w/:slug using the user's first workspace.
 * If no workspaces exist, shows a loading state (shouldn't happen since signup auto-provisions).
 */
import { Navigate } from 'react-router-dom';
import { useWorkspaces } from '@/hooks/useWorkspace';

export function WorkspaceRedirect() {
  const { data: workspaces, isLoading } = useWorkspaces();

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  if (workspaces?.length) {
    return <Navigate to={`/app/w/${workspaces[0].slug}`} replace />;
  }

  // Fallback — should not happen with auto-provisioning
  return (
    <div className="flex min-h-screen items-center justify-center">
      <p className="text-muted-foreground">No workspace found. Please contact support.</p>
    </div>
  );
}
