// ============================================
// RUNTIME CONFIG RESOLVER — self-hosted backend
// Single source of truth for all runtime identity.
// Resolution: workspace localized → workspace generic
//   → platform localized → platform generic → fallback
// ============================================

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { ServerConfig } from '../../config.js';

// ─── Resolved Config Types ──────────────────────────────────

export interface ResolvedSiteMode {
  siteMode: 'single_language' | 'multi_language';
  activeLocales: string[];
  defaultLocale: string;
  panelDefaultLocale: string;
  widgetDefaultLocale: string;
  fallbackLocale: string;
  timezone: string;
}

export interface ResolvedBranding {
  logoUrl: string | null;
  faviconUrl: string | null;
  pwaIconUrl: string | null;
  primaryColor: string;
  secondaryColor: string;
}

export interface ResolvedLocalizedIdentity {
  platformName: string;
  publicSiteTitle: string | null;
  browserTitleFormat: string;
  metaTitle: string | null;
  metaDescription: string | null;
  footerCompanyText: string | null;
  supportLabel: string | null;
  legalCompanyDisplayName: string | null;
  socialShareTitle: string | null;
  socialShareDescription: string | null;
  knowledgeBaseTitle: string;
  widgetDisplayName: string | null;
}

export interface ResolvedDomains {
  primaryDomain: string | null;
  canonicalBaseUrl: string | null;
  publicBaseUrl: string | null;
  appBaseUrl: string | null;
  apiBaseUrl: string | null;
  widgetBaseUrl: string | null;
  assetBaseUrl: string | null;
  helpCenterBaseUrl: string | null;
  emailBaseUrl: string | null;
}

export interface ResolvedEmailIdentity {
  senderEmail: string;
  replyToEmail: string | null;
  emailLogoUrl: string | null;
  emailFooterText: string | null;
  senderName: string;
  localizedFooterText: string | null;
  supportContactLabel: string | null;
}

export interface ResolvedConfig {
  siteMode: ResolvedSiteMode;
  branding: ResolvedBranding;
  identity: ResolvedLocalizedIdentity;
  domains: ResolvedDomains;
  email: ResolvedEmailIdentity;
}

// ─── Cache ──────────────────────────────────────────────────

interface CacheEntry {
  config: ResolvedConfig;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 30_000; // 30 seconds

function cacheKey(workspaceId: string | null, locale: string): string {
  return `${workspaceId || 'platform'}:${locale}`;
}

export function invalidateConfigCache(workspaceId?: string) {
  if (workspaceId) {
    for (const key of cache.keys()) {
      if (key.startsWith(workspaceId)) cache.delete(key);
    }
  } else {
    cache.clear();
  }
}

// ─── Resolver ───────────────────────────────────────────────

export async function resolveConfig(
  config: ServerConfig,
  options: {
    workspaceId?: string;
    locale?: string;
    origin?: string;
  } = {}
): Promise<ResolvedConfig> {
  const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey);
  const requestedLocale = options.locale || 'en';
  const workspaceId = options.workspaceId || null;

  // Check cache
  const key = cacheKey(workspaceId, requestedLocale);
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.config;
  }

  // Resolve all in parallel
  const [siteMode, branding, identity, domains, email] = await Promise.all([
    resolveSiteMode(supabase, workspaceId),
    resolveBranding(supabase, workspaceId),
    resolveLocalizedIdentity(supabase, workspaceId, requestedLocale),
    resolveDomains(supabase, workspaceId, options.origin),
    resolveEmailIdentity(supabase, workspaceId, requestedLocale),
  ]);

  const resolved: ResolvedConfig = { siteMode, branding, identity, domains, email };

  // Store in cache
  cache.set(key, { config: resolved, expiresAt: Date.now() + CACHE_TTL_MS });

  return resolved;
}

// ─── Site Mode ──────────────────────────────────────────────

