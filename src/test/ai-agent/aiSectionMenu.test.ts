/**
 * The AI section's menu (src/components/layout/aiAgentMenu.ts, 2026-11-01):
 * a few sections whose pages open as tabs. Before it, five customer pages
 * (guidance, routing, triggers, integrations, train) had no link anywhere
 * and the Super Admin's default cap of 6 cut Activity and Settings from the
 * list. These checks keep every customer page in the menu, the advanced
 * pages behind the same rule as their guard, and the Super Admin's switches
 * and cap working on the new shape.
 *
 * Since the owner's 2026-11-01 round, knowledge is managed in the Knowledge
 * Base only: the section's knowledge pages are its tabs and their URLs
 * redirect there, and the four settings pages are one (`behavior`). The menu
 * offers no knowledge entry and no redirect, and each of the six
 * customer_nav switches still has an effect (five here, `knowledge` on the
 * Knowledge Base's status tab).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  AI_MENU, aiSectionForPath, aiSubPath, aiTabMatches, aiTabOffered, visibleAiMenu, type CustomerNavKey,
} from '@/components/layout/aiAgentMenu';
import { KB_AI_TABS, kbAiTabsVisible } from '@/components/app/knowledge/knowledgeBaseTabs';

const appSrc = readFileSync(resolve(__dirname, '../../App.tsx'), 'utf8');
const start = appSrc.indexOf('<Route path="ai-agent"');
const end = appSrc.indexOf('</Route>', start);
const block = appSrc.slice(start, end);

/** Every child route of the ai-agent block: path and whether it is guarded or a redirect. */
const routes = [...block.matchAll(/<Route path="([^"]+)" element=\{(.*?)\}\s*\/>/gs)].map((m) => ({
  path: m[1],
  element: m[2],
  guarded: m[2].includes('AdvancedAiAgentGuard'),
  redirect: /Navigate|Redirect/.test(m[2]),
}));

const tabPaths = (advanced: boolean) =>
  AI_MENU.filter((s) => !!s.advanced === advanced).flatMap((s) => s.tabs.map((t) => t.path));
const allTabPaths = () => AI_MENU.flatMap((s) => s.tabs.map((t) => t.path));

const ALL_ON: Record<CustomerNavKey, boolean> = {
  overview: true, knowledge: true, behavior: true, operatorAssist: true, activity: true, settings: true,
};

/** The AI section's old knowledge pages, now the Knowledge Base's tabs (or its Q&A / Files). */
const KNOWLEDGE_ROUTES = ['knowledge', 'web-pages', 'learning-candidates', 'train', 'qna', 'files'];
/** The four settings pages that became `behavior`. */
const SETTINGS_ROUTES = ['activation', 'instructions', 'guidance', 'settings'];

describe('every customer page of the AI section is in its menu', () => {
  const customer = routes.filter((r) => !r.guarded && !r.redirect);

  it('finds the customer routes in App.tsx', () => {
    // 20 before 2026-11-01; eight of them are redirects now (below).
    expect(customer.length).toBeGreaterThanOrEqual(12);
  });

  it.each(customer.map((r) => r.path))('%s is a tab of a customer section', (path) => {
    expect(tabPaths(false)).toContain(path);
  });

  it('no customer tab points to a route that does not exist, is guarded or redirects', () => {
    for (const path of tabPaths(false)) {
      expect(customer.map((r) => r.path)).toContain(path);
    }
  });

  it('each page is in exactly one section', () => {
    const all = allTabPaths();
    expect(new Set(all).size).toBe(all.length);
  });
});

describe('the old knowledge and settings URLs are redirects, never tabs', () => {
  const redirects = routes.filter((r) => r.redirect);

  it.each([...KNOWLEDGE_ROUTES, ...SETTINGS_ROUTES])('%s is a redirect route, not guarded', (path) => {
    const route = routes.find((r) => r.path === path);
    expect(route?.redirect).toBe(true);
    expect(route?.guarded).toBe(false);
  });

  it('no redirect is a tab of any section', () => {
    expect(redirects.length).toBeGreaterThanOrEqual(KNOWLEDGE_ROUTES.length + SETTINGS_ROUTES.length);
    for (const r of redirects) expect(allTabPaths()).not.toContain(r.path);
  });

  it('the knowledge pages open their Knowledge Base tab', () => {
    const target = (path: string) => routes.find((r) => r.path === path)?.element.match(/to="([^"]+)"/)?.[1];
    expect(target('knowledge')).toBe('../../knowledge-base?tab=status');
    expect(target('train')).toBe('../../knowledge-base?tab=status');
    expect(target('web-pages')).toBe('../../knowledge-base?tab=web');
    expect(target('learning-candidates')).toBe('../../knowledge-base?tab=learning');
    for (const path of ['knowledge', 'train', 'web-pages', 'learning-candidates']) {
      const tab = target(path)?.split('?tab=')[1];
      expect(KB_AI_TABS as readonly string[]).toContain(tab);
    }
  });

  it.each(SETTINGS_ROUTES)('%s opens the one settings page, behavior', (path) => {
    expect(routes.find((r) => r.path === path)?.element).toBe('<Navigate to="../behavior" replace />');
  });
});

