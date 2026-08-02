/**
 * Phase 6-S5-R6 — capability alignment and authoritative indexing.
 *
 * The capability snapshot served to the UI must agree with the server gate:
 *   knowledge_base → always available   (core product, never plan-gated)
 *   ai_assistant   → MODULE   entitlement
 *   ai_kb_builder  → FEATURE  entitlement
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');

describe('capability alignment', () => {
  const settings = read('server/services/ai-agent/platformSettings.ts');
  const access = read('server/services/ai-kb/access.ts');

  it('never resolves knowledge_base through an entitlement lookup', () => {
    expect(settings).not.toContain("lookup('knowledge_base')");
    expect(settings).toContain('const kbPlanEnabled = true;');
    expect(access).toContain('knowledge_base: true');
  });

  it('resolves ai_kb_builder as a FEATURE, not a module', () => {
    expect(settings).not.toContain("lookup('ai_kb_builder')");
    expect(settings).toContain("featureLookup('ai_kb_builder')");
    expect(settings).toContain('checkEntitlementFromDB');
    expect(access).toContain("'ai_kb_builder'");
  });

  it('derives builder availability from AI + builder only', () => {
    expect(settings).toContain(
      'const effectiveBuilderAvailable = effectiveAiAvailable && builderPlanEnabled;',
    );
  });
});

describe('platform lookup failures are transient, not denials', () => {
  const guards = read('server/services/ai-agent/platformGuards.ts');
  const access = read('server/services/ai-kb/access.ts');

  it('uses a distinct 503 code', () => {
    expect(guards).toContain("PLATFORM_STATUS_UNAVAILABLE = 'ai_platform_status_unavailable'");
    expect(guards).not.toContain(
      "status: 503, error: 'ai_agent_platform_disabled'",
    );
  });

  it('propagates 503 through the AI KB gate instead of a 403', () => {
    expect(access).toContain("status: 503");
    expect(access).toContain("'ai_platform_status_unavailable'");
  });
});

describe('authoritative index rebuild', () => {
  const sync = read('server/services/ai-agent/knowledgeIndex/sync.ts');

  it('blocks the destructive sweep after any prerequisite failure', () => {
    expect(sync).toContain(
      'rebuildTrustworthy && articleSetTrustworthy && indexWritesTrustworthy;',
    );
    expect(sync).toContain('summary.reconciliationSkipped = true;');
  });

  it('never completes a rebuild with partial embedding failures', () => {
    expect(sync).toContain('summary.embeddingFailures > 0\n  ) {');
    expect(sync).not.toContain('summary.embeddingsGenerated === 0\n  ) {');
  });
});
