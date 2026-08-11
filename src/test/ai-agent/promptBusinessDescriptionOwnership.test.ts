/**
 * Follow-up 3 (business-description ownership consolidation) — pins the
 * runtime prompt contract directly against `buildSystemPrompt()`.
 *
 * Canonical field: `ai_agent_settings.business_description` (top-level).
 * Legacy field: `ai_agent_settings.instructions.business_description`
 * (still readable from persisted rows, never runtime-authoritative).
 *
 * This file only characterizes existing runtime behavior (BD9/BD10) -- no
 * production runtime code changes in this follow-up.
 */
import { describe, it, expect } from 'vitest';
import { buildSystemPrompt } from '../../../server/services/ai-agent/prompt.js';
import { makeSettings } from './helpers/engineFixtures.js';

describe('BD9 — top-level business_description is the runtime-canonical source', () => {
  it('emits the top-level value as "Business context: ..." and never the nested legacy value', () => {
    const settings = makeSettings({
      business_description: 'Canonical',
      instructions: { business_description: 'Legacy' },
    });

    const prompt = buildSystemPrompt(settings as any, 'en');

    expect(prompt).toContain('Business context: Canonical');
    expect(prompt).not.toContain('Legacy');
  });
});

describe('BD10 — a nested-only legacy value does not silently activate at runtime', () => {
  it('top-level null + nested legacy value present -> no "Business context" line at all', () => {
    const settings = makeSettings({
      business_description: null,
      instructions: { business_description: 'Legacy nested' },
    });

    const prompt = buildSystemPrompt(settings as any, 'en');

    expect(prompt).not.toContain('Business context:');
    expect(prompt).not.toContain('Legacy nested');
  });
});