describe('no knowledge entry in the AI section', () => {
  it('no section is about knowledge', () => {
    expect(AI_MENU.map((s) => s.id)).not.toContain('knowledge');
  });

  it('no tab or detail path points at a knowledge route', () => {
    for (const section of AI_MENU) {
      for (const tab of section.tabs) {
        expect(KNOWLEDGE_ROUTES.some((k) => aiTabMatches(tab.path, k)), `${section.id}/${tab.path}`).toBe(false);
      }
      for (const also of section.also ?? []) expect(KNOWLEDGE_ROUTES).not.toContain(also);
    }
  });

  it('a knowledge URL belongs to no section (it only redirects)', () => {
    for (const path of KNOWLEDGE_ROUTES) expect(aiSectionForPath(path)).toBeUndefined();
  });
});

describe('advanced pages stay in the platform-admin section only', () => {
  const guarded = routes.filter((r) => r.guarded);

  it('every advanced tab is an AdvancedAiAgentGuard route', () => {
    for (const path of tabPaths(true)) {
      expect(guarded.map((r) => r.path)).toContain(path);
    }
  });

  it('every guarded route belongs to the advanced section (tab or detail page)', () => {
    for (const r of guarded) {
      const section = aiSectionForPath(r.path.replace(/\/:[^/]+/g, '/x'));
      expect(section?.id).toBe('advanced');
    }
  });

  it('a customer never sees the advanced section', () => {
    const ids = visibleAiMenu({ navFlags: ALL_ON, advancedAllowed: false, cap: null }).map((s) => s.id);
    expect(ids).not.toContain('advanced');
  });

  it('a platform admin does', () => {
    const ids = visibleAiMenu({ navFlags: ALL_ON, advancedAllowed: true, cap: null }).map((s) => s.id);
    expect(ids).toContain('advanced');
  });
});

describe('the sections', () => {
  it('are overview, behavior, automation, operator assist, activity and the advanced tools', () => {
    expect(AI_MENU.map((s) => s.id)).toEqual(['overview', 'behavior', 'automation', 'operatorAssist', 'activity', 'advanced']);
    const tabs = (id: string) => AI_MENU.find((s) => s.id === id)?.tabs.map((t) => t.path);
    expect(tabs('overview')).toEqual(['overview', 'playground']);
    expect(tabs('behavior')).toEqual(['behavior']);
    expect(tabs('automation')).toEqual(['routing', 'topics', 'triggers', 'workflow', 'integrations']);
    expect(tabs('operatorAssist')).toEqual(['operator-assist', 'operator-assist-analytics']);
    expect(tabs('activity')).toEqual(['activity', 'analytics']);
  });

  it('«شخصیت و رفتار» is one page, named as its section', () => {
    const behavior = AI_MENU.find((s) => s.id === 'behavior');
    expect(behavior?.label).toBe('aiAgent.menu.behavior');
    expect(behavior?.tabs).toHaveLength(1);
    expect(behavior?.tabs[0].label).toBe('aiAgent.menu.behavior');
  });
});