async function resolveSiteMode(
  supabase: SupabaseClient,
  workspaceId: string | null
): Promise<ResolvedSiteMode> {
  const { data: platform } = await supabase
    .from('platform_settings')
    .select('*')
    .limit(1)
    .maybeSingle();

  const defaults: ResolvedSiteMode = {
    siteMode: (platform?.site_mode as any) || 'multi_language',
    activeLocales: platform?.active_locales || ['en'],
    defaultLocale: platform?.default_locale || 'en',
    panelDefaultLocale: platform?.panel_default_locale || 'en',
    widgetDefaultLocale: platform?.widget_default_locale || 'en',
    fallbackLocale: platform?.fallback_locale || 'en',
    timezone: platform?.timezone || 'UTC',
  };

  if (!workspaceId) return defaults;

  const { data: ws } = await supabase
    .from('workspace_settings')
    .select('*')
    .eq('workspace_id', workspaceId)
    .maybeSingle();

  if (!ws) return defaults;

  return {
    siteMode: (ws.site_mode as any) || defaults.siteMode,
    activeLocales: ws.active_locales || defaults.activeLocales,
    defaultLocale: ws.default_locale || defaults.defaultLocale,
    panelDefaultLocale: ws.panel_default_locale || defaults.panelDefaultLocale,
    widgetDefaultLocale: ws.widget_default_locale || defaults.widgetDefaultLocale,
    fallbackLocale: ws.fallback_locale || defaults.fallbackLocale,
    timezone: defaults.timezone,
  };
}

// ─── Branding (non-localized) ───────────────────────────────

async function resolveBranding(
  supabase: SupabaseClient,
  workspaceId: string | null
): Promise<ResolvedBranding> {
  const { data: platform } = await supabase
    .from('platform_branding')
    .select('*')
    .limit(1)
    .maybeSingle();

  const defaults: ResolvedBranding = {
    logoUrl: platform?.logo_url || null,
    faviconUrl: platform?.favicon_url || null,
    pwaIconUrl: platform?.pwa_icon_url || null,
    primaryColor: platform?.primary_color || '#3B82F6',
    secondaryColor: platform?.secondary_color || '#1E40AF',
  };

  if (!workspaceId) return defaults;

  // workspace_branding (existing table) can override visual assets
  const { data: ws } = await supabase
    .from('workspace_branding')
    .select('logo_url, favicon_url, primary_color, accent_color')
    .eq('workspace_id', workspaceId)
    .maybeSingle();

  if (!ws) return defaults;

  return {
    logoUrl: ws.logo_url || defaults.logoUrl,
    faviconUrl: ws.favicon_url || defaults.faviconUrl,
    pwaIconUrl: defaults.pwaIconUrl,
    primaryColor: ws.primary_color || defaults.primaryColor,
    secondaryColor: ws.accent_color || defaults.secondaryColor,
  };
}

// ─── Localized Identity ─────────────────────────────────────

