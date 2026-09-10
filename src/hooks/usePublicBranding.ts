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
      const { data, error } = await supabase
        .from('workspace_branding')
        .select('*')
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data as WorkspaceBranding | null;
    },
    staleTime: 5 * 60 * 1000,
  });

  return {
    branding: branding ?? null,
    platformName: (branding?.platform_name || '').trim(),
    isLoading,
  };
}

export interface PublicBrandingLocalized {
  platform_name: string;
  meta_title: string | null;
  meta_description: string | null;
  browser_title_format: string | null;
}

export function usePlatformBrandingForLocale(locale: string) {
  const { data } = useQuery({
    queryKey: ['platform_branding_localized', locale],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('platform_branding_localized')
        .select('platform_name, meta_title, meta_description, browser_title_format')
        .eq('locale', locale)
        .maybeSingle();
      if (error) throw error;
      return data as PublicBrandingLocalized | null;
    },
    staleTime: 5 * 60 * 1000,
  });
  return data;
}
