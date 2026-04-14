/**
 * BrandingContext — now powered by RuntimeConfig.
 * Kept for backward compatibility with existing components.
 * Delegates all identity to the RuntimeConfigContext.
 */
import React, { createContext, useContext } from 'react';
import { useRuntimeConfig } from '@/features/config/RuntimeConfigContext';
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
  branding: legacyBranding,
  isLoading: legacyLoading = false,
}: {
  children: React.ReactNode;
  branding: WorkspaceBranding | null;
  isLoading?: boolean;
}) {
  const { config, isLoading: configLoading } = useRuntimeConfig();

  // Build a compat WorkspaceBranding from the resolved config
  const resolvedBranding: WorkspaceBranding | null = config ? {
    id: '',
    workspace_id: '',
    platform_name: config.identity.platformName,
    short_name: config.identity.platformName,
    logo_url: config.branding.logoUrl,
    favicon_url: config.branding.faviconUrl,
    primary_color: config.branding.primaryColor,
    accent_color: config.branding.secondaryColor,
    support_email: config.email.senderEmail,
    sender_name: config.email.senderName,
    meta_title: config.identity.metaTitle,
    meta_description: config.identity.metaDescription,
    social_image_url: null,
    footer_text: config.identity.footerCompanyText,
    legal_name: config.identity.legalCompanyDisplayName,
    canonical_base_url: config.domains.canonicalBaseUrl,
    panel_base_url: config.domains.appBaseUrl,
    widget_base_url: config.domains.widgetBaseUrl,
    asset_base_url: config.domains.assetBaseUrl,
  } : legacyBranding;

  const platformName = resolvedBranding?.platform_name || legacyBranding?.platform_name || 'Platform';
  const isLoading = configLoading || legacyLoading;

  return (
    <BrandingContext.Provider value={{ branding: resolvedBranding, platformName, isLoading }}>
      {children}
    </BrandingContext.Provider>
  );
}

export function useBrandingContext() {
  return useContext(BrandingContext);
}
