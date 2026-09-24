import { Outlet } from 'react-router-dom';

export function AuthLayout() {
  return (
    <div className="auth-shell auth-aurora flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-md">
        <Outlet />
      </div>
    </div>
  );
}
