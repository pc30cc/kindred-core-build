/**
 * WorkspaceRedirect: Redirects /app to /app/w/:slug using the user's first workspace.
 */
import { Navigate } from 'react-router-dom';
import { useWorkspaces } from '@/hooks/useWorkspace';
import { useAuth } from '@/features/auth/AuthContext';
import { Button } from '@/components/ui/button';
import { Building2, LogOut, RefreshCw, HeadsetIcon } from 'lucide-react';

export function WorkspaceRedirect() {
  const { data: workspaces, isLoading, refetch } = useWorkspaces();
  const { signOut } = useAuth();

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-4">
          <div className="relative">
            <div className="h-12 w-12 rounded-xl bg-primary/10 flex items-center justify-center">
              <Building2 className="h-6 w-6 text-primary animate-pulse" />
            </div>
          </div>
          <p className="text-sm text-muted-foreground">Loading workspaces…</p>
        </div>
      </div>
    );
  }

  if (workspaces?.length) {
    return <Navigate to={`/app/w/${workspaces[0].slug}`} replace />;
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="w-full max-w-md text-center space-y-6">
        {/* Icon */}
        <div className="mx-auto w-20 h-20 rounded-2xl bg-muted flex items-center justify-center">
          <Building2 className="h-10 w-10 text-muted-foreground/60" />
        </div>

        {/* Text */}
        <div className="space-y-2">
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            No workspace found
          </h1>
          <p className="text-muted-foreground text-sm leading-relaxed max-w-sm mx-auto">
            It looks like your account doesn't have a workspace yet. This might be a temporary issue — try refreshing or contact support if the problem persists.
          </p>
        </div>

        {/* Actions */}
        <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
          <Button
            variant="default"
            onClick={() => refetch()}
            className="w-full sm:w-auto gap-2"
          >
            <RefreshCw className="h-4 w-4" />
            Try again
          </Button>
          <Button
            variant="outline"
            onClick={() => signOut()}
            className="w-full sm:w-auto gap-2"
          >
            <LogOut className="h-4 w-4" />
            Sign out
          </Button>
        </div>

        {/* Support hint */}
        <div className="pt-4 border-t border-border">
          <p className="text-xs text-muted-foreground flex items-center justify-center gap-1.5">
            <HeadsetIcon className="h-3.5 w-3.5" />
            Need help? Contact your administrator.
          </p>
        </div>
      </div>
    </div>
  );
}
