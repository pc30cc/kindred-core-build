/**
 * Follow-up 7B — regression coverage for the AI Agent advanced-route access
 * policy, per the frontend/backend gating audit's finding: 16 real
 * customer-facing pages were wrapped in <AdvancedAiAgentGuard> (global-admin
 * / dev-override only) despite their backend routes permitting ordinary
 * workspace owner/admin (or, for a few, any workspace member).
 *
 * Same convention as src/test/billing/aiAgentRouteGating.test.ts: reads the
 * real source file and asserts on the actual <Route> registration text,
 * rather than mounting the full App component tree (which requires the
 * entire auth/workspace/i18n/branding provider stack for no additional
 * signal — the policy question here is purely "which routes are wrapped in
 * AdvancedAiAgentGuard", a static composition fact readable directly off
 * src/App.tsx).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const fullAppSrc = readFileSync(resolve(__dirname, '../../App.tsx'), 'utf8');

// Scope extraction to the ai-agent parent route's children only. Some
// sub-path names (e.g. "billing") collide with unrelated top-level routes
// elsewhere in App.tsx (the workspace subscription/billing page), so
// searching the whole file for `path="billing"` would find the wrong route.
const AI_AGENT_BLOCK_START = '<Route path="ai-agent" element={<AiAgentLayout />}>';
const startIdx = fullAppSrc.indexOf(AI_AGENT_BLOCK_START);
if (startIdx === -1) throw new Error('ai-agent parent route not found in App.tsx');
const endIdx = fullAppSrc.indexOf('</Route>', startIdx);
if (endIdx === -1) throw new Error('ai-agent parent route close tag not found in App.tsx');
const appSrc = fullAppSrc.slice(startIdx, endIdx);

/** Extract the single <Route path="X" element={...} /> line for a given ai-agent sub-path. */
function routeLine(subPath: string): string {
  const escaped = subPath.replace(/\//g, '\\/');
  const re = new RegExp(`<Route path="${escaped}" element=\\{.*?\\}\\s*/>`, 's');
  const m = appSrc.match(re);
  if (!m) throw new Error(`Route "${subPath}" not found in the ai-agent route block of App.tsx`);
  return m[0];
}

function isAdvancedGuarded(subPath: string): boolean {
  return routeLine(subPath).includes('AdvancedAiAgentGuard');
}

describe('G1 — customer config routes must NOT be advanced-guarded', () => {
  const customerConfigRoutes = [
    'guidance', 'activation', 'routing', 'instructions', 'qna',
    'learning-candidates', 'train', 'web-pages', 'files', 'topics',
    'workflow', 'triggers', 'integrations',
  ];
  it.each(customerConfigRoutes)('%s is not wrapped in AdvancedAiAgentGuard', (subPath) => {
    expect(isAdvancedGuarded(subPath)).toBe(false);
  });
});

describe('G2 — customer member surfaces must NOT be advanced-guarded', () => {
  const customerMemberRoutes = ['playground', 'analytics', 'operator-assist-analytics'];
  it.each(customerMemberRoutes)('%s is not wrapped in AdvancedAiAgentGuard', (subPath) => {
    expect(isAdvancedGuarded(subPath)).toBe(false);
  });
});

describe('G3 — proven C3 internal QA/debug routes remain advanced-guarded', () => {
  const advancedRoutes = [
    'runs/:id', 'debug/retrieval', 'source-health',
    'test-cases', 'test-runs/:id', 'regression-runs',
  ];
  it.each(advancedRoutes)('%s remains wrapped in AdvancedAiAgentGuard', (subPath) => {
    expect(isAdvancedGuarded(subPath)).toBe(true);
  });
});

describe('G4 — suggested-tests policy is left untouched (still advanced)', () => {
  it('suggested-tests remains wrapped in AdvancedAiAgentGuard', () => {
    expect(isAdvancedGuarded('suggested-tests')).toBe(true);
  });
});

describe('G5 — billing stub is left untouched', () => {
  it('billing remains wrapped in AdvancedAiAgentGuard (unimplemented placeholder, out of scope)', () => {
    expect(isAdvancedGuarded('billing')).toBe(true);
  });
});

describe('unguarded pre-existing customer pages remain unguarded (no regression)', () => {
  const alwaysCustomerRoutes = ['overview', 'knowledge', 'behavior', 'operator-assist', 'activity', 'settings'];
  it.each(alwaysCustomerRoutes)('%s has no AdvancedAiAgentGuard wrapper', (subPath) => {
    expect(isAdvancedGuarded(subPath)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────
// canAccessAiAgentAdvancedTools() — pure guard predicate. Confirms the
// guard ITSELF has not been weakened by this follow-up; only the set of
// routes it wraps changed (in App.tsx), not its own allow logic.
// ─────────────────────────────────────────────────────────────
import { canAccessAiAgentAdvancedTools } from '../../features/ai-agent/AdvancedAiAgentGuard';

describe('canAccessAiAgentAdvancedTools', () => {
  it('global admin -> true', () => {
    expect(canAccessAiAgentAdvancedTools({ isGlobalAdmin: true })).toBe(true);
  });
  it('dev override -> true', () => {
    expect(canAccessAiAgentAdvancedTools({ isGlobalAdmin: false, devOverride: true })).toBe(true);
  });
  it('global admin AND dev override -> true', () => {
    expect(canAccessAiAgentAdvancedTools({ isGlobalAdmin: true, devOverride: true })).toBe(true);
  });
  it('ordinary customer (neither) -> false', () => {
    expect(canAccessAiAgentAdvancedTools({ isGlobalAdmin: false, devOverride: false })).toBe(false);
  });
  it('ordinary customer with devOverride omitted -> false', () => {
    expect(canAccessAiAgentAdvancedTools({ isGlobalAdmin: false })).toBe(false);
  });
});
