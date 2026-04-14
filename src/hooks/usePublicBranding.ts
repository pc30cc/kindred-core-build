/**
 * Hook for loading branding on public pages (unauthenticated).
 * Uses the anon-accessible workspace_branding table.
 * Falls back to 'Platform' if no branding found.
 */
import { supabase } from '@/lib/supabase';
import { useQuery } from '@tanstack/react-query';
import type { WorkspaceBranding } from '@/types/models';

export function usePublicBranding() {
  const { data: branding, isLoading } = useQuery({
    queryKey: ['public-branding'],
    queryFn: async () => {
      // For public pages, load the first available branding record.
      // In a multi-tenant setup, this could be resolved by domain.
      const { data, error } = await supabase
        .from('workspace_branding')
        .select('*')
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data as WorkspaceBranding | null;
    },
    staleTime: 5 * 60 * 1000, // Cache for 5 minutes
  });

  return {
    branding: branding ?? null,
    platformName: branding?.platform_name || 'Platform',
    isLoading,
  };
}
