import { describe, it, expect } from 'vitest';
import { runAllRules } from '../../../server/services/seo/rules/checks.js';
import type { RuleContext, SeoPageForRules } from '../../../server/services/seo/rules/types.js';

function page(overrides: Partial<SeoPageForRules>): SeoPageForRules {
  return {
    id: overrides.id || Math.random().toString(36),
    url: 'https://example.com/',
    normalizedUrl: 'https://example.com/',
    httpStatus: 200,
    redirectChain: [],
    title: 'A perfectly fine title for this page',
    titleLength: 38,
    metaDescription: 'A perfectly reasonable meta description that sits comfortably inside the recommended length range for search engines.',
    metaDescriptionLength: 120,
    canonicalUrl: null,
    canonicalStatus: 'self',
    metaRobots: null,
    isIndexable: true,
    h1Count: 1,
    h2Count: 2,
    lang: 'en',
    wordCount: 400,
    imagesCount: 2,
    imagesMissingAltCount: 0,
    hasStructuredData: false,
    structuredDataErrors: [],
    isHttps: true,
    hasMixedContent: false,
    fetchError: null,
    responseTimeMs: 200,
    ...overrides,
  };
}

function ctx(pages: SeoPageForRules[], overrides: Partial<RuleContext> = {}): RuleContext {
  return {
    pages,
    links: [],
    sitemaps: [],
    sitemapUrls: [],
    crawledButMissingFromSitemapCount: 0,
    sitemapUrlsNotCrawledCount: 0,
    ...overrides,
  };
}

describe('SEO rules — clean site produces no issues', () => {
  it('a single well-formed page triggers nothing', () => {
    const issues = runAllRules(ctx([page({ canonicalUrl: 'https://example.com/', canonicalStatus: 'self' })]));
    expect(issues).toHaveLength(0);
  });
});

describe('SEO rules — HTTP + redirects', () => {
  it('flags 5xx pages as critical', () => {
    const issues = runAllRules(ctx([page({ url: 'https://example.com/err', httpStatus: 500 })]));
    const issue = issues.find((i) => i.issueType === 'http_5xx');
    expect(issue?.severity).toBe('critical');
    expect(issue?.affectedUrls).toContain('https://example.com/err');
  });

  it('flags 4xx pages as high severity', () => {
    const issues = runAllRules(ctx([page({ url: 'https://example.com/missing', httpStatus: 404 })]));
    expect(issues.find((i) => i.issueType === 'http_4xx')?.severity).toBe('high');
  });

  it('flags redirect loops (a URL repeated within its own chain)', () => {
    const issues = runAllRules(ctx([page({
      url: 'https://example.com/loop',
      redirectChain: [{ url: 'https://example.com/loop', status: 302 }, { url: 'https://example.com/other', status: 302 }, { url: 'https://example.com/loop', status: 302 }],
    })]));
    expect(issues.find((i) => i.issueType === 'redirect_loop')).toBeTruthy();
  });

  it('flags multi-hop redirect chains that do not loop', () => {
    const issues = runAllRules(ctx([page({
      url: 'https://example.com/a',
      redirectChain: [{ url: 'https://example.com/a', status: 301 }, { url: 'https://example.com/b', status: 301 }],
    })]));
    expect(issues.find((i) => i.issueType === 'redirect_chain')).toBeTruthy();
    expect(issues.find((i) => i.issueType === 'redirect_loop')).toBeUndefined();
  });
});

describe('SEO rules — metadata', () => {
  it('flags missing title only for indexable, successfully-fetched pages', () => {
    const issues = runAllRules(ctx([
      page({ url: 'https://example.com/no-title', title: null, titleLength: null }),
      page({ url: 'https://example.com/noindex-no-title', title: null, titleLength: null, isIndexable: false }),
    ]));
    const issue = issues.find((i) => i.issueType === 'missing_title');
    expect(issue?.affectedUrls).toEqual(['https://example.com/no-title']);
  });

  it('flags duplicate titles across pages', () => {
    const issues = runAllRules(ctx([
      page({ url: 'https://example.com/a', title: 'Same Title' }),
      page({ url: 'https://example.com/b', title: 'Same Title' }),
      page({ url: 'https://example.com/c', title: 'Different Title' }),
    ]));
    const issue = issues.find((i) => i.issueType === 'duplicate_title');
    expect(issue?.affectedUrls.sort()).toEqual(['https://example.com/a', 'https://example.com/b']);
  });

  it('flags missing meta description', () => {
    const issues = runAllRules(ctx([page({ metaDescription: null, metaDescriptionLength: null })]));
    expect(issues.find((i) => i.issueType === 'missing_meta_description')).toBeTruthy();
  });
});

