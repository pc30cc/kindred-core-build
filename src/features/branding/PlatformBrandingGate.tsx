/**
 * PlatformBrandingGate: Loads platform_branding + platform_branding_localized
 * (GET /api/platform/public/config) and sets document.title, favicon, and CSS
 * custom properties globally.
 *
 * In international mode (src/lib/internationalMode.ts) the favicon and the
 * home-screen icon are the RESPOK kit's (over the operator's own), as
 * index.html's boot script already set them; leaving it (Persian) puts
 * back what WebYar shows.
 */
import React, { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchPlatformPublicConfig } from '@/lib/platformPublicConfig';
import { useI18n } from '@/i18n';
import { isNativePlatform } from '@/lib/native';
import { API_BASE } from '@/lib/apiBase';
import { INTL_BRAND, useInternationalMode } from '@/lib/internationalMode';
import { setPlatformBrand } from '@/lib/brand';
import { resolveEdition } from '../../../shared/edition';

/** index.html's own favicon, put back when international mode ends. */
const DEFAULT_FAVICON = '/favicon.png';

interface PlatformBrandingRow {
  logo_url: string | null;
  favicon_url: string | null;
  primary_color: string | null;
  secondary_color: string | null;
  pwa_icon_url: string | null;
  pwa_enabled: boolean;
  pwa_short_name: string | null;
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
      const { branding, localized, region, brand } = await fetchPlatformPublicConfig();
      return {
        branding: branding as PlatformBrandingRow | null,
        localized: localized as PlatformBrandingLocalizedRow[],
        // The edition (shared/edition.ts) and the brand's public contact.
        edition: resolveEdition(region?.region_mode),
        siteUrl: brand?.site_url ?? null,
        supportEmail: brand?.support_email ?? null,
      };
    },
    staleTime: 5 * 60 * 1000,
  });
}

export function PlatformBrandingGate({ children }: { children: React.ReactNode }) {
  const { data } = usePlatformBrandingGlobal();
  const { locale } = useI18n();
  const international = useInternationalMode();

  useEffect(() => {
    if (!data) return;

    const { branding, localized } = data;

    // The brand in text (src/lib/brand.ts): every `{{brand}}` token follows
    // the edition — WebYar's own strings in Iran, the platform's name here.
    setPlatformBrand({
      edition: data.edition,
      localized: localized ?? [],
      siteUrl: data.siteUrl,
      supportEmail: data.supportEmail,
    });

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
      const metaDesc = document.querySelector('meta[name="description"]');
      if (metaDesc) metaDesc.setAttribute('content', locRow.meta_description);
    }

    // Set OG title
    const ogTitle = document.querySelector('meta[property="og:title"]');
    if (ogTitle) ogTitle.setAttribute('content', title);

    // Set favicon: the kit's in international mode, else the operator's. A
    // page that wore the kit's (boot script, or a language switch) gets
    // index.html's own back when there is no operator favicon.
    const iconHref = international ? INTL_BRAND.appIcon : branding?.favicon_url;
    const existingIcon = document.querySelector('link[rel="icon"]') as HTMLLinkElement | null;
    const woreIntlIcon = existingIcon?.getAttribute('type') === 'image/svg+xml' && existingIcon.href.includes(INTL_BRAND.appIcon);
    if (iconHref || woreIntlIcon) {
      let link = existingIcon;
      if (!link) {
        link = document.createElement('link');
        link.rel = 'icon';
        document.head.appendChild(link);
      }
      if (international) link.type = 'image/svg+xml';
      else if (woreIntlIcon) link.type = 'image/png';
      link.href = iconHref || DEFAULT_FAVICON;
    }

    // ── PWA head tags ────────────────────────────────────────────────
    // Never inside the native Capacitor shell: that webview loads the
    // bundled dist/ directly (capacitor.config.ts webDir), not this page
    // over the network, so a web-app manifest / install prompt is
    // meaningless there and would only be visual noise in the DOM.
    // `pwa_enabled` is the operator's own kill switch (Super Admin →
    // Branding) for the installable-web-app feature on this deployment.
    const pwaOn = branding?.pwa_enabled !== false && !isNativePlatform();
    // The API can live on a different host than the app (api.example.com vs
    // app.example.com), so the manifest URL is built from the SAME base every
    // other API call uses — a bare `/api/...` 404s on deployments whose app
    // host does not proxy the API. `origin` lets the server emit a
    // same-origin start_url/scope, which browsers require.
    const manifestHref = pwaOn
      ? `${API_BASE}/api/manifest.webmanifest?locale=${encodeURIComponent(locale)}&origin=${encodeURIComponent(window.location.origin)}`
      : null;
    let manifestLink = document.querySelector('link[rel="manifest"]') as HTMLLinkElement | null;
    if (manifestHref) {
      if (!manifestLink) {
        manifestLink = document.createElement('link');
        manifestLink.rel = 'manifest';
        document.head.appendChild(manifestLink);
      }
      manifestLink.crossOrigin = 'anonymous';
      manifestLink.href = manifestHref;
    } else if (manifestLink) {
      manifestLink.remove();
    }


    const setMeta = (name: string, content: string | null, attr: 'name' | 'property' = 'name') => {
      let tag = document.querySelector(`meta[${attr}="${name}"]`) as HTMLMetaElement | null;
      if (!content) { tag?.remove(); return; }
      if (!tag) {
        tag = document.createElement('meta');
        tag.setAttribute(attr, name);
        document.head.appendChild(tag);
      }
      tag.setAttribute('content', content);
    };
    const setLink = (rel: string, href: string | null) => {
      let tag = document.querySelector(`link[rel="${rel}"]`) as HTMLLinkElement | null;
      if (!href) { tag?.remove(); return; }
      if (!tag) {
        tag = document.createElement('link');
        tag.rel = rel;
        document.head.appendChild(tag);
      }
      tag.href = href;
    };

    setMeta('theme-color', pwaOn ? (branding?.primary_color || '#3B82F6') : null);
    // iOS Safari ignores the manifest for "Add to Home Screen" icon/behavior
    // and relies on these tags instead; Android/Chrome mostly reads the
    // manifest but `mobile-web-app-capable` is kept for older engines.
    setLink(
      'apple-touch-icon',
      pwaOn ? (international ? INTL_BRAND.appleTouchIcon : branding?.pwa_icon_url || branding?.favicon_url || null) : null,
    );
    setMeta('apple-mobile-web-app-capable', pwaOn ? 'yes' : null);
    setMeta('mobile-web-app-capable', pwaOn ? 'yes' : null);
    setMeta('apple-mobile-web-app-status-bar-style', pwaOn ? 'default' : null);
    // The iOS home-screen label needs to be short (unlike the browser
    // <title>) -- prefer the dedicated short_name, then the plain platform
    // name, and only fall back to the (possibly long) full title.
    setMeta('apple-mobile-web-app-title', pwaOn ? (branding?.pwa_short_name || locRow?.platform_name || title || null) : null);
  }, [data, locale, international]);

  return <>{children}</>;
}