async function resolveLocalizedIdentity(
  supabase: SupabaseClient,
  workspaceId: string | null,
  locale: string
): Promise<ResolvedLocalizedIdentity> {
  const fallback: ResolvedLocalizedIdentity = {
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
  };

  // 1. Platform localized for requested locale
  const { data: platformLocalized } = await supabase
    .from('platform_branding_localized')
    .select('*')
    .eq('locale', locale)
    .maybeSingle();

  // 2. Platform localized for 'en' fallback
  let platformFallback = null;
  if (locale !== 'en' && !platformLocalized) {
    const { data } = await supabase
      .from('platform_branding_localized')
      .select('*')
      .eq('locale', 'en')
      .maybeSingle();
    platformFallback = data;
  }

  const platformSource = platformLocalized || platformFallback;
  const platformIdentity: ResolvedLocalizedIdentity = platformSource ? {
    platformName: platformSource.platform_name || fallback.platformName,
    publicSiteTitle: platformSource.public_site_title,
    browserTitleFormat: platformSource.browser_title_format || fallback.browserTitleFormat,
    metaTitle: platformSource.meta_title,
    metaDescription: platformSource.meta_description,
    footerCompanyText: platformSource.footer_company_text,
    supportLabel: platformSource.support_label,
    legalCompanyDisplayName: platformSource.legal_company_display_name,
    socialShareTitle: platformSource.social_share_title,
    socialShareDescription: platformSource.social_share_description,
    knowledgeBaseTitle: platformSource.knowledge_base_title || fallback.knowledgeBaseTitle,
    widgetDisplayName: platformSource.widget_display_name,
  } : fallback;

  if (!workspaceId) return platformIdentity;

  // 3. Workspace localized for requested locale
  const { data: wsLocalized } = await supabase
    .from('workspace_branding_localized')
    .select('*')
    .eq('workspace_id', workspaceId)
    .eq('locale', locale)
    .maybeSingle();

  if (!wsLocalized) return platformIdentity;

  // Merge: workspace overrides platform where non-null
  return {
    platformName: wsLocalized.platform_name || platformIdentity.platformName,
    publicSiteTitle: wsLocalized.public_site_title || platformIdentity.publicSiteTitle,
    browserTitleFormat: wsLocalized.browser_title_format || platformIdentity.browserTitleFormat,
    metaTitle: wsLocalized.meta_title || platformIdentity.metaTitle,
    metaDescription: wsLocalized.meta_description || platformIdentity.metaDescription,
    footerCompanyText: wsLocalized.footer_company_text || platformIdentity.footerCompanyText,
    supportLabel: wsLocalized.support_label || platformIdentity.supportLabel,
    legalCompanyDisplayName: wsLocalized.legal_company_display_name || platformIdentity.legalCompanyDisplayName,
    socialShareTitle: wsLocalized.social_share_title || platformIdentity.socialShareTitle,
    socialShareDescription: wsLocalized.social_share_description || platformIdentity.socialShareDescription,
    knowledgeBaseTitle: wsLocalized.knowledge_base_title || platformIdentity.knowledgeBaseTitle,
    widgetDisplayName: wsLocalized.widget_display_name || platformIdentity.widgetDisplayName,
  };
}

// ─── Domains ────────────────────────────────────────────────

async function resolveDomains(
  supabase: SupabaseClient,
  workspaceId: string | null,
  origin?: string
): Promise<ResolvedDomains> {
  const { data: platform } = await supabase
    .from('platform_domains')
    .select('*')
    .limit(1)
    .maybeSingle();

  // Same-origin safe: if no configured URL, use the request origin
  const safeOrigin = origin || '';

  const defaults: ResolvedDomains = {
    primaryDomain: platform?.primary_domain || null,
    canonicalBaseUrl: platform?.canonical_base_url || safeOrigin || null,
    publicBaseUrl: platform?.public_base_url || safeOrigin || null,
    appBaseUrl: platform?.app_base_url || safeOrigin || null,
    apiBaseUrl: platform?.api_base_url || safeOrigin || null,
    widgetBaseUrl: platform?.widget_base_url || safeOrigin || null,
    assetBaseUrl: platform?.asset_base_url || safeOrigin || null,
    helpCenterBaseUrl: platform?.help_center_base_url || safeOrigin || null,
    emailBaseUrl: platform?.email_base_url || safeOrigin || null,
  };

  if (!workspaceId) return defaults;

  const { data: ws } = await supabase
    .from('workspace_domains_extended')
    .select('*')
    .eq('workspace_id', workspaceId)
    .maybeSingle();

  if (!ws) return defaults;

  return {
    primaryDomain: ws.primary_domain || defaults.primaryDomain,
    canonicalBaseUrl: ws.canonical_base_url || defaults.canonicalBaseUrl,
    publicBaseUrl: ws.public_base_url || defaults.publicBaseUrl,
    appBaseUrl: ws.app_base_url || defaults.appBaseUrl,
    apiBaseUrl: ws.api_base_url || defaults.apiBaseUrl,
    widgetBaseUrl: ws.widget_base_url || defaults.widgetBaseUrl,
    assetBaseUrl: ws.asset_base_url || defaults.assetBaseUrl,
    helpCenterBaseUrl: ws.help_center_base_url || defaults.helpCenterBaseUrl,
    emailBaseUrl: ws.email_base_url || defaults.emailBaseUrl,
  };
}

