/**
 * SEO rules — centralized thresholds. Every rule function in checks.ts reads
 * its limits from here; nothing is hardcoded inline in a rule body, so a
 * threshold change never requires hunting through the rule set.
 */
export const SEO_POLICY = {
  title: { minLength: 30, maxLength: 60 },
  metaDescription: { minLength: 70, maxLength: 160 },
  lowContentWordCount: 100,
  slowResponseMs: 3000,
} as const;

export type IssueSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export type IssueCategory =
  | 'crawlability' | 'indexability' | 'http' | 'metadata' | 'content'
  | 'links' | 'images' | 'canonical' | 'sitemap' | 'robots' | 'security'
  | 'performance' | 'structured_data';
