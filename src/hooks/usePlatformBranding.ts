import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { adminFetch } from '@/hooks/useAdmin';
import { PLATFORM_PUBLIC_CONFIG_QUERY_KEY, type PlatformPublicBrandAssets } from '@/lib/platformPublicConfig';

// ── Platform Branding (visual identity) ──

export interface PlatformBranding {
  id: string;
  logo_url: string | null;
  favicon_url: string | null;
  primary_color: string | null;
  secondary_color: string | null;
  pwa_icon_url: string | null;
  pwa_enabled: boolean;
  pwa_short_name: string | null;
  pwa_background_color: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export function usePlatformBranding() {
  return useQuery({
    queryKey: ['platform_branding'],
    queryFn: async () => {
      const { branding } = await adminFetch<{ branding: PlatformBranding | null }>('/api/admin/management/platform-branding');
      return branding;
    },
  });
}

export function useUpdatePlatformBranding() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (updates: Partial<PlatformBranding>) => {
      const { branding } = await adminFetch<{ branding: PlatformBranding }>(
        '/api/admin/management/platform-branding',
        { method: 'PUT', body: JSON.stringify(updates) },
      );
      return branding;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['platform_branding'] }),
  });
}

// ── The platform's own logo and symbol (uploads; migration 290) ──

export type PlatformBrandAssetVariant = 'logo-light' | 'logo-dark' | 'symbol';

/** What POST …/platform-branding/assets/:variant takes (src/lib/brandRaster.ts prepares it). */
export interface PlatformBrandAssetUpload {
  contentType: string;
  data: string;
  png?: string;
  icons?: { apple_touch_180: string; png_192: string; png_512: string };
}

const BRAND_ASSETS_QUERY_KEY = ['platform_branding_assets'] as const;

/** The uploaded files as URLs (null: nothing uploaded, every mark wears the kit). */
export function usePlatformBrandAssets() {
  return useQuery({
    queryKey: BRAND_ASSETS_QUERY_KEY,
    queryFn: async () => {
      const { assets } = await adminFetch<{ assets?: PlatformPublicBrandAssets | null }>('/api/admin/management/platform-branding');
      return assets ?? null;
    },
  });
}

/** After an upload or a reset: this page and every mark on it show the new logo at once. */
function useBrandAssetsSaved() {
  const qc = useQueryClient();
  return (assets: PlatformPublicBrandAssets | null) => {
    qc.setQueryData(BRAND_ASSETS_QUERY_KEY, assets);
    qc.invalidateQueries({ queryKey: ['platform_branding'] });
    qc.invalidateQueries({ queryKey: PLATFORM_PUBLIC_CONFIG_QUERY_KEY });
    qc.invalidateQueries({ queryKey: ['platform_branding_global'] });
  };
}

export function useUploadPlatformBrandAsset() {
  const saved = useBrandAssetsSaved();
  return useMutation({
    mutationFn: async ({ variant, upload }: { variant: PlatformBrandAssetVariant; upload: PlatformBrandAssetUpload }) => {
      const { assets } = await adminFetch<{ assets: PlatformPublicBrandAssets | null }>(
        `/api/admin/management/platform-branding/assets/${variant}`,
        { method: 'POST', body: JSON.stringify(upload) },
      );
      return assets;
    },
    onSuccess: saved,
  });
}

export function useResetPlatformBrandAsset() {
  const saved = useBrandAssetsSaved();
  return useMutation({
    mutationFn: async (variant: PlatformBrandAssetVariant) => {
      const { assets } = await adminFetch<{ assets: PlatformPublicBrandAssets | null }>(
        `/api/admin/management/platform-branding/assets/${variant}`,
        { method: 'DELETE' },
      );
      return assets;
    },
    onSuccess: saved,
  });
}

// ── Platform Branding Localized (per-locale text) ──

export interface PlatformBrandingLocalized {
  id: string;
  locale: string;
  platform_name: string;
  meta_title: string | null;
  meta_description: string | null;
  social_share_title: string | null;
  social_share_description: string | null;
  browser_title_format: string | null;
  public_site_title: string | null;
  legal_company_display_name: string | null;
  footer_company_text: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export function usePlatformBrandingLocalized() {
  return useQuery({
    queryKey: ['platform_branding_localized'],
    queryFn: async () => {
      const { branding } = await adminFetch<{ branding: PlatformBrandingLocalized[] }>(
        '/api/admin/management/platform-branding-localized',
      );
      return branding ?? [];
    },
  });
}

export function useUpsertPlatformBrandingLocalized() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (row: Partial<PlatformBrandingLocalized> & { locale: string }) => {
      const { id: _id, created_at: _c, updated_at: _u, ...rest } = row;
      const { branding } = await adminFetch<{ branding: PlatformBrandingLocalized }>(
        '/api/admin/management/platform-branding-localized',
        { method: 'PUT', body: JSON.stringify(rest) },
      );
      return branding;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['platform_branding_localized'] }),
  });
}

// ── Platform Domains ──

export interface PlatformDomains {
  id: string;
  primary_domain: string | null;
  canonical_base_url: string | null;
  app_base_url: string | null;
  api_base_url: string | null;
  // `widget_base_url` / `asset_base_url` are deliberately absent. The columns
  // still exist for rollback, but widget deployment URLs are owned by
  // `widget_platform_settings` (Super Admin → Widget → Deployment URLs).
  // Leaving them on this type is what let a second, competing place to set the
  // same URL keep looking legitimate.
  public_base_url: string | null;
  help_center_base_url: string | null;
  email_base_url: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export function usePlatformDomains() {
  return useQuery({
    queryKey: ['platform_domains'],
    queryFn: async () => {
      const { domains } = await adminFetch<{ domains: PlatformDomains | null }>('/api/admin/management/platform-domains');
      return domains;
    },
  });
}

export function useUpdatePlatformDomains() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (updates: Partial<PlatformDomains>) => {
      const { domains } = await adminFetch<{ domains: PlatformDomains }>(
        '/api/admin/management/platform-domains',
        { method: 'PUT', body: JSON.stringify(updates) },
      );
      return domains;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['platform_domains'] }),
  });
}
