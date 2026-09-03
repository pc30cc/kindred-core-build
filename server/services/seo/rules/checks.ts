/**
 * SEO rule set — pure functions over normalized crawl data. Each function is
 * independently unit-testable with plain fixtures (no DB, no network). The
 * UI never sees raw crawler output; this is the ONLY place that turns
 * normalized pages/links/sitemaps into `seo_issues`.
 */
import { SEO_POLICY } from './policy.js';
import type { RawIssue, RuleContext, SeoPageForRules } from './types.js';

type Rule = (ctx: RuleContext) => RawIssue[];

function issue(partial: RawIssue): RawIssue[] {
  return partial.affectedUrls.length ? [partial] : [];
}

function indexableCandidates(pages: SeoPageForRules[]): SeoPageForRules[] {
  return pages.filter((p) => p.httpStatus !== null && p.httpStatus < 400 && p.isIndexable);
}

const serverErrors: Rule = ({ pages }) => {
  const affected = pages.filter((p) => p.httpStatus !== null && p.httpStatus >= 500);
  return issue({
    issueType: 'http_5xx', category: 'http', severity: 'critical',
    title: 'Pages returning server errors (5xx)',
    description: 'These pages returned a server error when crawled, meaning both users and search engines cannot access them.',
    recommendation: 'Investigate the server logs for these URLs and fix the underlying error.',
    affectedUrls: affected.map((p) => p.url),
  });
};

const clientErrors: Rule = ({ pages }) => {
  const affected = pages.filter((p) => p.httpStatus !== null && p.httpStatus >= 400 && p.httpStatus < 500);
  return issue({
    issueType: 'http_4xx', category: 'http', severity: 'high',
    title: 'Pages returning client errors (4xx)',
    description: 'These URLs returned a 4xx status (e.g. 404 Not Found). Any inbound links or sitemap entries pointing at them are being wasted.',
    recommendation: 'Fix or remove links pointing at these URLs, or restore/redirect the missing content.',
    affectedUrls: affected.map((p) => p.url),
  });
};

const brokenInternalLinks: Rule = ({ links }) => {
  const affected = links.filter((l) => !l.isExternal && l.isBroken);
  return issue({
    issueType: 'broken_internal_links', category: 'links', severity: 'high',
    title: 'Broken internal links',
    description: 'Internal links point at pages that returned an error or could not be resolved during this crawl.',
    recommendation: 'Update these links to point at a working URL, or remove them.',
    affectedUrls: Array.from(new Set(affected.map((l) => l.sourceUrl))),
  });
};

const redirectChains: Rule = ({ pages }) => {
  const affected = pages.filter((p) => p.redirectChain.length >= 2);
  return issue({
    issueType: 'redirect_chain', category: 'http', severity: 'medium',
    title: 'Multi-hop redirect chains',
    description: 'These URLs redirect through more than one hop before reaching their final destination, wasting crawl budget and slowing page load.',
    recommendation: 'Point the original link directly at the final destination URL.',
    affectedUrls: affected.map((p) => p.url),
  });
};

const redirectLoops: Rule = ({ pages }) => {
  const affected = pages.filter((p) => {
    const seen = new Set<string>();
    for (const hop of p.redirectChain) {
      if (seen.has(hop.url)) return true;
      seen.add(hop.url);
    }
    return false;
  });
  return issue({
    issueType: 'redirect_loop', category: 'http', severity: 'critical',
    title: 'Redirect loops',
    description: 'These URLs redirect back to a URL already visited earlier in the same redirect chain, so the destination is never reached.',
    recommendation: 'Remove the circular redirect and point it at a real destination.',
    affectedUrls: affected.map((p) => p.url),
  });
};

const missingTitle: Rule = ({ pages }) => {
  const affected = indexableCandidates(pages).filter((p) => !p.title);
  return issue({
    issueType: 'missing_title', category: 'metadata', severity: 'high',
    title: 'Missing page title',
    description: 'These indexable pages have no <title> tag, which is one of the strongest on-page ranking signals.',
    recommendation: 'Add a unique, descriptive <title> to each page.',
    affectedUrls: affected.map((p) => p.url),
  });
};

