/**
 * Branding text for public (signed-out) pages: login, signup, password reset.
 * Served by GET /api/platform/public/config, shared with PlatformBrandingGate.
 */
import { useQuery } from '@tanstack/react-query';
import { fetchPlatformPublicConfig } from '@/lib/platformPublicConfig';

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
      const { localized } = await fetchPlatformPublicConfig();
      const row = localized.find((r) => r.locale === locale);
      if (!row) return null;
      const { platform_name, meta_title, meta_description, browser_title_format } = row;
      return { platform_name, meta_title, meta_description, browser_title_format } as PublicBrandingLocalized;
    },
    staleTime: 5 * 60 * 1000,
  });
  return data;
}