describe('SEO rules — headings + canonical', () => {
  it('flags missing and multiple H1', () => {
    const issues = runAllRules(ctx([
      page({ url: 'https://example.com/none', h1Count: 0 }),
      page({ url: 'https://example.com/many', h1Count: 3 }),
    ]));
    expect(issues.find((i) => i.issueType === 'missing_h1')?.affectedUrls).toContain('https://example.com/none');
    expect(issues.find((i) => i.issueType === 'multiple_h1')?.affectedUrls).toContain('https://example.com/many');
  });

  it('flags a canonical pointing at a page that is itself an error/non-indexable', () => {
    const target = page({ url: 'https://example.com/dead', normalizedUrl: 'https://example.com/dead', httpStatus: 404 });
    const source = page({
      url: 'https://example.com/source', normalizedUrl: 'https://example.com/source',
      canonicalStatus: 'points_elsewhere', canonicalUrl: 'https://example.com/dead',
    });
    const issues = runAllRules(ctx([source, target]));
    const issue = issues.find((i) => i.issueType === 'canonical_to_non_indexable');
    expect(issue?.affectedUrls).toEqual(['https://example.com/source']);
  });
});

describe('SEO rules — security + images + content', () => {
  it('flags non-HTTPS and mixed content separately', () => {
    const issues = runAllRules(ctx([
      page({ url: 'https://example.com/http-page', isHttps: false }),
      page({ url: 'https://example.com/mixed', hasMixedContent: true }),
    ]));
    expect(issues.find((i) => i.issueType === 'not_https')?.affectedUrls).toContain('https://example.com/http-page');
    expect(issues.find((i) => i.issueType === 'mixed_content')?.affectedUrls).toContain('https://example.com/mixed');
  });

  it('flags images missing alt text', () => {
    const issues = runAllRules(ctx([page({ imagesMissingAltCount: 3 })]));
    expect(issues.find((i) => i.issueType === 'images_missing_alt')).toBeTruthy();
  });

  it('flags thin content on indexable pages only', () => {
    const issues = runAllRules(ctx([
      page({ url: 'https://example.com/thin', wordCount: 20 }),
      page({ url: 'https://example.com/thin-noindex', wordCount: 20, isIndexable: false }),
    ]));
    expect(issues.find((i) => i.issueType === 'low_content')?.affectedUrls).toEqual(['https://example.com/thin']);
  });
});

describe('SEO rules — links + sitemap', () => {
  it('flags broken internal links by source page, not target', () => {
    const issues = runAllRules(ctx([page({})], {
      links: [
        { sourceUrl: 'https://example.com/', targetUrl: 'https://example.com/dead', isExternal: false, isBroken: true, httpStatus: 404 },
        { sourceUrl: 'https://example.com/', targetUrl: 'https://google.com', isExternal: true, isBroken: false, httpStatus: null },
      ],
    }));
    const issue = issues.find((i) => i.issueType === 'broken_internal_links');
    expect(issue?.affectedUrls).toEqual(['https://example.com/']);
  });

  it('flags sitemap fetch/parse errors', () => {
    const issues = runAllRules(ctx([page({})], {
      sitemaps: [{ url: 'https://example.com/sitemap.xml', status: 'unreachable', errorMessage: 'timeout' }],
    }));
    expect(issues.find((i) => i.issueType === 'sitemap_errors')).toBeTruthy();
  });

  it('flags a non-indexable/erroring URL that is nonetheless listed in the sitemap', () => {
    const dead = page({ url: 'https://example.com/dead', normalizedUrl: 'https://example.com/dead', httpStatus: 404 });
    const issues = runAllRules(ctx([dead], { sitemapUrls: ['https://example.com/dead'] }));
    const issue = issues.find((i) => i.issueType === 'sitemap_non_indexable_urls');
    expect(issue?.affectedUrls).toEqual(['https://example.com/dead']);
  });
});
