import { useAuth } from '@/features/auth/AuthContext';
import { useIsGlobalAdmin, useBootstrapAdmin } from '@/hooks/useAdmin';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Navigate } from 'react-router-dom';
import { toast } from '@/lib/toast';
import { Shield } from 'lucide-react';

export default function AdminBootstrapPage() {
  const { user, isLoading: authLoading } = useAuth();
  const { data: isAdmin, isLoading: roleLoading } = useIsGlobalAdmin();
  const bootstrap = useBootstrapAdmin();

  if (authLoading || roleLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-admin-accent border-t-transparent" />
      </div>
    );
  }

  if (!user) return <Navigate to="/auth/login" replace />;
  if (isAdmin) return <Navigate to="/admin" replace />;

  const handleBootstrap = async () => {
    try {
      const result = await bootstrap.mutateAsync();
      if (result) {
        toast.success('You are now the global admin!');
      } else {
        toast.error('A global admin already exists. Contact the platform admin.');
      }
    } catch (err: any) {
      const messages: Record<string, string> = {
        bootstrap_not_configured: 'Admin bootstrap is not configured for this deployment. Set INITIAL_ADMIN_EMAIL in the server environment.',
        email_verification_required: 'Please verify your email before bootstrapping the admin account.',
        not_authorized: 'This account is not authorized to bootstrap the platform admin.',
      };
      toast.error(messages[err?.message] || 'Bootstrap failed.');
    }
  };

  return (
    <div className="admin-scope flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="max-w-md w-full bg-card border-border">
        <CardHeader className="text-center">
          <Shield className="h-12 w-12 mx-auto text-red-400 mb-2" />
          <CardTitle className="text-foreground text-xl">Admin Bootstrap</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-center">
          <p className="text-muted-foreground text-sm">
            No global admin exists yet. As <strong className="text-foreground">{user.email}</strong>, you can claim the admin role.
          </p>
          <p className="text-muted-foreground/70 text-xs">
            This action is irreversible and only works once. Only the platform owner should proceed.
          </p>
          <Button
            onClick={handleBootstrap}
            disabled={bootstrap.isPending}
            className="w-full bg-red-600 hover:bg-red-700"
          >
            {bootstrap.isPending ? 'Bootstrapping…' : 'Claim Global Admin Role'}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
