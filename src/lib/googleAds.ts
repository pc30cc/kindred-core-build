// Public campaign identifiers, scoped to the owner's production domains.
export const GOOGLE_ADS_ID = 'AW-11183167040';
export const SIGNUP_SEND_TO = `${GOOGLE_ADS_ID}/_HRMCLijlJIdEMCsxtQp`;
const CONSENT_COOKIE = 'webyar_ads_measurement';
type Consent = 'granted' | 'denied' | null;
type Tag = (...args: unknown[]) => void;
type AdsWindow = Window & { dataLayer?: unknown[]; gtag?: Tag };
const configured = new WeakSet<Window>();
const sent = new Set<string>();
const pending = new Set<string>();

export function isAdsProduction(): boolean {
  return typeof window !== 'undefined' && window.location.protocol === 'https:' &&
    ['webyar.ai', 'www.webyar.ai', 'app.webyar.ai'].includes(window.location.hostname);
}

export function readAdsConsent(): Consent {
  if (!isAdsProduction()) return 'denied';
  if ((navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl) return 'denied';
  const value = document.cookie.split(';').map(c => c.trim()).find(c => c.startsWith(`${CONSENT_COOKIE}=`))?.split('=')[1];
  return value === 'granted' || value === 'denied' ? value : null;
}

function safeLocation(): string {
  const url = new URL(window.location.href);
  const safe = new URL(url.origin + url.pathname);
  // Retain ad attribution, never email, verification tokens or other query data.
  for (const key of ['gclid', 'gbraid', 'wbraid']) {
    const value = url.searchParams.get(key);
    if (value) safe.searchParams.set(key, value);
  }
  return safe.href;
}

function safeReferrer(): string {
  try { const url = new URL(document.referrer); return url.origin + url.pathname; }
  catch { return ''; }
}

export function initGoogleAds(): boolean {
  if (!isAdsProduction() || readAdsConsent() !== 'granted') return false;
  const w = window as AdsWindow;
  if (configured.has(w)) return true;
  w.dataLayer ??= [];
  w.gtag ??= (...args: unknown[]) => { w.dataLayer!.push(args); };
  w.gtag('consent', 'default', {
    ad_storage: 'denied',
    ad_user_data: 'denied', ad_personalization: 'denied',
  });
  w.gtag('consent', 'update', { ad_storage: 'granted' });
  w.gtag('js', new Date());
  w.gtag('set', 'linker', { domains: ['webyar.ai', 'app.webyar.ai'] });
  w.gtag('config', GOOGLE_ADS_ID, {
    send_page_view: false, allow_ad_personalization_signals: false,
    allow_google_signals: false, cookie_domain: 'webyar.ai',
    page_location: safeLocation(), page_referrer: safeReferrer(),
  });
  if (!document.querySelector('script[src*="googletagmanager.com/gtag/js"]')) {
    const script = document.createElement('script');
    script.async = true;
    script.src = `https://www.googletagmanager.com/gtag/js?id=${GOOGLE_ADS_ID}`;
    document.head.appendChild(script);
  }
  configured.add(w);
  return true;
}

export function setAdsConsent(consent: Exclude<Consent, null>): void {
  if (!isAdsProduction()) return;
  if ((navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl) consent = 'denied';
  document.cookie = `${CONSENT_COOKIE}=${consent}; Domain=webyar.ai; Path=/; Max-Age=31536000; SameSite=Lax; Secure`;
  if (consent === 'denied') {
    pending.clear();
    (window as AdsWindow).gtag?.('consent', 'update', { ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied' });
    return;
  }
  if (initGoogleAds()) {
    (window as AdsWindow).gtag?.('consent', 'update', { ad_storage: 'granted' });
    for (const id of Array.from(pending)) trackSuccessfulSignup(id);
  }
}

/** Call only after the backend confirms a NEW account. No customer data. */
export function trackSuccessfulSignup(transactionId: string): boolean {
  if (!isAdsProduction() || !/^[a-zA-Z0-9-]{16,64}$/.test(transactionId) || sent.has(transactionId)) return false;
  const consent = readAdsConsent();
  if (consent === null) { pending.add(transactionId); return false; }
  if (consent === 'denied' || !initGoogleAds()) { pending.delete(transactionId); return false; }
  (window as AdsWindow).gtag!('event', 'conversion', {
    send_to: SIGNUP_SEND_TO, transaction_id: transactionId,
    value: 0, currency: 'TRY', page_location: safeLocation(), page_referrer: safeReferrer(),
  });
  sent.add(transactionId);
  pending.delete(transactionId);
  return true;
}
