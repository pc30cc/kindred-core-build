import { useAuth } from '@/features/auth/AuthContext';
import { useIsGlobalAdmin, useBootstrapAdmin } from '@/hooks/useAdmin';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Navigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Shield } from 'lucide-react';

export default function AdminBootstrapPage() {
  const { user, isLoading: authLoading } = useAuth();
  const { data: isAdmin, isLoading: roleLoading } = useIsGlobalAdmin();
  const bootstrap = useBootstrapAdmin();

  if (authLoading || roleLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-950">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
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
    } catch {
      toast.error('Bootstrap failed.');
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-950 p-4">
      <Card className="max-w-md w-full bg-slate-900 border-slate-800">
        <CardHeader className="text-center">
          <Shield className="h-12 w-12 mx-auto text-red-400 mb-2" />
          <CardTitle className="text-white text-xl">Admin Bootstrap</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-center">
          <p className="text-slate-400 text-sm">
            No global admin exists yet. As <strong className="text-white">{user.email}</strong>, you can claim the admin role.
          </p>
          <p className="text-slate-500 text-xs">
            This action is irreversible and only works once. Only the platform owner should proceed.
          </p>
          <Button
            onClick={handleBootstrap}
            disabled={bootstrap.isPending}
            className="w-full bg-red-600 hover:bg-red-700 text-white"
          >
            {bootstrap.isPending ? 'Bootstrapping…' : 'Claim Global Admin Role'}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