const titleLength: Rule = ({ pages }) => {
  const { minLength, maxLength } = SEO_POLICY.title;
  const affected = indexableCandidates(pages).filter((p) => p.title && (p.titleLength! < minLength || p.titleLength! > maxLength));
  return issue({
    issueType: 'title_length', category: 'metadata', severity: 'low',
    title: 'Title length outside recommended range',
    description: `Titles shorter than ${minLength} or longer than ${maxLength} characters are often truncated or under-optimized in search results.`,
    recommendation: `Aim for a title between ${minLength} and ${maxLength} characters.`,
    affectedUrls: affected.map((p) => p.url),
  });
};

const duplicateTitle: Rule = ({ pages }) => {
  const groups = new Map<string, SeoPageForRules[]>();
  for (const p of indexableCandidates(pages)) {
    if (!p.title) continue;
    const key = p.title.trim().toLowerCase();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(p);
  }
  const affected: SeoPageForRules[] = [];
  for (const group of groups.values()) if (group.length > 1) affected.push(...group);
  return issue({
    issueType: 'duplicate_title', category: 'metadata', severity: 'medium',
    title: 'Duplicate page titles',
    description: 'Multiple indexable pages share the exact same title, which makes it harder for search engines to tell them apart.',
    recommendation: 'Give each page a unique, descriptive title.',
    affectedUrls: affected.map((p) => p.url),
  });
};

const missingMetaDescription: Rule = ({ pages }) => {
  const affected = indexableCandidates(pages).filter((p) => !p.metaDescription);
  return issue({
    issueType: 'missing_meta_description', category: 'metadata', severity: 'medium',
    title: 'Missing meta description',
    description: 'These indexable pages have no meta description, so search engines will generate a snippet automatically.',
    recommendation: 'Write a unique meta description summarizing the page content.',
    affectedUrls: affected.map((p) => p.url),
  });
};

const metaDescriptionLength: Rule = ({ pages }) => {
  const { minLength, maxLength } = SEO_POLICY.metaDescription;
  const affected = indexableCandidates(pages).filter(
    (p) => p.metaDescription && (p.metaDescriptionLength! < minLength || p.metaDescriptionLength! > maxLength),
  );
  return issue({
    issueType: 'meta_description_length', category: 'metadata', severity: 'low',
    title: 'Meta description length outside recommended range',
    description: `Descriptions shorter than ${minLength} or longer than ${maxLength} characters are often truncated or under-informative in search results.`,
    recommendation: `Aim for a meta description between ${minLength} and ${maxLength} characters.`,
    affectedUrls: affected.map((p) => p.url),
  });
};

const duplicateMetaDescription: Rule = ({ pages }) => {
  const groups = new Map<string, SeoPageForRules[]>();
  for (const p of indexableCandidates(pages)) {
    if (!p.metaDescription) continue;
    const key = p.metaDescription.trim().toLowerCase();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(p);
  }
  const affected: SeoPageForRules[] = [];
  for (const group of groups.values()) if (group.length > 1) affected.push(...group);
  return issue({
    issueType: 'duplicate_meta_description', category: 'metadata', severity: 'low',
    title: 'Duplicate meta descriptions',
    description: 'Multiple indexable pages share the exact same meta description.',
    recommendation: 'Write a unique meta description for each page.',
    affectedUrls: affected.map((p) => p.url),
  });
};

const missingH1: Rule = ({ pages }) => {
  const affected = indexableCandidates(pages).filter((p) => p.h1Count === 0);
  return issue({
    issueType: 'missing_h1', category: 'content', severity: 'medium',
    title: 'Missing H1 heading',
    description: 'These indexable pages have no H1 heading.',
    recommendation: 'Add a single, descriptive H1 heading to each page.',
    affectedUrls: affected.map((p) => p.url),
  });
};

const multipleH1: Rule = ({ pages }) => {
  const affected = indexableCandidates(pages).filter((p) => p.h1Count > 1);
  return issue({
    issueType: 'multiple_h1', category: 'content', severity: 'low',
    title: 'Multiple H1 headings',
    description: 'These pages have more than one H1 heading, which can dilute the page’s topical signal.',
    recommendation: 'Use a single H1 per page; use H2/H3 for subsections.',
    affectedUrls: affected.map((p) => p.url),
  });
};

const missingCanonical: Rule = ({ pages }) => {
  const affected = indexableCandidates(pages).filter((p) => p.canonicalStatus === 'missing');
  return issue({
    issueType: 'missing_canonical', category: 'canonical', severity: 'low',
    title: 'Missing canonical tag',
    description: 'These pages have no canonical tag, leaving search engines to guess the preferred URL.',
    recommendation: 'Add a self-referencing canonical tag to each indexable page.',
    affectedUrls: affected.map((p) => p.url),
  });
};

