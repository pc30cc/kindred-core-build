/**
 * PlatformBrandingGate: Loads platform_branding + platform_branding_localized
 * and sets document.title, favicon, and CSS custom properties globally.
 */
import React, { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { useI18n } from '@/i18n';

interface PlatformBrandingRow {
  id: string;
  logo_url: string | null;
  favicon_url: string | null;
  primary_color: string | null;
  secondary_color: string | null;
  pwa_icon_url: string | null;
}

interface PlatformBrandingLocalizedRow {
  locale: string;
  platform_name: string;
  meta_title: string | null;
  meta_description: string | null;
  browser_title_format: string | null;
}

function usePlatformBrandingGlobal() {
  return useQuery({
    queryKey: ['platform_branding_global'],
    queryFn: async () => {
      const [{ data: branding }, { data: localized }] = await Promise.all([
        supabase.from('platform_branding').select('*').limit(1).maybeSingle(),
        supabase.from('platform_branding_localized').select('*').order('locale'),
      ]);
      return {
        branding: branding as PlatformBrandingRow | null,
        localized: (localized ?? []) as PlatformBrandingLocalizedRow[],
      };
    },
    staleTime: 5 * 60 * 1000,
  });
}

export function PlatformBrandingGate({ children }: { children: React.ReactNode }) {
  const { data } = usePlatformBrandingGlobal();
  const { locale } = useI18n();

  useEffect(() => {
    if (!data) return;

    const { branding, localized } = data;

    // Find locale-specific row, fallback to 'en'
    const locRow = localized.find(r => r.locale === locale) ?? localized.find(r => r.locale === 'en');

    // Single source of truth for the browser title: platform_branding_localized
    const title = locRow?.meta_title || locRow?.platform_name || '';
    if (title) {
      document.title = title;
      try {
        localStorage.setItem(`gs_title:${locale}`, title);
      } catch {
        /* storage unavailable */
      }
    }

    // Set meta description
    if (locRow?.meta_description) {
      let metaDesc = document.querySelector('meta[name="description"]');
      if (metaDesc) metaDesc.setAttribute('content', locRow.meta_description);
    }

    // Set OG title
    let ogTitle = document.querySelector('meta[property="og:title"]');
    if (ogTitle) ogTitle.setAttribute('content', title);

    // Set favicon
    if (branding?.favicon_url) {
      let link = document.querySelector('link[rel="icon"]') as HTMLLinkElement;
      if (!link) {
        link = document.createElement('link');
        link.rel = 'icon';
        document.head.appendChild(link);
      }
      link.href = branding.favicon_url;
    }
  }, [data, locale]);

  return <>{children}</>;
}
