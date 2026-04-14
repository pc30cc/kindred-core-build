/**
 * Hook for loading branding on public pages (unauthenticated).
 * Now delegates to RuntimeConfig for resolved identity.
 * Falls back to workspace_branding table if config resolver is unavailable.
 */
import { useRuntimeConfig } from '@/features/config/RuntimeConfigContext';
import type { WorkspaceBranding } from '@/types/models';

export function usePublicBranding() {
  const { config, isLoading } = useRuntimeConfig();

  const branding: WorkspaceBranding | null = config ? {
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
  } : null;

  return {
    branding,
    platformName: config?.identity.platformName || 'Platform',
    isLoading,
  };
}