const invalidCanonical: Rule = ({ pages }) => {
  const affected = pages.filter((p) => p.canonicalStatus === 'invalid');
  return issue({
    issueType: 'invalid_canonical', category: 'canonical', severity: 'medium',
    title: 'Invalid canonical tag',
    description: 'The canonical tag on these pages could not be parsed as a valid URL.',
    recommendation: 'Fix the canonical tag to point at a valid absolute URL.',
    affectedUrls: affected.map((p) => p.url),
  });
};

const canonicalToNonIndexable: Rule = ({ pages }) => {
  const byNormalized = new Map(pages.map((p) => [p.normalizedUrl, p]));
  const affected = pages.filter((p) => {
    if (p.canonicalStatus !== 'points_elsewhere' || !p.canonicalUrl) return false;
    const target = byNormalized.get(p.canonicalUrl);
    if (!target) return false;
    return !target.isIndexable || (target.httpStatus !== null && target.httpStatus >= 400);
  });
  return issue({
    issueType: 'canonical_to_non_indexable', category: 'canonical', severity: 'high',
    title: 'Canonical points to a non-indexable or error page',
    description: 'The canonical URL for these pages resolves to a page that is noindexed or returns an error, which can remove both pages from the index.',
    recommendation: 'Point the canonical tag at a valid, indexable URL.',
    affectedUrls: affected.map((p) => p.url),
  });
};

const noindexPages: Rule = ({ pages }) => {
  const affected = pages.filter((p) => !p.isIndexable && p.httpStatus !== null && p.httpStatus < 400);
  return issue({
    issueType: 'noindex_pages', category: 'indexability', severity: 'info',
    title: 'Noindex pages',
    description: 'These pages are explicitly excluded from search indexing via meta robots or X-Robots-Tag.',
    recommendation: 'Verify this is intentional; remove the noindex directive if the page should rank.',
    affectedUrls: affected.map((p) => p.url),
  });
};

const robotsBlocked: Rule = ({ pages }) => {
  const affected = pages.filter((p) => p.fetchError === 'robots_blocked');
  return issue({
    issueType: 'robots_blocked', category: 'robots', severity: 'info',
    title: 'URLs disallowed by robots.txt',
    description: 'These URLs were skipped because robots.txt disallows crawling them.',
    recommendation: 'Verify this is intentional; adjust robots.txt if these pages should be crawlable.',
    affectedUrls: affected.map((p) => p.url),
  });
};

const notHttps: Rule = ({ pages }) => {
  const affected = pages.filter((p) => !p.isHttps);
  return issue({
    issueType: 'not_https', category: 'security', severity: 'high',
    title: 'Pages served over HTTP',
    description: 'These pages were served without HTTPS, which harms both security and search ranking.',
    recommendation: 'Serve all pages over HTTPS and redirect HTTP to HTTPS.',
    affectedUrls: affected.map((p) => p.url),
  });
};

const mixedContent: Rule = ({ pages }) => {
  const affected = pages.filter((p) => p.hasMixedContent);
  return issue({
    issueType: 'mixed_content', category: 'security', severity: 'medium',
    title: 'Mixed content',
    description: 'These HTTPS pages reference resources over plain HTTP, which browsers may block or flag as insecure.',
    recommendation: 'Update all resource references to use HTTPS.',
    affectedUrls: affected.map((p) => p.url),
  });
};

const imagesMissingAlt: Rule = ({ pages }) => {
  const affected = pages.filter((p) => p.imagesMissingAltCount > 0);
  return issue({
    issueType: 'images_missing_alt', category: 'images', severity: 'low',
    title: 'Images missing alt text',
    description: 'These pages contain images without alt text, which harms accessibility and image search visibility.',
    recommendation: 'Add descriptive alt text to every meaningful image.',
    affectedUrls: affected.map((p) => p.url),
  });
};

const lowContent: Rule = ({ pages }) => {
  const affected = indexableCandidates(pages).filter((p) => p.wordCount < SEO_POLICY.lowContentWordCount);
  return issue({
    issueType: 'low_content', category: 'content', severity: 'low',
    title: 'Thin content pages',
    description: `These indexable pages have fewer than ${SEO_POLICY.lowContentWordCount} words of visible text.`,
    recommendation: 'Expand the content or mark the page noindex if it is not meant to rank.',
    affectedUrls: affected.map((p) => p.url),
  });
};