// ─── Email Identity ─────────────────────────────────────────

async function resolveEmailIdentity(
  supabase: SupabaseClient,
  workspaceId: string | null,
  locale: string
): Promise<ResolvedEmailIdentity> {
  // Platform default email settings
  const { data: platformEmail } = await supabase
    .from('email_settings')
    .select('*')
    .is('workspace_id', null)
    .limit(1)
    .maybeSingle();

  // Platform localized email
  const { data: platformEmailLoc } = await supabase
    .from('email_settings_localized')
    .select('*')
    .is('workspace_id', null)
    .eq('locale', locale)
    .maybeSingle();

  // Fallback to 'en' if not found
  let platformEmailLocFallback = platformEmailLoc;
  if (!platformEmailLoc && locale !== 'en') {
    const { data } = await supabase
      .from('email_settings_localized')
      .select('*')
      .is('workspace_id', null)
      .eq('locale', 'en')
      .maybeSingle();
    platformEmailLocFallback = data;
  }

  const defaults: ResolvedEmailIdentity = {
    senderEmail: platformEmail?.sender_email || 'noreply@example.com',
    replyToEmail: platformEmail?.reply_to_email || null,
    emailLogoUrl: platformEmail?.email_logo_url || null,
    emailFooterText: platformEmail?.email_footer_text || null,
    senderName: platformEmailLocFallback?.sender_name || 'Platform',
    localizedFooterText: platformEmailLocFallback?.footer_text || null,
    supportContactLabel: platformEmailLocFallback?.support_contact_label || null,
  };

  if (!workspaceId) return defaults;

  // Workspace email settings
  const { data: wsEmail } = await supabase
    .from('email_settings')
    .select('*')
    .eq('workspace_id', workspaceId)
    .maybeSingle();

  const { data: wsEmailLoc } = await supabase
    .from('email_settings_localized')
    .select('*')
    .eq('workspace_id', workspaceId)
    .eq('locale', locale)
    .maybeSingle();

  return {
    senderEmail: wsEmail?.sender_email || defaults.senderEmail,
    replyToEmail: wsEmail?.reply_to_email || defaults.replyToEmail,
    emailLogoUrl: wsEmail?.email_logo_url || defaults.emailLogoUrl,
    emailFooterText: wsEmail?.email_footer_text || defaults.emailFooterText,
    senderName: wsEmailLoc?.sender_name || defaults.senderName,
    localizedFooterText: wsEmailLoc?.footer_text || defaults.localizedFooterText,
    supportContactLabel: wsEmailLoc?.support_contact_label || defaults.supportContactLabel,
  };
}

// ─── Template Variable Builder ──────────────────────────────

export function buildTemplateVariables(resolved: ResolvedConfig): Record<string, string> {
  return {
    'brand.name': resolved.identity.platformName,
    'brand.short_name': resolved.identity.platformName,
    'brand.support_email': resolved.email.senderEmail,
    'brand.support_label': resolved.identity.supportLabel || '',
    'brand.logo_url': resolved.branding.logoUrl || '',
    'brand.footer_company': resolved.identity.footerCompanyText || '',
    'brand.legal_name': resolved.identity.legalCompanyDisplayName || '',
    'brand.sender_name': resolved.email.senderName,
    'seo.meta_title': resolved.identity.metaTitle || resolved.identity.platformName,
    'urls.public_base': resolved.domains.publicBaseUrl || '',
    'urls.app_base': resolved.domains.appBaseUrl || '',
    'urls.help_center_base': resolved.domains.helpCenterBaseUrl || '',
    'urls.email_base': resolved.domains.emailBaseUrl || '',
    'urls.canonical_base': resolved.domains.canonicalBaseUrl || '',
    'urls.widget_base': resolved.domains.widgetBaseUrl || '',
    'urls.asset_base': resolved.domains.assetBaseUrl || '',
  };
}
