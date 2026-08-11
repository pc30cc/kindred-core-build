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
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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

describe('LC1 — Overview "Review learning candidates" CTA target', () => {
  it('navigates to /ai-agent/learning-candidates, not /ai-agent/qna', () => {
    const line = lineContaining(overviewSrc, "action.review");
    expect(line).toContain("wsPath('/ai-agent/learning-candidates')");
    expect(line).not.toContain("wsPath('/ai-agent/qna')");
  });
});

describe('LC2 — Train "Review learning candidates" CTA target', () => {
  it('navigates to /ai-agent/learning-candidates, not /ai-agent/qna', () => {
    const line = lineContaining(trainSrc, 'Review learning candidates');
    expect(line).toContain("wsPath('/ai-agent/learning-candidates')");
    expect(line).not.toContain("wsPath('/ai-agent/qna')");
  });
});

describe('ACT1 — Overview provides a discoverable link to Activation', () => {
  it("source contains a navigation target of '/ai-agent/activation'", () => {
    expect(overviewSrc).toContain('/ai-agent/activation');
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

describe('boundary check — this follow-up must not touch sidebar/route-policy files', () => {
  it('AiAgentLayout.tsx still declares exactly 6 top-level nav items', () => {
    const layoutSrc = read('../../components/layout/AiAgentLayout.tsx');
    const matches = layoutSrc.match(/key: '(overview|knowledge|behavior|operatorAssist|activity|settings)'/g) || [];
    expect(matches.length).toBe(6);
  });
});
