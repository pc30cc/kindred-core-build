/**
 * External links the native app can open (App Store review page, support).
 *
 * Values come from the same deterministic runtime configuration used for the
 * API base (`config/mobile-runtime.json` → `dist/runtime-config.js`), so they
 * are deployment-specific and never hardcoded to a brand in the codebase.
 * When a link is not configured, its row is simply hidden.
 */
function runtimeValue(key: 'appStoreUrl' | 'supportUrl'): string {
  if (typeof window === 'undefined') return '';
  const cfg = (window as unknown as { __APP_RUNTIME_CONFIG__?: Record<string, unknown> })
    .__APP_RUNTIME_CONFIG__;
  const value = cfg?.[key];
  return typeof value === 'string' ? value.trim() : '';
}

export function appStoreUrl(): string {
  return runtimeValue('appStoreUrl');
}

export function supportUrl(): string {
  return runtimeValue('supportUrl');
}

/** Open an external URL outside the app's web view. */
export function openExternal(url: string) {
  if (!url) return;
  window.open(url, '_blank', 'noopener,noreferrer');
}
