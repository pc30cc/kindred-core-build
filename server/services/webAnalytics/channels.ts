/**
 * Traffic-source channel classification — a pure function over data already
 * captured at session creation (referrer, utm_source, utm_medium). No new
 * tracking, no vendor call: this is the same heuristic every analytics tool
 * (GA4, Plausible, Fathom) uses to turn a raw referrer + UTM pair into a
 * human channel name.
 */

export type Channel =
  | 'direct' | 'organic_search' | 'paid_search' | 'organic_social'
  | 'paid_social' | 'email' | 'referral' | 'other';

const SEARCH_ENGINES = [
  'google.', 'bing.com', 'yahoo.', 'duckduckgo.com', 'baidu.com', 'yandex.',
  'ecosia.org', 'startpage.com', 'ask.com',
];

const SOCIAL_NETWORKS = [
  'facebook.com', 'fb.com', 'instagram.com', 'twitter.com', 'x.com', 't.co',
  'linkedin.com', 'pinterest.', 'reddit.com', 'tiktok.com', 'youtube.com',
  'snapchat.com', 'telegram.org', 't.me', 'whatsapp.com',
];

function hostnameOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(url) ? url : `https://${url}`;
    return new URL(withScheme).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

function matchesAny(host: string, needles: string[]): boolean {
  return needles.some((n) => host.includes(n));
}

export function classifyChannel(input: { referrer: string | null; utmSource: string | null; utmMedium: string | null }): Channel {
  const medium = (input.utmMedium || '').toLowerCase().trim();
  const source = (input.utmSource || '').toLowerCase().trim();

  if (medium === 'email' || medium === 'newsletter') return 'email';
  if (medium === 'cpc' || medium === 'ppc' || medium === 'paid' || medium.startsWith('paid')) {
    if (source && matchesAny(source, SOCIAL_NETWORKS.map((s) => s.replace(/\.$/, '')))) return 'paid_social';
    return 'paid_search';
  }
  if (medium === 'social' || medium === 'social-paid') return medium === 'social-paid' ? 'paid_social' : 'organic_social';

  const referrerHost = hostnameOf(input.referrer);
  if (!referrerHost) return input.utmSource ? 'referral' : 'direct';
  if (matchesAny(referrerHost, SEARCH_ENGINES)) return 'organic_search';
  if (matchesAny(referrerHost, SOCIAL_NETWORKS)) return 'organic_social';
  return 'referral';
}

export function referrerDomain(referrer: string | null | undefined): string {
  return hostnameOf(referrer) || '(direct)';
}