describe("the Super Admin's switches and cap", () => {
  it('with the default cap of 6 every customer section shows', () => {
    const customerSections = AI_MENU.filter((s) => !s.advanced).length;
    expect(customerSections).toBeLessThanOrEqual(6);
    const shown = visibleAiMenu({ navFlags: ALL_ON, advancedAllowed: false, cap: 6 });
    expect(shown.length).toBe(customerSections);
  });

  it('a smaller cap keeps the first sections and never counts the advanced one', () => {
    const shown = visibleAiMenu({ navFlags: ALL_ON, advancedAllowed: true, cap: 2 });
    expect(shown.map((s) => s.id)).toEqual(['overview', 'behavior', 'advanced']);
  });

  it('a switched-off entry hides its tab only', () => {
    const shown = visibleAiMenu({ navFlags: { ...ALL_ON, overview: false }, advancedAllowed: false, cap: null });
    const overview = shown.find((s) => s.id === 'overview');
    expect(overview?.tabs.map((t) => t.path)).toEqual(['playground']);
  });

  it('a section whose every tab is switched off disappears', () => {
    const shown = visibleAiMenu({ navFlags: { ...ALL_ON, operatorAssist: false }, advancedAllowed: false, cap: null });
    expect(shown.map((s) => s.id)).not.toContain('operatorAssist');
  });

  it('behavior shows while either of its two switches is on', () => {
    const ids = (flags: Partial<Record<CustomerNavKey, boolean>>) =>
      visibleAiMenu({ navFlags: { ...ALL_ON, ...flags }, advancedAllowed: false, cap: null }).map((s) => s.id);
    expect(ids({ behavior: false })).toContain('behavior');
    expect(ids({ settings: false })).toContain('behavior');
    expect(ids({ behavior: false, settings: false })).not.toContain('behavior');
  });

  it('the page that turns the agent on is never reachable only through the switches (the core owner flow)', () => {
    // The activation tab had no switch; the page it became part of has two,
    // so its route stays a plain customer route and the header chip links
    // to it whatever the switches hide (aiAgentLayout.test.tsx).
    expect(routes.find((r) => r.path === 'behavior')).toMatchObject({ guarded: false, redirect: false });
  });

  it('a tab with several switches needs one of them on; one without any always shows', () => {
    const tab = { path: 'x', label: 'aiAgent.menu.behavior' as const, navFlags: ['behavior', 'settings'] as const };
    expect(aiTabOffered(tab, {})).toBe(true);
    expect(aiTabOffered(tab, { behavior: false })).toBe(true);
    expect(aiTabOffered(tab, { behavior: false, settings: false })).toBe(false);
    expect(aiTabOffered({ path: 'y', label: 'aiAgent.menu.tabPlayground' }, { behavior: false, settings: false })).toBe(true);
  });

  it('each of the six customer_nav switches still has an effect', () => {
    const offFor = (flag: CustomerNavKey) => visibleAiMenu({ navFlags: { ...ALL_ON, [flag]: false }, advancedAllowed: false, cap: null });
    const paths = (sections: ReturnType<typeof visibleAiMenu>) => sections.flatMap((s) => s.tabs.map((t) => t.path));
    const all = paths(visibleAiMenu({ navFlags: ALL_ON, advancedAllowed: false, cap: null }));

    // In the menu: overview, operatorAssist and activity hide their tabs
    // alone; behavior and settings hide the one page they both offer together.
    expect(paths(offFor('overview'))).not.toContain('overview');
    expect(paths(offFor('operatorAssist'))).not.toContain('operator-assist');
    expect(paths(offFor('activity'))).not.toContain('activity');
    const neither = visibleAiMenu({ navFlags: { ...ALL_ON, behavior: false, settings: false }, advancedAllowed: false, cap: null });
    expect(paths(neither)).not.toContain('behavior');
    // `knowledge` is no longer the menu's: it changes nothing here…
    expect(paths(offFor('knowledge'))).toEqual(all);
    // …and hides the Knowledge Base's status tab instead.
    expect(kbAiTabsVisible(true, ALL_ON).status).toBe(true);
    expect(kbAiTabsVisible(true, { ...ALL_ON, knowledge: false })).toEqual({ web: true, learning: true, status: false });
  });
});

describe('which section and tab a URL opens', () => {
  it('reads the part after /ai-agent/', () => {
    expect(aiSubPath('/my-shop/ai-agent/debug/retrieval')).toBe('debug/retrieval');
    expect(aiSubPath('/my-shop/ai-agent')).toBe('');
    expect(aiSubPath('/my-shop/ai-agent/')).toBe('');
  });

  it('matches a tab and its sub-paths only', () => {
    expect(aiTabMatches('runs/42', 'runs')).toBe(true);
    expect(aiTabMatches('test-runs/42', 'test-cases')).toBe(false);
    expect(aiTabMatches('operator-assist-analytics', 'operator-assist')).toBe(false);
  });

  it('puts sibling pages under one section', () => {
    expect(aiSectionForPath('playground')?.id).toBe('overview');
    expect(aiSectionForPath('behavior')?.id).toBe('behavior');
    expect(aiSectionForPath('triggers')?.id).toBe('automation');
    expect(aiSectionForPath('operator-assist-analytics')?.id).toBe('operatorAssist');
    expect(aiSectionForPath('runs/abc')?.id).toBe('advanced');
  });
});
