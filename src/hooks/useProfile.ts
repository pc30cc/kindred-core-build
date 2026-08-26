import { useAuth } from '@/features/auth/AuthContext';
import { useQuery } from '@tanstack/react-query';
import { fetchAccountMe } from '@/lib/account-api';

// Reuses GET /api/account/me (gs_session cookie) rather than a direct
// supabase.from('profiles') read — the dashboard's browser session no
// longer carries a Supabase Auth JWT, so auth.uid()-scoped RLS on a
// direct query would silently return nothing. This is always "my own
// profile" (keyed by the session, not a client-supplied id), so no
// workspace scoping is needed.
export function useProfile() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['profile', user?.id],
    queryFn: async () => {
      const { profile } = await fetchAccountMe();
      return profile;
    },
    enabled: !!user?.id,
    staleTime: 5 * 60 * 1000,
  });
}
