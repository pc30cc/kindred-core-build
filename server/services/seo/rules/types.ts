import type { IssueCategory, IssueSeverity } from './policy.js';

/** The subset of a `seo_pages` row every rule function needs. Pure — no DB access — so rules are unit-testable with plain fixtures. */
export interface SeoPageForRules {
  id: string;
  url: string;
  normalizedUrl: string;
  httpStatus: number | null;
  redirectChain: Array<{ url: string; status: number }>;
  title: string | null;
  titleLength: number | null;
  metaDescription: string | null;
  metaDescriptionLength: number | null;
  canonicalUrl: string | null;
  canonicalStatus: 'missing' | 'self' | 'points_elsewhere' | 'invalid' | null;
  metaRobots: string | null;
  isIndexable: boolean;
  h1Count: number;
  h2Count: number;
  lang: string | null;
  wordCount: number;
  imagesCount: number;
  imagesMissingAltCount: number;
  hasStructuredData: boolean;
  structuredDataErrors: string[];
  isHttps: boolean;
  hasMixedContent: boolean;
  fetchError: string | null;
  responseTimeMs: number | null;
}

export interface SeoLinkForRules {
  sourceUrl: string;
  targetUrl: string;
  isExternal: boolean;
  isBroken: boolean;
  httpStatus: number | null;
}

export interface SeoSitemapForRules {
  url: string;
  status: 'valid' | 'invalid' | 'unreachable';
  errorMessage: string | null;
}

export interface RawIssue {
  issueType: string;
  category: IssueCategory;
  severity: IssueSeverity;
  title: string;
  description: string;
  recommendation: string;
  affectedUrls: string[];
}

export interface RuleContext {
  pages: SeoPageForRules[];
  links: SeoLinkForRules[];
  sitemaps: SeoSitemapForRules[];
  /** Sitemap-declared URLs that were also crawled in this run (bounded sample; see crawlSite.ts). */
  sitemapUrls: string[];
  crawledButMissingFromSitemapCount: number;
  sitemapUrlsNotCrawledCount: number;
}
