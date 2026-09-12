/**
 * SEO suite navigation tree — the two-level structure behind the SEO area's
 * nested sidebar (icon rail of 6 tools, each with its own list of reports).
 * Modeled on Ahrefs' real product IA (Site Explorer, Bot Analytics, Site
 * Audit, Rank Tracker, GSC Insights, Brand Radar), reduced to what this app
 * can actually back today vs. what is still on the roadmap — see each
 * section's `built` flag and each leaf's `built` flag.
 *
 * Web Analytics (generic site-traffic/behavior reporting) lives outside this
 * tree as its own main-menu item — see src/pages/app/analytics/ — since it
 * isn't search-specific like the tools here.
 *
 * `needsSite` marks sections that operate on one registered workspace_domains
 * site (Site Audit, Rank Tracker, Site Explorer); sections without it
 * (Bot Analytics, GSC Insights, Brand Radar) are workspace- or brand-level
 * and don't require picking a site first.
 */
import type { LucideIcon } from 'lucide-react';
import {
  Sparkles, Globe2, Bot, Radar, TrendingUp, Search,
} from 'lucide-react';

export interface SeoNavLeaf {
  type: 'leaf';
  key: string;
  labelKey: string;
  /** False = renders the shared "on the roadmap" placeholder instead of real content. */
  built: boolean;
}

export interface SeoNavGroup {
  type: 'group';
  key: string;
  labelKey: string;
  children: SeoNavLeaf[];
}

export type SeoNavItem = SeoNavLeaf | SeoNavGroup;

export interface SeoSection {
  key: string;
  labelKey: string;
  icon: LucideIcon;
  needsSite: boolean;
  built: boolean;
  items: SeoNavItem[];
}

function leaf(key: string, labelKey: string, built: boolean): SeoNavLeaf {
  return { type: 'leaf', key, labelKey, built };
}

function group(key: string, labelKey: string, children: SeoNavLeaf[]): SeoNavGroup {
  return { type: 'group', key, labelKey, children };
}

export const SEO_SECTIONS: SeoSection[] = [
  {
    key: 'site-audit',
    labelKey: 'seo.nav.section.siteAudit',
    icon: Radar,
    needsSite: true,
    built: true,
    items: [
      leaf('overview', 'seo.nav.item.overview', true),
      leaf('issues', 'seo.nav.item.issues', true),
      leaf('pages', 'seo.nav.item.pages', true),
      leaf('links', 'seo.nav.item.links', true),
      leaf('sitemap', 'seo.nav.item.sitemap', true),
      leaf('performance', 'seo.nav.item.performance', true),
      leaf('backlinks', 'seo.nav.item.backlinks', true),
      leaf('keywords', 'seo.nav.item.keywords', true),
      leaf('history', 'seo.nav.item.history', true),
    ],
  },
  {
    key: 'rank-tracker',
    labelKey: 'seo.nav.section.rankTracker',
    icon: TrendingUp,
    needsSite: true,
    built: true,
    items: [
      leaf('overview', 'seo.nav.item.overview', true),
      leaf('trackedKeywords', 'seo.nav.item.trackedKeywords', true),
      leaf('competitors', 'seo.nav.item.competitors', true),
      leaf('landscape', 'seo.nav.item.landscape', true),
    ],
  },
  {
    key: 'site-explorer',
    labelKey: 'seo.nav.section.siteExplorer',
    icon: Globe2,
    needsSite: false,
    built: true,
    items: [
      leaf('overview', 'seo.nav.item.overview', true),
      leaf('organicKeywords', 'seo.nav.item.organicKeywords', true),
      leaf('backlinks', 'seo.nav.item.backlinks', true),
      leaf('referringDomains', 'seo.nav.item.referringDomains', true),
      leaf('topPages', 'seo.nav.item.topPages', true),
      leaf('competingDomains', 'seo.nav.item.competingDomains', false),
    ],
  },
  {
    key: 'gsc-insights',
    labelKey: 'seo.nav.section.gscInsights',
    icon: Search,
    needsSite: false,
    built: true,
    items: [
      leaf('overview', 'seo.nav.item.overview', true),
      leaf('performance', 'seo.nav.item.performance', true),
      leaf('queries', 'seo.nav.item.queries', true),
      leaf('pages', 'seo.nav.item.pages', true),
      leaf('devices', 'seo.nav.item.devices', true),
      leaf('opportunities', 'seo.nav.item.opportunities', true),
    ],
  },
  {
    key: 'bot-analytics',
    labelKey: 'seo.nav.section.botAnalytics',
    icon: Bot,
    needsSite: false,
    built: true,
    items: [
      leaf('overview', 'seo.nav.item.overview', true),
      leaf('categories', 'seo.nav.item.categories', true),
      leaf('crawledPages', 'seo.nav.item.crawledPages', true),
      leaf('aiBots', 'seo.nav.item.aiBots', true),
    ],
  },
  {
    key: 'brand-radar',
    labelKey: 'seo.nav.section.brandRadar',
    icon: Sparkles,
    needsSite: false,
    built: true,
    items: [
      leaf('overview', 'seo.nav.item.overview', true),
      leaf('aiVisibility', 'seo.nav.item.aiVisibility', true),
      leaf('searchDemand', 'seo.nav.item.searchDemand', true),
      leaf('webVisibility', 'seo.nav.item.webVisibility', true),
      leaf('competitors', 'seo.nav.item.competitors', true),
      leaf('settings', 'seo.nav.item.brandSettings', true),
    ],
  },
];

export function findSection(key: string | undefined): SeoSection {
  return SEO_SECTIONS.find((s) => s.key === key) || SEO_SECTIONS[0];
}

/** First leaf key inside a section — used as the default subsection when only `:section` is in the URL. */
export function firstLeafKey(section: SeoSection): string {
  const first = section.items[0];
  if (!first) return 'overview';
  return first.type === 'leaf' ? first.key : first.children[0]?.key || 'overview';
}

/** Flattens a section's items (groups + their children) into a single lookup list. */
export function flattenLeaves(section: SeoSection): SeoNavLeaf[] {
  const out: SeoNavLeaf[] = [];
  for (const item of section.items) {
    if (item.type === 'leaf') out.push(item);
    else out.push(...item.children);
  }
  return out;
}

export function findLeaf(section: SeoSection, subsectionKey: string | undefined): SeoNavLeaf | undefined {
  if (!subsectionKey) return undefined;
  return flattenLeaves(section).find((l) => l.key === subsectionKey);
}
