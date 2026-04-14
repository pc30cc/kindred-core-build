/**
 * Runtime Config API client.
 * Fetches resolved config from the self-hosted backend.
 * In production: same-origin /api/config/resolve
 * In dev: proxied through Vite to localhost:3001
 */

const API_BASE = import.meta.env.VITE_API_BASE_URL || '';

async function configFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || `Config API error: ${res.status}`);
  }
  return res.json();
}

async function getAuthHeaders(): Promise<Record<string, string>> {
  const { supabase } = await import('@/lib/supabase');
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { 'Authorization': `Bearer ${token}` } : {};
}

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

// ─── Public API ─────────────────────────────────────────────

export function fetchResolvedConfig(workspaceId?: string, locale?: string): Promise<ResolvedConfig> {
  const params = new URLSearchParams();
  if (workspaceId) params.set('workspaceId', workspaceId);
  if (locale) params.set('locale', locale);
  return configFetch<ResolvedConfig>(`/api/config/resolve?${params}`);
}

// ─── Admin APIs ─────────────────────────────────────────────

export async function fetchPlatformSettings() {
  const headers = await getAuthHeaders();
  return configFetch<{ settings: any }>('/api/config/platform/settings', { headers });
}

export async function updatePlatformSettings(data: Record<string, unknown>) {
  const headers = await getAuthHeaders();
  return configFetch<{ success: boolean }>('/api/config/platform/settings', {
    method: 'PUT', headers, body: JSON.stringify(data),
  });
}

export async function fetchPlatformBranding() {
  const headers = await getAuthHeaders();
  return configFetch<{ branding: any }>('/api/config/platform/branding', { headers });
}

export async function updatePlatformBranding(data: Record<string, unknown>) {
  const headers = await getAuthHeaders();
  return configFetch<{ success: boolean }>('/api/config/platform/branding', {
    method: 'PUT', headers, body: JSON.stringify(data),
  });
}

export async function fetchPlatformBrandingLocalized() {
  const headers = await getAuthHeaders();
  return configFetch<{ items: any[] }>('/api/config/platform/branding-localized', { headers });
}

export async function updatePlatformBrandingLocalized(locale: string, data: Record<string, unknown>) {
  const headers = await getAuthHeaders();
  return configFetch<{ success: boolean }>(`/api/config/platform/branding-localized/${locale}`, {
    method: 'PUT', headers, body: JSON.stringify(data),
  });
}

export async function fetchPlatformDomains() {
  const headers = await getAuthHeaders();
  return configFetch<{ domains: any }>('/api/config/platform/domains', { headers });
}

export async function updatePlatformDomains(data: Record<string, unknown>) {
  const headers = await getAuthHeaders();
  return configFetch<{ success: boolean }>('/api/config/platform/domains', {
    method: 'PUT', headers, body: JSON.stringify(data),
  });
}

export async function fetchPlatformEmailSettings() {
  const headers = await getAuthHeaders();
  return configFetch<{ settings: any; localized: any[] }>('/api/config/platform/email-settings', { headers });
}

export async function updatePlatformEmailSettings(data: { settings?: any; localized?: any[] }) {
  const headers = await getAuthHeaders();
  return configFetch<{ success: boolean }>('/api/config/platform/email-settings', {
    method: 'PUT', headers, body: JSON.stringify(data),
  });
}
