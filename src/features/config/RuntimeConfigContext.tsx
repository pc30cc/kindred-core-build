/**
 * RuntimeConfigContext — single source of truth for resolved runtime config.
 * Fetches from /api/config/resolve on mount.
 * Falls back to Supabase workspace_branding if backend is unreachable (dev preview).
 */

import React, { createContext, useContext, useEffect, useState } from 'react';
import { useI18n } from '@/i18n';
import { useCurrentWorkspace } from '@/hooks/useWorkspace';
import type { ResolvedConfig } from '@/lib/config-api';
import { fetchResolvedConfig } from '@/lib/config-api';

interface RuntimeConfigContextValue {
  config: ResolvedConfig | null;
  isLoading: boolean;
  error: string | null;
  refetch: () => void;
}

const fallbackConfig: ResolvedConfig = {
  siteMode: {
    siteMode: 'multi_language',
    activeLocales: ['en', 'fa', 'tr'],
    defaultLocale: 'en',
    panelDefaultLocale: 'en',
    widgetDefaultLocale: 'en',
    fallbackLocale: 'en',
    timezone: 'UTC',
  },
  branding: {
    logoUrl: null,
    faviconUrl: null,
    pwaIconUrl: null,
    primaryColor: '#3B82F6',
    secondaryColor: '#1E40AF',
  },
  identity: {
    platformName: 'Platform',
    publicSiteTitle: null,
    browserTitleFormat: '{{page}} — {{platform}}',
    metaTitle: null,
    metaDescription: null,
    footerCompanyText: null,
    supportLabel: null,
    legalCompanyDisplayName: null,
    socialShareTitle: null,
    socialShareDescription: null,
    knowledgeBaseTitle: 'Help Center',
    widgetDisplayName: null,
  },
  domains: {
    primaryDomain: null,
    canonicalBaseUrl: null,
    publicBaseUrl: null,
    appBaseUrl: null,
    apiBaseUrl: null,
    widgetBaseUrl: null,
    assetBaseUrl: null,
    helpCenterBaseUrl: null,
    emailBaseUrl: null,
  },
  email: {
    senderEmail: 'noreply@example.com',
    replyToEmail: null,
    emailLogoUrl: null,
    emailFooterText: null,
    senderName: 'Platform',
    localizedFooterText: null,
    supportContactLabel: null,
  },
};

const RuntimeConfigContext = createContext<RuntimeConfigContextValue>({
  config: null,
  isLoading: true,
  error: null,
  refetch: () => {},
});

export function RuntimeConfigProvider({ children }: { children: React.ReactNode }) {
  const { locale } = useI18n();
  const { data: workspace } = useCurrentWorkspace();
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const doFetch = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const resolved = await fetchResolvedConfig(workspace?.id, locale);
      setConfig(resolved);
    } catch (err: any) {
      console.warn('[RuntimeConfig] Backend unreachable, using fallback:', err.message);
      setConfig(fallbackConfig);
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    doFetch();
  }, [locale, workspace?.id]);

  // Drive document title
  useEffect(() => {
    if (!config) return;
    const title = config.identity.metaTitle || config.identity.publicSiteTitle || config.identity.platformName;
    if (title) document.title = title;
  }, [config?.identity]);

  // Drive favicon
  useEffect(() => {
    if (!config?.branding.faviconUrl) return;
    let link = document.querySelector("link[rel~='icon']") as HTMLLinkElement | null;
    if (!link) {
      link = document.createElement('link');
      link.rel = 'icon';
      document.head.appendChild(link);
    }
    link.href = config.branding.faviconUrl;
  }, [config?.branding.faviconUrl]);

  // Drive meta description
  useEffect(() => {
    if (!config?.identity.metaDescription) return;
    let meta = document.querySelector("meta[name='description']") as HTMLMetaElement | null;
    if (!meta) {
      meta = document.createElement('meta');
      meta.name = 'description';
      document.head.appendChild(meta);
    }
    meta.content = config.identity.metaDescription;
  }, [config?.identity.metaDescription]);

  // Drive canonical
  useEffect(() => {
    if (!config?.domains.canonicalBaseUrl) return;
    let link = document.querySelector("link[rel='canonical']") as HTMLLinkElement | null;
    if (!link) {
      link = document.createElement('link');
      link.rel = 'canonical';
      document.head.appendChild(link);
    }
    link.href = config.domains.canonicalBaseUrl + window.location.pathname;
  }, [config?.domains.canonicalBaseUrl]);

  // Drive OG image (from branding logo for now)
  useEffect(() => {
    const ogTitle = config?.identity.socialShareTitle;
    if (!ogTitle) return;
    let meta = document.querySelector("meta[property='og:title']") as HTMLMetaElement | null;
    if (!meta) {
      meta = document.createElement('meta');
      meta.setAttribute('property', 'og:title');
      document.head.appendChild(meta);
    }
    meta.content = ogTitle;
  }, [config?.identity.socialShareTitle]);

  return (
    <RuntimeConfigContext.Provider value={{ config, isLoading, error, refetch: doFetch }}>
      {children}
    </RuntimeConfigContext.Provider>
  );
}

export function useRuntimeConfig() {
  return useContext(RuntimeConfigContext);
}
