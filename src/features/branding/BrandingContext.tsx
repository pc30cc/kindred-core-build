import React, { createContext, useContext, useEffect } from 'react';
import type { WorkspaceBranding } from '@/types/models';

interface BrandingContextValue {
  branding: WorkspaceBranding | null;
  platformName: string;
  isLoading: boolean;
}

const BrandingContext = createContext<BrandingContextValue>({
  branding: null,
  platformName: 'Platform',
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
  const platformName = branding?.platform_name || 'Platform';

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

  // Drive canonical URL
  useEffect(() => {
    if (branding?.canonical_base_url) {
      let link = document.querySelector("link[rel='canonical']") as HTMLLinkElement | null;
      if (!link) {
        link = document.createElement('link');
        link.rel = 'canonical';
        document.head.appendChild(link);
      }
      link.href = branding.canonical_base_url + window.location.pathname;
    }
  }, [branding?.canonical_base_url]);

  return (
    <BrandingContext.Provider value={{ branding, platformName, isLoading }}>
      {children}
    </BrandingContext.Provider>
  );
}

export function useBrandingContext() {
  return useContext(BrandingContext);
}
