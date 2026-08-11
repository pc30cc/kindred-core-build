/**
 * Phase 2.4 / 2.5 / 2.6 / 2.7 — retrieval diversity, grounding discipline,
 * confidence quality and conflicting-source handling. Pure-module tests.
 */
import { describe, it, expect } from 'vitest';
import { diversifySources } from '../../../server/services/ai-agent/sourceDiversity.js';
import { detectSourceConflicts } from '../../../server/services/ai-agent/conflictDetection.js';
import { decideStrategy, computeConfidence } from '../../../server/services/ai-agent/answerStrategy.js';
import { buildSystemPrompt, buildUserPrompt } from '../../../server/services/ai-agent/prompt.js';

type Cand = { key: string; parentKey: string; score: number; text: string };
const toCand = (c: Cand) => c;

describe('2.4 — retrieval diversity and dedupe', () => {
  it('collapses near-duplicate chunks from the same page', () => {
    const body = 'the pro plan includes unlimited conversations and priority support for teams';
    const items: Cand[] = [
      { key: 'a1', parentKey: 'page:1', score: 0.9, text: body },
      { key: 'a2', parentKey: 'page:1', score: 0.88, text: `${body} .` },
      { key: 'b1', parentKey: 'page:2', score: 0.5, text: 'refund requests are processed within ten business days' },
    ];
    const out = diversifySources(items, toCand, { limit: 5 });
    expect(out.selected.map((s) => s.key)).toEqual(['a1', 'b1']);
    expect(out.debug.duplicates_removed).toBe(1);
    expect(out.debug.candidates_before).toBe(3);
    expect(out.debug.candidates_after).toBe(2);
  });

  it('prevents one source from monopolising every slot', () => {
    const items: Cand[] = [
      { key: 'a1', parentKey: 'page:1', score: 0.9, text: 'agents seats limit per workspace plan' },
      { key: 'a2', parentKey: 'page:1', score: 0.89, text: 'billing cycles monthly annual invoices taxes' },
      { key: 'a3', parentKey: 'page:1', score: 0.88, text: 'widget installation snippet script domain allowlist' },
      { key: 'b1', parentKey: 'page:2', score: 0.4, text: 'knowledge base article publishing workflow drafts' },
    ];
    const out = diversifySources(items, toCand, { limit: 3, maxPerParent: 2 });
    const parents = out.selected.map((s) => s.parentKey);
    expect(parents.filter((p) => p === 'page:1').length).toBe(2);
    expect(parents).toContain('page:2');
    expect(out.debug.capped_by_parent).toBe(1);
  });

  it('keeps multiple materially different chunks from one source when nothing else is relevant', () => {
    const items: Cand[] = [
      { key: 'a1', parentKey: 'page:1', score: 0.9, text: 'pro plan seat pricing per agent monthly' },
      { key: 'a2', parentKey: 'page:1', score: 0.8, text: 'enterprise onboarding sso saml provisioning' },
    ];
    const out = diversifySources(items, toCand, { limit: 5, maxPerParent: 2 });
    expect(out.selected).toHaveLength(2);
  });
});

describe('2.7 — conflicting source detection', () => {
  it('flags two sources stating different prices for the same plan', () => {
    const res = detectSourceConflicts(
      [
        { id: 's1', title: 'Pricing', content: 'The Pro plan costs $49 per month.' },
        { id: 's2', title: 'Pricing (old)', content: 'The Pro plan costs $59 per month.' },
      ],
      'How much is the Pro plan?',
    );
    expect(res.conflictDetected).toBe(true);
    expect(res.conflicts[0].field).toBe('price');
    expect(res.conflicts[0].sourceIds).toEqual(['s1', 's2']);
  });

  it('does not flag agreeing sources or a single source listing several plans', () => {
    expect(detectSourceConflicts([
      { id: 's1', content: 'Pro plan pricing: $49 per month.' },
      { id: 's2', content: 'Pro plan pricing is $49 per month.' },
    ], 'pro plan price').conflictDetected).toBe(false);

    expect(detectSourceConflicts([
      { id: 's1', content: 'Plan pricing: Starter $19, Pro $49, Business $99.' },
      { id: 's2', content: 'Our support team answers within one business day.' },
    ], 'pricing').conflictDetected).toBe(false);
  });

  it('flags conflicting refund windows', () => {
    const res = detectSourceConflicts([
      { id: 's1', content: 'Refunds are available within 14 days of purchase.' },
      { id: 's2', content: 'Our refund policy allows a return within 30 days.' },
    ], 'refund policy');
    expect(res.conflictDetected).toBe(true);
    expect(res.conflicts.some((c) => c.field === 'policy_days')).toBe(true);
  });
});

