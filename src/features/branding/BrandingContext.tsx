import React, { createContext, useContext, useEffect } from 'react';
import type { WorkspaceBranding } from '@/types/models';
import { usePlatformOrigins } from '@/hooks/usePlatformOrigins';

interface BrandingContextValue {
  branding: WorkspaceBranding | null;
  platformName: string;
  isLoading: boolean;
}

const BrandingContext = createContext<BrandingContextValue>({
  branding: null,
  platformName: '',
  isLoading: true,
});

export function BrandingProvider({
  children,
  branding,
  isLoading = false,
}: {
  children: React.ReactNode;
  branding: WorkspaceBranding | null;
  isLoading?: boolean;
}) {
  const platformName = (branding?.platform_name || '').trim();
  const { data: origins } = usePlatformOrigins();

  // NOTE: the browser title is owned exclusively by PlatformBrandingGate
  // (platform_branding_localized). Workspace branding must not overwrite it.



  // Drive favicon from branding
  useEffect(() => {
    if (branding?.favicon_url) {
      let link = document.querySelector("link[rel~='icon']") as HTMLLinkElement | null;
      if (!link) {
        link = document.createElement('link');
        link.rel = 'icon';
        document.head.appendChild(link);
      }
      link.href = branding.favicon_url;
    }
  }, [branding?.favicon_url]);

  // Drive meta description
  useEffect(() => {
    if (branding?.meta_description) {
      let meta = document.querySelector("meta[name='description']") as HTMLMetaElement | null;
      if (!meta) {
        meta = document.createElement('meta');
        meta.name = 'description';
        document.head.appendChild(meta);
      }
      meta.content = branding.meta_description;
    }
  }, [branding?.meta_description]);

  // Drive OG image
  useEffect(() => {
    if (branding?.social_image_url) {
      let meta = document.querySelector("meta[property='og:image']") as HTMLMetaElement | null;
      if (!meta) {
        meta = document.createElement('meta');
        meta.setAttribute('property', 'og:image');
        document.head.appendChild(meta);
      }
      meta.content = branding.social_image_url;
    }
  }, [branding?.social_image_url]);

  // Drive canonical URL.
  //
  // Owned exclusively by the platform (`platform_domains.canonical_base_url`,
  // surfaced by GET /api/platform/origins), for the same reason the browser
  // title above is: workspace branding carries its own copy of this URL, and
  // that copy drifts. It did — every page in the dashboard was advertising a
  // canonical on a domain the platform had already moved off, because
  // `workspace_branding.canonical_base_url` still held the old one and nobody
  // edits a column no screen shows.
  //
  // No platform answer means no tag. An absent canonical costs nothing; one
  // pointing at a dead domain tells every crawler the real page is elsewhere.
  useEffect(() => {
    const base = origins?.canonicalBaseUrl;
    if (!base) return;
    let link = document.querySelector("link[rel='canonical']") as HTMLLinkElement | null;
    if (!link) {
      link = document.createElement('link');
      link.rel = 'canonical';
      document.head.appendChild(link);
    }
    link.href = base + window.location.pathname;
  }, [origins?.canonicalBaseUrl]);

  return (
    <BrandingContext.Provider value={{ branding, platformName, isLoading }}>
      {children}
    </BrandingContext.Provider>
  );
}

export function useBrandingContext() {
  return useContext(BrandingContext);
}
