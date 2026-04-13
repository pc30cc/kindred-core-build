import { Navigate } from 'react-router-dom';
import { useAuth } from '@/features/auth/AuthContext';
import { useIsGlobalAdmin } from '@/hooks/useAdmin';

export function RequireAdmin({ children }: { children: React.ReactNode }) {
  const { user, isLoading: authLoading } = useAuth();
  const { data: isAdmin, isLoading: roleLoading } = useIsGlobalAdmin();

  if (authLoading || roleLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  if (!user) return <Navigate to="/auth/login" replace />;
  if (!isAdmin) return <Navigate to="/app" replace />;

  return <>{children}</>;
}
