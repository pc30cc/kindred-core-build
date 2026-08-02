/**
 * Phase 6-S5-R1 — Knowledge Base product independence invariants.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '../../..');
const read = (p: string) => readFileSync(resolve(root, p), 'utf8');

describe('Knowledge Base is independent from the AI Agent', () => {
  it('KB hooks never import AI Agent APIs or Supabase directly', () => {
    const src = read('src/hooks/useKnowledgeBase.ts');
    expect(src).not.toMatch(/ai-agent-api|ai-kb-api|aiAgentApi/);
    expect(src).not.toMatch(/from '@\/lib\/supabase'|integrations\/supabase\/client/);
    expect(src).toMatch(/knowledge-base-api/);
  });

  it('KB routes are ALWAYS available: no plan gate, no AI services', () => {
    const src = read('server/routes/knowledgeBase.ts');
    expect(src).toMatch(/authorizeWorkspaceAccess/);
    // Phase 6-S5-R4 — no entitlement lookup, no plan denial, ever.
    expect(src).not.toMatch(/checkKnowledgeBaseModule/);
    expect(src).not.toMatch(/checkModuleAccess|checkEntitlementFromDB/);
    expect(src).not.toMatch(/error: 'knowledge_base_plan_required'/);
    expect(src).not.toMatch(/ai-agent|aiAgent|ai_assistant/);
  });

  it('KB access helpers contain no entitlement lookup at all', () => {
    const src = read('server/services/knowledge-base/access.ts');
    expect(src).not.toMatch(/checkModuleAccess/);
    // Only prose may mention the removed denial; no code may emit it.
    expect(src).not.toMatch(/error: 'knowledge_base_plan_required'/);
    expect(src).not.toMatch(/'ai_assistant'/);
    // Granular role permissions remain the only authorization layer.
    expect(src).toMatch(/has_workspace_permission/);
  });

  it('the UI never wraps the Knowledge Base in a plan gate', () => {
    const app = read('src/App.tsx');
    expect(app).not.toMatch(/moduleKey="knowledge_base"/);
    const sidebar = read('src/components/layout/AppSidebar.tsx');
    expect(sidebar).not.toMatch(/knowledgeBasePlanEnabled/);
    // `knowledge_base` is not even an expressible gate key any more.
    expect(read('src/components/plan/PlanAccessGate.tsx')).not.toMatch(
      /\|\s*'knowledge_base'/,
    );
    expect(read('src/components/plan/PlanLockedOverlay.tsx')).not.toMatch(
      /\|\s*'knowledge_base'/,
    );
  });

  it('AI indexing consumes KB changes asynchronously and gates on the AI plan', () => {
    const src = read('server/services/ai-agent/knowledgeIndex/kbEvents.ts');
    expect(src).toMatch(/knowledge_base_change_events/);
    expect(src).toMatch(/'ai_assistant'/);
    // Plan-off is a DEFERRAL (retryable), never a completion.
    expect(src).toMatch(/ai_assistant_plan_required/);
    expect(src).toMatch(/defer_kb_change_events/);
  });
});
