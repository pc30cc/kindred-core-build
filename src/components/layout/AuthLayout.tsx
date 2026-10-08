import { Outlet } from 'react-router-dom';
import { useApplyAuthPalette } from '@/themes/authPalette';

export function AuthLayout() {
  // International mode with Art's `respok` scheme: the sign-in pages wear it.
  useApplyAuthPalette();
  return (
    <div className="auth-shell auth-aurora flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-md">
        <Outlet />
      </div>
    </div>
  );
}
