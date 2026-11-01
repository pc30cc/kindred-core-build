/**
 * The AI section's menu (src/components/layout/aiAgentMenu.ts, 2026-11-01):
 * a few sections whose pages open as tabs. Before it, five customer pages
 * (guidance, routing, triggers, integrations, train) had no link anywhere
 * and the Super Admin's default cap of 6 cut Activity and Settings from the
 * list. These checks keep every customer page in the menu, the advanced
 * pages behind the same rule as their guard, and the Super Admin's switches
 * and cap working on the new shape.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  AI_MENU, aiSectionForPath, aiSubPath, aiTabMatches, visibleAiMenu,
} from '@/components/layout/aiAgentMenu';

const appSrc = readFileSync(resolve(__dirname, '../../App.tsx'), 'utf8');
const start = appSrc.indexOf('<Route path="ai-agent"');
const end = appSrc.indexOf('</Route>', start);
const block = appSrc.slice(start, end);

/** Every child route of the ai-agent block: path and whether it is guarded or a redirect. */
const routes = [...block.matchAll(/<Route path="([^"]+)" element=\{(.*?)\}\s*\/>/gs)].map((m) => ({
  path: m[1],
  guarded: m[2].includes('AdvancedAiAgentGuard'),
  redirect: /Navigate|Redirect/.test(m[2]),
}));

const tabPaths = (advanced: boolean) =>
  AI_MENU.filter((s) => !!s.advanced === advanced).flatMap((s) => s.tabs.map((t) => t.path));

const ALL_ON = { overview: true, knowledge: true, behavior: true, operatorAssist: true, activity: true, settings: true };

describe('every customer page of the AI section is in its menu', () => {
  const customer = routes.filter((r) => !r.guarded && !r.redirect);

  it('finds the customer routes in App.tsx', () => {
    expect(customer.length).toBeGreaterThanOrEqual(20);
  });

  it.each(customer.map((r) => r.path))('%s is a tab of a customer section', (path) => {
    expect(tabPaths(false)).toContain(path);
  });

  it('no customer tab points to a route that does not exist or is guarded', () => {
    for (const path of tabPaths(false)) {
      expect(customer.map((r) => r.path)).toContain(path);
    }
  });

  it('each page is in exactly one section', () => {
    const all = AI_MENU.flatMap((s) => s.tabs.map((t) => t.path));
    expect(new Set(all).size).toBe(all.length);
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

describe("the Super Admin's switches and cap", () => {
  it('with the default cap of 6 every customer section shows', () => {
    const customerSections = AI_MENU.filter((s) => !s.advanced).length;
    expect(customerSections).toBeLessThanOrEqual(6);
    const shown = visibleAiMenu({ navFlags: ALL_ON, advancedAllowed: false, cap: 6 });
    expect(shown.length).toBe(customerSections);
  });

  it('a smaller cap keeps the first sections and never counts the advanced one', () => {
    const shown = visibleAiMenu({ navFlags: ALL_ON, advancedAllowed: true, cap: 2 });
    expect(shown.map((s) => s.id)).toEqual(['overview', 'knowledge', 'advanced']);
  });

  it('a switched-off entry hides its tab only', () => {
    const shown = visibleAiMenu({ navFlags: { ...ALL_ON, settings: false }, advancedAllowed: false, cap: null });
    const answers = shown.find((s) => s.id === 'answers');
    expect(answers?.tabs.map((t) => t.path)).not.toContain('settings');
    expect(answers?.tabs.map((t) => t.path)).toContain('behavior');
  });

  it('a section whose every tab is switched off disappears', () => {
    const shown = visibleAiMenu({ navFlags: { ...ALL_ON, operatorAssist: false }, advancedAllowed: false, cap: null });
    expect(shown.map((s) => s.id)).not.toContain('operatorAssist');
  });

  it('the activation page is never behind a switch (the core owner flow)', () => {
    const activation = AI_MENU.flatMap((s) => s.tabs).find((t) => t.path === 'activation');
    expect(activation?.navFlag).toBeUndefined();
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
    expect(aiSectionForPath('guidance')?.id).toBe('answers');
    expect(aiSectionForPath('operator-assist-analytics')?.id).toBe('operatorAssist');
    expect(aiSectionForPath('runs/abc')?.id).toBe('advanced');
  });
});
