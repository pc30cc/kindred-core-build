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

  it('KB routes enforce the knowledge_base module and never touch AI services', () => {
    const src = read('server/routes/knowledgeBase.ts');
    expect(src).toMatch(/checkKnowledgeBaseModule/);
    expect(src).toMatch(/authorizeWorkspaceAccess/);
    expect(src).not.toMatch(/ai-agent|aiAgent|ai_assistant/);
  });

  it('module guard fails closed and uses only the knowledge_base module key', () => {
    const src = read('server/services/knowledge-base/access.ts');
    expect(src).toMatch(/'knowledge_base'/);
    expect(src).not.toMatch(/'ai_assistant'/);
    expect(src).toMatch(/allowed = false;/);
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
