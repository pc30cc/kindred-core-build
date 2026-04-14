/**
 * Runtime Config API client.
 * Reads/writes directly to Supabase tables for platform configuration.
 * Tables: platform_settings, platform_branding, platform_branding_localized,
 *         platform_domains, email_settings, email_settings_localized
 */

import { supabase } from '@/integrations/supabase/client';

// ─── Types ──────────────────────────────────────────────────

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

// ─── Defaults ───────────────────────────────────────────────

const DEFAULT_SETTINGS = {
  site_mode: 'single_language',
  default_locale: 'en',
  panel_default_locale: 'en',
  widget_default_locale: 'en',
  fallback_locale: 'en',
  timezone: 'UTC',
  active_locales: ['en', 'fa', 'tr'],
};

const DEFAULT_BRANDING = {
  logo_url: null,
  favicon_url: null,
  pwa_icon_url: null,
  primary_color: '#3B82F6',
  secondary_color: '#1E40AF',
};

const DEFAULT_DOMAINS = {
  primary_domain: null,
  canonical_base_url: null,
  public_base_url: null,
  app_base_url: null,
  api_base_url: null,
  widget_base_url: null,
  asset_base_url: null,
  help_center_base_url: null,
  email_base_url: null,
};

const DEFAULT_EMAIL = {
  sender_email: 'noreply@example.com',
  reply_to_email: null,
  email_logo_url: null,
  email_footer_text: null,
};

// ─── Helper: get first row or return default ────────────────

async function getFirstRow<T extends Record<string, unknown>>(table: string, defaults: T): Promise<T> {
  const { data, error } = await (supabase as any)
    .from(table)
    .select('*')
    .limit(1)
    .maybeSingle();
  
  if (error) {
    console.warn(`Failed to read ${table}:`, error.message);
    return { ...defaults };
  }
  return data ? { ...defaults, ...data } : { ...defaults };
}

async function upsertSingleRow(table: string, data: Record<string, unknown>, existingId?: string) {
  const { id: _dataId, ...rest } = data as any;
  
  if (existingId) {
    const { error } = await (supabase as any)
      .from(table)
      .update({ ...rest, updated_at: new Date().toISOString() })
      .eq('id', existingId);
    if (error) throw new Error(`Failed to update ${table}: ${error.message}`);
  } else {
    const { error } = await (supabase as any)
      .from(table)
      .insert({ ...rest });
    if (error) throw new Error(`Failed to insert into ${table}: ${error.message}`);
  }
}

// ─── Public API: Resolved Config ────────────────────────────

export async function fetchResolvedConfig(workspaceId?: string, locale?: string): Promise<ResolvedConfig> {
  const [settings, branding, domains, emailSettings] = await Promise.all([
    getFirstRow('platform_settings', DEFAULT_SETTINGS),
    getFirstRow('platform_branding', DEFAULT_BRANDING),
    getFirstRow('platform_domains', DEFAULT_DOMAINS),
    getFirstRow('email_settings', DEFAULT_EMAIL),
  ]);

  const effectiveLocale = locale || (settings as any).default_locale || 'en';

  // Get localized branding
  const { data: localizedBranding } = await supabase
    .from('platform_branding_localized')
    .select('*')
    .eq('locale', effectiveLocale)
    .maybeSingle();

  // Get localized email
  const { data: localizedEmail } = await supabase
    .from('email_settings_localized')
    .select('*')
    .eq('locale', effectiveLocale)
    .is('workspace_id', null)
    .maybeSingle();

  const s = settings as any;
  const b = branding as any;
  const d = domains as any;
  const e = emailSettings as any;
  const lb = localizedBranding || {};
  const le = localizedEmail || {};

  return {
    siteMode: {
      siteMode: s.site_mode || 'single_language',
      activeLocales: s.active_locales || ['en'],
      defaultLocale: s.default_locale || 'en',
      panelDefaultLocale: s.panel_default_locale || 'en',
      widgetDefaultLocale: s.widget_default_locale || 'en',
      fallbackLocale: s.fallback_locale || 'en',
      timezone: s.timezone || 'UTC',
    },
    branding: {
      logoUrl: b.logo_url,
      faviconUrl: b.favicon_url,
      pwaIconUrl: b.pwa_icon_url,
      primaryColor: b.primary_color || '#3B82F6',
      secondaryColor: b.secondary_color || '#1E40AF',
    },
    identity: {
      platformName: (lb as any).platform_name || 'Platform',
      publicSiteTitle: (lb as any).public_site_title || null,
      browserTitleFormat: (lb as any).browser_title_format || '{{page}} — {{platform}}',
      metaTitle: (lb as any).meta_title || null,
      metaDescription: (lb as any).meta_description || null,
      footerCompanyText: (lb as any).footer_company_text || null,
      supportLabel: (lb as any).support_label || null,
      legalCompanyDisplayName: (lb as any).legal_company_display_name || null,
      socialShareTitle: (lb as any).social_share_title || null,
      socialShareDescription: (lb as any).social_share_description || null,
      knowledgeBaseTitle: (lb as any).knowledge_base_title || 'Help Center',
      widgetDisplayName: (lb as any).widget_display_name || null,
    },
    domains: {
      primaryDomain: d.primary_domain,
      canonicalBaseUrl: d.canonical_base_url,
      publicBaseUrl: d.public_base_url,
      appBaseUrl: d.app_base_url,
      apiBaseUrl: d.api_base_url,
      widgetBaseUrl: d.widget_base_url,
      assetBaseUrl: d.asset_base_url,
      helpCenterBaseUrl: d.help_center_base_url,
      emailBaseUrl: d.email_base_url,
    },
    email: {
      senderEmail: e.sender_email || 'noreply@example.com',
      replyToEmail: e.reply_to_email,
      emailLogoUrl: e.email_logo_url,
      emailFooterText: e.email_footer_text,
      senderName: (le as any).sender_name || 'Platform',
      localizedFooterText: (le as any).footer_text || null,
      supportContactLabel: (le as any).support_contact_label || null,
    },
  };
}

