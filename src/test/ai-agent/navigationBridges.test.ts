/**
 * Follow-up 8A — customer navigation bridge fixes, per the Navigation/IA
 * audit's proven gaps:
 *   LC1/LC2 — "Review learning candidates" CTAs on Overview and Train both
 *     navigate to /ai-agent/qna instead of /ai-agent/learning-candidates.
 *   ACT1 — ActivationPage (readiness checklist, reply-mode selector, reply
 *     limits) has zero customer-reachable inbound link from anywhere.
 *   AN1 — AnalyticsPage has zero customer-reachable inbound link.
 *   OA1 — OperatorAssistAnalyticsPage has zero customer-reachable inbound
 *     link, despite OperatorAssistPage embedding a summary of the same data.
 *
 * Same source-text-extraction convention as
 * src/test/ai-agent/advancedRouteAccessPolicy.test.ts and
 * src/test/billing/aiAgentRouteGating.test.ts: these four pages carry
 * substantial react-query/i18n/toast wiring, so asserting on the actual JSX
 * navigation targets in the real source file is more robust here than
 * mounting the full component tree, and avoids a second hand-maintained
 * copy of the navigation graph that could silently drift from production.
 *
 * 2026-11-01 (owner): knowledge is managed in the Knowledge Base only, so
 * the review CTAs open its learning tab (the old /ai-agent/learning-candidates
 * URL only redirects there), and Activation is part of the one settings page,
 * «شخصیت و رفتار» (/ai-agent/behavior), which the Overview links to.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AI_MENU, visibleAiMenu, type CustomerNavKey } from '@/components/layout/aiAgentMenu';
import { KB_AI_TABS, kbAiTabsVisible, kbTabPath } from '@/components/app/knowledge/knowledgeBaseTabs';

function read(rel: string): string {
  return readFileSync(resolve(__dirname, rel), 'utf8');
}

const overviewSrc = read('../../pages/app/ai-agent/OverviewPage.tsx');
const trainSrc = read('../../pages/app/ai-agent/TrainPage.tsx');
const activitySrc = read('../../pages/app/ai-agent/ActivityPage.tsx');
const operatorAssistSrc = read('../../pages/app/ai-agent/OperatorAssistPage.tsx');

/** Extract the single source line containing `marker`. Throws if not found. */
function lineContaining(src: string, marker: string): string {
  const line = src.split('\n').find((l) => l.includes(marker));
  if (!line) throw new Error(`Marker not found in source: ${marker}`);
  return line;
}

describe('the Knowledge Base learning tab the review CTAs open', () => {
  it('is the learning tab of /knowledge-base', () => {
    expect(KB_AI_TABS).toContain('learning');
    expect(kbTabPath('learning')).toBe('/knowledge-base?tab=learning');
  });
});

describe('LC1 — Overview "Review learning candidates" CTA target', () => {
  it('opens the Knowledge Base learning tab, never /qna', () => {
    const line = lineContaining(overviewSrc, "action.review");
    expect(line).toContain("go(kbTabPath('learning'))");
    expect(line).not.toContain('qna');
    expect(line).not.toContain('/ai-agent/learning-candidates');
  });
});

describe('LC2 — Train "Review learning candidates" CTA target', () => {
  it('opens the Knowledge Base learning tab, never /qna', () => {
    const line = lineContaining(trainSrc, 'aiAgent.train.action.reviewLearning');
    expect(line).toContain("navigate(wsPath(kbTabPath('learning')))");
    expect(line).not.toContain('qna');
    expect(line).not.toContain('/ai-agent/learning-candidates');
  });
});

describe('ACT1 — Overview provides a discoverable link to Activation', () => {
  it("source contains a navigation target of '/ai-agent/behavior' (the page Activation became part of)", () => {
    expect(overviewSrc).toContain("navigate(wsPath('/ai-agent/behavior'))");
    expect(overviewSrc).not.toContain('/ai-agent/activation');
  });
});

describe('AN1 — Activity provides a discoverable link to Analytics', () => {
  it("source contains a navigation target of '/ai-agent/analytics'", () => {
    expect(activitySrc).toContain('/ai-agent/analytics');
  });
});

describe('OA1 — Operator Assist provides a discoverable link to full Analytics', () => {
  it("source contains a navigation target of '/ai-agent/operator-assist-analytics'", () => {
    expect(operatorAssistSrc).toContain('/ai-agent/operator-assist-analytics');
  });
});

describe('boundary check — the Super Admin\'s six nav switches still gate what they named', () => {
  // The menu became a few sections with tabs (aiAgentMenu.ts, 2026-11-01);
  // five of capabilities.customer_nav's six switches gate its tabs (behavior
  // and settings together, on the one page that holds both), and
  // `knowledge` the Knowledge Base's status tab, where the AI section's
  // Knowledge page went. The full menu/route coverage lives in
  // aiSectionMenu.test.ts.
  const ALL_ON: Record<CustomerNavKey, boolean> = {
    overview: true, knowledge: true, behavior: true, operatorAssist: true, activity: true, settings: true,
  };

  it('aiAgentMenu.ts gates its tabs on overview, behavior, settings, operatorAssist and activity', () => {
    const flags = new Set(AI_MENU.flatMap((s) => s.tabs.flatMap((t) => t.navFlags ?? [])));
    expect(flags).toEqual(new Set(['overview', 'behavior', 'settings', 'operatorAssist', 'activity']));
    const behavior = AI_MENU.flatMap((s) => s.tabs).find((t) => t.path === 'behavior');
    expect(behavior?.navFlags).toEqual(['behavior', 'settings']);
  });

  it('the knowledge switch gates the Knowledge Base status tab and nothing in the AI menu', () => {
    const menu = (flags: Record<CustomerNavKey, boolean>) =>
      visibleAiMenu({ navFlags: flags, advancedAllowed: false, cap: null }).flatMap((s) => s.tabs.map((t) => t.path));
    expect(menu({ ...ALL_ON, knowledge: false })).toEqual(menu(ALL_ON));
    expect(kbAiTabsVisible(true, { ...ALL_ON, knowledge: false }).status).toBe(false);
    expect(kbAiTabsVisible(true, ALL_ON).status).toBe(true);
  });
});
