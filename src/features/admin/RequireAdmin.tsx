import { Navigate } from 'react-router-dom';
import { useAuth } from '@/features/auth/AuthContext';
import { useIsGlobalAdmin } from '@/hooks/useAdmin';
import { BrandLoaderScreen } from '@/components/brand/BrandLoader';

export function RequireAdmin({ children }: { children: React.ReactNode }) {
  const { user, isLoading: authLoading } = useAuth();
  const { data: isAdmin, isLoading: roleLoading } = useIsGlobalAdmin();

  if (authLoading || roleLoading) return <BrandLoaderScreen />;

  if (!user) return <Navigate to="/auth/login" replace />;
  if (!isAdmin) return <Navigate to="/app" replace />;

  return <>{children}</>;
}
