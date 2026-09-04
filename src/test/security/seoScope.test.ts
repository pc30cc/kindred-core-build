/**
 * SEO crawl-scope security properties (explicit spec requirements):
 *   - registering example.com does NOT authorize crawling admin.example.com
 *     (or any other subdomain) — each subdomain needs its own registration.
 *   - www.example.com and example.com are treated as the SAME site (a
 *     canonical alias), without that opening the door to arbitrary other
 *     subdomains.
 *   - a page found while crawling example.com may link to external domains
 *     (google.com, cdn.example-other.com, ...); those links must be
 *     recorded for reporting but the crawler must never treat them as
 *     same-domain / fetchable.
 */
import { describe, it, expect } from 'vitest';
import { isSameDomain, normalizeHost, canonicalize } from '../../../server/services/ai-agent/crawler/urlRules.js';
import { parseHtml } from '../../../server/services/seo/crawler/htmlParse.js';

describe('SEO crawl scope — subdomain isolation', () => {
  const registeredHost = normalizeHost('example.com');

  it('authorizes the exact registered host', () => {
    expect(isSameDomain('https://example.com/about', registeredHost)).toBe(true);
  });

  it('treats www as the canonical alias of the apex domain', () => {
    expect(isSameDomain('https://www.example.com/about', registeredHost)).toBe(true);
  });

  it('does NOT authorize an unregistered subdomain just because the apex is registered', () => {
    expect(isSameDomain('https://admin.example.com/', registeredHost)).toBe(false);
    expect(isSameDomain('https://shop.example.com/', registeredHost)).toBe(false);
    expect(isSameDomain('https://api.example.com/', registeredHost)).toBe(false);
  });

  it('does NOT authorize a totally different domain', () => {
    expect(isSameDomain('https://example-other.com/', registeredHost)).toBe(false);
    expect(isSameDomain('https://google.com/', registeredHost)).toBe(false);
  });

  it('a subdomain registered on its own does not inherit apex authorization either way', () => {
    const subHost = normalizeHost('admin.example.com');
    expect(isSameDomain('https://example.com/', subHost)).toBe(false);
    expect(isSameDomain('https://admin.example.com/', subHost)).toBe(true);
  });
});

describe('SEO crawl scope — external links are recorded, never treated as crawlable', () => {
  const registeredHost = normalizeHost('example.com');

  it('classifies discovered links into internal (crawlable) vs external (report-only)', () => {
    const html = `
      <html><body>
        <a href="/about">About</a>
        <a href="https://www.example.com/pricing">Pricing (www alias)</a>
        <a href="https://google.com">Google</a>
        <a href="https://instagram.com/ourbrand">Instagram</a>
        <a href="https://cdn.example-other.com/lib.js">Other CDN</a>
        <a href="https://admin.example.com/login">Admin subdomain</a>
      </body></html>`;
    const parsed = parseHtml(html, 'https://example.com/');

    // htmlParse.ts already resolves every href to an absolute URL against
    // the page's own URL; canonicalize() here mirrors what crawlSite.ts does
    // before the same-domain check.
    const classified = parsed.links.map((l) => {
      const c = canonicalize(l.href);
      const url = c.ok && c.url ? c.url : l.href;
      return { href: l.href, isExternal: !isSameDomain(url, registeredHost) };
    });

    expect(classified.find((c) => c.href === 'https://example.com/about')?.isExternal).toBe(false);
    expect(classified.find((c) => c.href.includes('www.example.com'))?.isExternal).toBe(false);
    expect(classified.find((c) => c.href.includes('google.com'))?.isExternal).toBe(true);
    expect(classified.find((c) => c.href.includes('instagram.com'))?.isExternal).toBe(true);
    expect(classified.find((c) => c.href.includes('cdn.example-other.com'))?.isExternal).toBe(true);
    // The subdomain is external from the crawl-scope's point of view too —
    // it must never be silently treated as fetchable just because it shares
    // the root domain.
    expect(classified.find((c) => c.href.includes('admin.example.com'))?.isExternal).toBe(true);
  });
});
