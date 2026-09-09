/**
 * Web Analytics navigation tree — the report list behind the standalone
 * "Web Analytics" main-menu item. Moved out of the SEO suite's nested nav
 * (see src/pages/app/seo/seoNavTree.ts) because this tool reports generic
 * site-traffic/behavior data (sources, pages, geography, devices, custom
 * events), not search-specific data — it doesn't belong conceptually under
 * SEO even though it originally shipped there for convenience.
 */

export interface WebAnalyticsNavLeaf {
  type: 'leaf';
  key: string;
  labelKey: string;
  built: boolean;
}

export interface WebAnalyticsNavGroup {
  type: 'group';
  key: string;
  labelKey: string;
  children: WebAnalyticsNavLeaf[];
}

export type WebAnalyticsNavItem = WebAnalyticsNavLeaf | WebAnalyticsNavGroup;

function leaf(key: string, labelKey: string, built: boolean): WebAnalyticsNavLeaf {
  return { type: 'leaf', key, labelKey, built };
}

function group(key: string, labelKey: string, children: WebAnalyticsNavLeaf[]): WebAnalyticsNavGroup {
  return { type: 'group', key, labelKey, children };
}

export const WEB_ANALYTICS_NAV: WebAnalyticsNavItem[] = [
  leaf('overview', 'seo.nav.item.overview', true),
  group('trafficSources', 'seo.nav.item.trafficSources', [
    leaf('channels', 'seo.nav.item.channels', true),
    leaf('sources', 'seo.nav.item.sources', true),
    leaf('campaigns', 'seo.nav.item.campaigns', true),
  ]),
  group('pages', 'seo.nav.item.pages', [
    leaf('topPages', 'seo.nav.item.topPages', true),
    leaf('entryPages', 'seo.nav.item.entryPages', true),
    leaf('exitPages', 'seo.nav.item.exitPages', true),
    leaf('clonedPages', 'seo.nav.item.clonedPages', true),
    leaf('possible404', 'seo.nav.item.possible404', true),
    leaf('siteStructure', 'seo.nav.item.siteStructure', true),
    leaf('new', 'seo.nav.item.new', true),
  ]),
  group('geography', 'seo.nav.item.geography', [
    leaf('continents', 'seo.nav.item.continents', true),
    leaf('countries', 'seo.nav.item.countries', true),
    leaf('cities', 'seo.nav.item.cities', true),
    leaf('languages', 'seo.nav.item.languages', true),
  ]),
  group('browsersSystems', 'seo.nav.item.browsersSystems', [
    leaf('browsers', 'seo.nav.item.browsers', true),
    leaf('operatingSystems', 'seo.nav.item.operatingSystems', true),
    leaf('devices', 'seo.nav.item.devices', true),
  ]),
  group('events', 'seo.nav.item.events', [
    leaf('trackedEvents', 'seo.nav.item.trackedEvents', true),
    leaf('funnels', 'seo.nav.item.funnels', true),
    leaf('eventProperties', 'seo.nav.item.eventProperties', true),
  ]),
];

export function firstWebAnalyticsLeafKey(): string {
  const first = WEB_ANALYTICS_NAV[0];
  if (!first) return 'overview';
  return first.type === 'leaf' ? first.key : first.children[0]?.key || 'overview';
}

/** Flattens the tree (groups + their children) into a single lookup list. */
export function flattenWebAnalyticsLeaves(): WebAnalyticsNavLeaf[] {
  const out: WebAnalyticsNavLeaf[] = [];
  for (const item of WEB_ANALYTICS_NAV) {
    if (item.type === 'leaf') out.push(item);
    else out.push(...item.children);
  }
  return out;
}

export function findWebAnalyticsLeaf(subsectionKey: string | undefined): WebAnalyticsNavLeaf | undefined {
  if (!subsectionKey) return undefined;
  return flattenWebAnalyticsLeaves().find((l) => l.key === subsectionKey);
}
