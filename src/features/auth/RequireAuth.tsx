import { Navigate } from 'react-router-dom';
import { useAuth } from '@/features/auth/AuthContext';
import { BrandLoaderScreen } from '@/components/brand/BrandLoader';

export function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, isLoading } = useAuth();

  if (isLoading) return <BrandLoaderScreen />;

  if (!user) return <Navigate to="/auth/login" replace />;
  return <>{children}</>;
}