const missingLang: Rule = ({ pages }) => {
  const affected = indexableCandidates(pages).filter((p) => !p.lang);
  return issue({
    issueType: 'missing_lang', category: 'content', severity: 'info',
    title: 'Missing HTML lang attribute',
    description: 'These pages have no lang attribute on the <html> element, which helps search engines and assistive tech determine language.',
    recommendation: 'Add a lang attribute (e.g. lang="en") to the <html> tag.',
    affectedUrls: affected.map((p) => p.url),
  });
};

const structuredDataErrors: Rule = ({ pages }) => {
  const affected = pages.filter((p) => p.structuredDataErrors.length > 0);
  return issue({
    issueType: 'structured_data_errors', category: 'structured_data', severity: 'low',
    title: 'Invalid structured data',
    description: 'These pages contain JSON-LD structured data that could not be parsed.',
    recommendation: 'Validate and fix the JSON-LD markup.',
    affectedUrls: affected.map((p) => p.url),
  });
};

const slowPages: Rule = ({ pages }) => {
  const affected = pages.filter((p) => (p.responseTimeMs || 0) > SEO_POLICY.slowResponseMs);
  return issue({
    issueType: 'slow_response', category: 'performance', severity: 'low',
    title: 'Slow server response time',
    description: `These pages took more than ${SEO_POLICY.slowResponseMs}ms to respond during the crawl.`,
    recommendation: 'Investigate server/backend response time for these URLs.',
    affectedUrls: affected.map((p) => p.url),
  });
};

const sitemapErrors: Rule = ({ sitemaps }) => {
  const affected = sitemaps.filter((s) => s.status !== 'valid');
  return issue({
    issueType: 'sitemap_errors', category: 'sitemap', severity: 'medium',
    title: 'Sitemap errors',
    description: 'One or more discovered sitemaps could not be fetched or parsed.',
    recommendation: 'Fix or remove the invalid sitemap entries.',
    affectedUrls: affected.map((s) => s.url),
  });
};

const sitemapCoverageGap: Rule = ({ crawledButMissingFromSitemapCount }) => {
  if (crawledButMissingFromSitemapCount <= 0) return [];
  return [{
    issueType: 'sitemap_coverage_gap', category: 'sitemap', severity: 'info',
    title: 'Crawled pages missing from sitemap',
    description: `${crawledButMissingFromSitemapCount} page(s) reachable by crawling this site were not found in any discovered sitemap.`,
    recommendation: 'Add these URLs to the sitemap so search engines can discover them directly.',
    affectedUrls: [],
  }];
};

const sitemapContainsNonIndexable: Rule = ({ pages, sitemapUrls }) => {
  const sitemapSet = new Set(sitemapUrls);
  const affected = pages.filter((p) => sitemapSet.has(p.normalizedUrl) && (!p.isIndexable || (p.httpStatus !== null && p.httpStatus >= 400)));
  return issue({
    issueType: 'sitemap_non_indexable_urls', category: 'sitemap', severity: 'medium',
    title: 'Non-indexable or erroring URLs listed in sitemap',
    description: 'The sitemap lists URLs that are noindexed or return an error, which wastes crawl budget and can confuse search engines.',
    recommendation: 'Remove non-indexable and erroring URLs from the sitemap.',
    affectedUrls: affected.map((p) => p.url),
  });
};

export const SEO_RULES: Rule[] = [
  serverErrors,
  clientErrors,
  brokenInternalLinks,
  redirectChains,
  redirectLoops,
  missingTitle,
  titleLength,
  duplicateTitle,
  missingMetaDescription,
  metaDescriptionLength,
  duplicateMetaDescription,
  missingH1,
  multipleH1,
  missingCanonical,
  invalidCanonical,
  canonicalToNonIndexable,
  noindexPages,
  robotsBlocked,
  notHttps,
  mixedContent,
  imagesMissingAlt,
  lowContent,
  missingLang,
  structuredDataErrors,
  slowPages,
  sitemapErrors,
  sitemapCoverageGap,
  sitemapContainsNonIndexable,
];

export function runAllRules(ctx: RuleContext): RawIssue[] {
  const out: RawIssue[] = [];
  for (const rule of SEO_RULES) out.push(...rule(ctx));
  return out;
}
