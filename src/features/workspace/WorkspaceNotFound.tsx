/**
 * Shown when the URL slug doesn't match any workspace the user has access to.
 */
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { ShieldX, ArrowLeft } from 'lucide-react';

export function WorkspaceNotFound() {
  const navigate = useNavigate();

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="w-full max-w-md text-center space-y-6">
        <div className="mx-auto w-20 h-20 rounded-2xl bg-destructive/10 flex items-center justify-center">
          <ShieldX className="h-10 w-10 text-destructive/60" />
        </div>
        <div className="space-y-2">
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            Workspace not found
          </h1>
          <p className="text-muted-foreground text-sm leading-relaxed max-w-sm mx-auto">
            This workspace doesn't exist or you don't have access to it. Check the URL or go back to your workspaces.
          </p>
        </div>
        <Button onClick={() => navigate('/app')} className="gap-2">
          <ArrowLeft className="h-4 w-4" />
          Go to my workspaces
        </Button>
      </div>
    </div>
  );
}