describe('2.6 — confidence quality', () => {
  const base = {
    top_score: 0, retrieval_strength: 'none' as const, source_count: 0,
    independent_source_count: 0, exact_qna_match: false, source_types: [],
    conflict_detected: false, just_answered_clarification: false,
  };

  it('is ordered: exact Q&A > weak keyword hit > no source', () => {
    const none = computeConfidence({ ...base });
    const weak = computeConfidence({
      ...base, top_score: 0.2, retrieval_strength: 'weak', source_count: 1,
      independent_source_count: 1, source_types: ['kb_article'],
    });
    const exact = computeConfidence({
      ...base, top_score: 0.9, retrieval_strength: 'exact_qna', source_count: 2,
      independent_source_count: 2, exact_qna_match: true, source_types: ['qna'],
    });
    expect(none.confidence).toBe(0);
    expect(none.band).toBe('none');
    expect(weak.confidence).toBeGreaterThan(none.confidence);
    expect(weak.band).toBe('weak');
    expect(exact.confidence).toBeGreaterThan(weak.confidence);
    expect(exact.band).toBe('strong');
  });

  it('lowers confidence when sources conflict', () => {
    const strong = {
      ...base, top_score: 0.9, retrieval_strength: 'strong' as const, source_count: 2,
      independent_source_count: 2, source_types: ['kb_article'],
    };
    const clean = computeConfidence(strong);
    const conflicted = computeConfidence({ ...strong, conflict_detected: true });
    expect(conflicted.confidence).toBeLessThan(clean.confidence);
    expect(conflicted.band).not.toBe('strong');
  });
});

const SETTINGS: any = {
  answer_only_from_kb: false,
  allow_clarifying_questions: true,
  max_clarification_attempts: 1,
  escalation_style: 'balanced',
  allow_caveated_answers: true,
  allow_safe_guidance: true,
};

const src = (over: any = {}) => ({
  kind: 'kb_article', id: 's1', title: 'Pricing', excerpt: null, content: null,
  slug: null, locale: 'en', score: 0.9, ...over,
});

describe('2.6 / 2.7 — strategy decisions reflect evidence', () => {
  it('exposes confidence band, inputs and conflict flags on every decision', () => {
    const d = decideStrategy({
      settings: SETTINGS, question: 'How much is the Pro plan?',
      sources: [], clarificationAttemptCount: 0,
    });
    expect(d.confidenceBand).toBe('none');
    expect(d.confidence).toBe(0);
    expect(d.conflictDetected).toBe(false);
    expect(d.confidenceInputs.source_count).toBe(0);
  });

  it('does not answer confidently when sources conflict on price', () => {
    const d = decideStrategy({
      settings: SETTINGS,
      question: 'How much is the Pro plan?',
      sources: [
        src({ id: 's1', content: 'The Pro plan costs $49 per month.', score: 0.95 }),
        src({ id: 's2', content: 'The Pro plan costs $59 per month.', score: 0.9 }),
      ],
      clarificationAttemptCount: 0,
    });
    expect(d.conflictDetected).toBe(true);
    expect(d.decisionType).not.toBe('answer');
    expect(d.confidenceBand).not.toBe('strong');
  });

  it('does not ask another clarification right after the visitor answered one', () => {
    const weakSources = [src({ id: 'w1', title: 'Random note', content: 'account', score: 0.12 })];
    const asking = decideStrategy({
      settings: SETTINGS, question: 'my subscription is broken',
      sources: weakSources, clarificationAttemptCount: 0,
    });
    const afterAnswer = decideStrategy({
      settings: SETTINGS, question: 'accessing the account',
      sources: weakSources, clarificationAttemptCount: 0,
      justAnsweredClarification: true,
    });
    expect(afterAnswer.decisionType).not.toBe('ask_clarifying_question');
    expect(afterAnswer.confidenceInputs.just_answered_clarification).toBe(true);
    expect(asking.confidenceInputs.just_answered_clarification).toBe(false);
  });

  it('keeps clarification attempts bounded', () => {
    const d = decideStrategy({
      settings: SETTINGS, question: 'help',
      sources: [], clarificationAttemptCount: 5,
    });
    expect(d.decisionType).not.toBe('ask_clarifying_question');
  });
});

describe('2.5 — grounding / claim discipline in prompts', () => {
  it('forbids inventing business-specific facts and links', () => {
    const sys = buildSystemPrompt(SETTINGS as any, 'en' as any);
    expect(sys).toMatch(/business-specific facts/i);
    expect(sys).toMatch(/refund/i);
    expect(sys).toMatch(/Never invent a link/i);
  });

  it('separates recent conversation context from the current visitor message', () => {
    const user = buildUserPrompt('Does that include API access?', [src()], undefined, {
      conversationContext: 'RECENT CONVERSATION:\nVisitor: How much is the Pro plan?\nAssistant: Here you go.',
    });
    expect(user).toContain('RECENT CONVERSATION:');
    expect(user).toContain('CURRENT VISITOR MESSAGE');
    expect(user.indexOf('RECENT CONVERSATION:')).toBeLessThan(user.indexOf('CURRENT VISITOR MESSAGE'));
  });

  it('warns the model when sources conflict', () => {
    const user = buildUserPrompt('price?', [src()], undefined, { conflictDetected: true });
    expect(user).toMatch(/conflicting values/i);
  });
});