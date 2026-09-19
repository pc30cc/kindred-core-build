import { supabase } from '@/lib/supabase';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { adminFetch } from '@/hooks/useAdmin';

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
      const { data, error } = await supabase
        .from('platform_branding')
        .select('*')
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data as PlatformBranding | null;
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
  widget_display_name: string | null;
  knowledge_base_title: string | null;
  legal_company_display_name: string | null;
  footer_company_text: string | null;
  support_label: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export function usePlatformBrandingLocalized() {
  return useQuery({
    queryKey: ['platform_branding_localized'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('platform_branding_localized')
        .select('*')
        .order('locale');
      if (error) throw error;
      return (data ?? []) as PlatformBrandingLocalized[];
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
      const { data, error } = await supabase
        .from('platform_domains')
        .select('*')
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data as PlatformDomains | null;
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