// ─── Admin APIs: Platform Settings ──────────────────────────

export async function fetchPlatformSettings() {
  const settings = await getFirstRow('platform_settings', DEFAULT_SETTINGS);
  return { settings };
}

export async function updatePlatformSettings(data: Record<string, unknown>) {
  const existing = await getFirstRow('platform_settings', DEFAULT_SETTINGS);
  const id = (existing as any).id;
  await upsertSingleRow('platform_settings', data, id);
  return { success: true };
}

// ─── Admin APIs: Platform Branding ──────────────────────────

export async function fetchPlatformBranding() {
  const branding = await getFirstRow('platform_branding', DEFAULT_BRANDING);
  return { branding };
}

export async function updatePlatformBranding(data: Record<string, unknown>) {
  const existing = await getFirstRow('platform_branding', DEFAULT_BRANDING);
  const id = (existing as any).id;
  await upsertSingleRow('platform_branding', data, id);
  return { success: true };
}

// ─── Admin APIs: Platform Branding Localized ────────────────

export async function fetchPlatformBrandingLocalized() {
  const { data, error } = await supabase
    .from('platform_branding_localized')
    .select('*')
    .order('locale');
  
  if (error) {
    console.warn('Failed to read platform_branding_localized:', error.message);
    return { items: [] };
  }
  return { items: data || [] };
}

export async function updatePlatformBrandingLocalized(locale: string, data: Record<string, unknown>) {
  const { data: existing } = await supabase
    .from('platform_branding_localized')
    .select('id')
    .eq('locale', locale)
    .maybeSingle();

  const { id: _id, ...rest } = data as any;

  if (existing?.id) {
    const { error } = await supabase
      .from('platform_branding_localized')
      .update({ ...rest, locale, updated_at: new Date().toISOString() })
      .eq('id', existing.id);
    if (error) throw new Error(error.message);
  } else {
    const { error } = await supabase
      .from('platform_branding_localized')
      .insert({ ...rest, locale });
    if (error) throw new Error(error.message);
  }
  return { success: true };
}

// ─── Admin APIs: Platform Domains ───────────────────────────

export async function fetchPlatformDomains() {
  const domains = await getFirstRow('platform_domains', DEFAULT_DOMAINS);
  return { domains };
}

export async function updatePlatformDomains(data: Record<string, unknown>) {
  const existing = await getFirstRow('platform_domains', DEFAULT_DOMAINS);
  const id = (existing as any).id;
  await upsertSingleRow('platform_domains', data, id);
  return { success: true };
}

// ─── Admin APIs: Email Settings ─────────────────────────────

export async function fetchPlatformEmailSettings() {
  const [settings, localizedResult] = await Promise.all([
    getFirstRow('email_settings', DEFAULT_EMAIL),
    supabase
      .from('email_settings_localized')
      .select('*')
      .is('workspace_id', null)
      .order('locale'),
  ]);

  return {
    settings,
    localized: localizedResult.data || [],
  };
}

export async function updatePlatformEmailSettings(data: { settings?: any; localized?: any[] }) {
  // Update main email settings
  if (data.settings) {
    const existing = await getFirstRow('email_settings', DEFAULT_EMAIL);
    const id = (existing as any).id;
    
    // Only pass columns that exist on email_settings
    const { sender_email, reply_to_email, email_logo_url, email_footer_text } = data.settings;
    await upsertSingleRow('email_settings', {
      sender_email, reply_to_email, email_logo_url, email_footer_text,
      workspace_id: null,
    }, id);
  }

  // Upsert localized entries
  if (data.localized) {
    for (const loc of data.localized) {
      const { data: existing } = await supabase
        .from('email_settings_localized')
        .select('id')
        .eq('locale', loc.locale)
        .is('workspace_id', null)
        .maybeSingle();

      const { id: _id, ...rest } = loc;
      
      if (existing?.id) {
        await supabase
          .from('email_settings_localized')
          .update({ ...rest, updated_at: new Date().toISOString() })
          .eq('id', existing.id);
      } else {
        await supabase
          .from('email_settings_localized')
          .insert({ ...rest, workspace_id: null });
      }
    }
  }

  return { success: true };
}