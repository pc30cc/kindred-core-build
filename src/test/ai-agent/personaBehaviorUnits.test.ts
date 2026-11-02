/**
 * The "Personality & behavior" settings, unit by unit (pure code, no IO
 * beyond a fake runs table):
 *
 *   - reply language (replyLanguage.ts): 'workspace_default' pins the
 *     workspace's default language only inside allowed_locales ∩ the
 *     platform's languages; 'visitor' (and unset) pins nothing.
 *   - clarifying questions (clarification.ts, aiControl.ts, prompt.ts,
 *     answerStrategy.countClarificationAttempts): the owner's switch and
 *     limit reach the prompt, a clarifying reply is recognised, and only
 *     delivered ones count.
 *   - escalation style (answerStrategy.ts): 'helpful_first', the value the
 *     pages save, gets the proactive floors and hedges on weak evidence; it
 *     used to answer exactly as 'balanced'.
 *   - handoff policy (handoffPolicy.ts): NULL is the legacy "at once", and
 *     the switch alone says on or off.
 */
import { describe, it, expect } from 'vitest';
import {
  resolveReplyLanguage, visitorAllowList, pinnedReplyLocale, baseLocale,
} from '../../../server/services/ai-agent/replyLanguage.js';
import {
  resolveClarificationPolicy, looksLikeClarifyingQuestion, classifyClarifyingReply,
} from '../../../server/services/ai-agent/clarification.js';
import { parseAiControl, buildAiControlContract } from '../../../server/services/ai-agent/aiControl.js';
import { buildSystemPrompt, buildUserPrompt } from '../../../server/services/ai-agent/prompt.js';
import {
  decideStrategy, thresholdsForStyle, countClarificationAttempts,
} from '../../../server/services/ai-agent/answerStrategy.js';
import { resolveHandoffPolicy, resolveMaxAssistAttempts } from '../../../server/services/ai-agent/handoffPolicy.js';
import { decide } from '../../../server/services/ai-agent/policy.js';
import { mergeInstructions } from '../../../server/services/ai-agent/settings.js';
import type { AgentSettings } from '../../../server/services/ai-agent/settings.js';
import type { RetrievedSource } from '../../../server/services/ai-agent/retrieval.js';
import type { ServiceClient } from '../../../server/supabase.js';
import { makeSettings } from './helpers/engineFixtures.js';

const settings = (overrides: Record<string, unknown> = {}) => makeSettings(overrides) as AgentSettings;

describe('reply language — the rule', () => {
  it("anything but 'workspace_default' is 'visitor' (unset included)", () => {
    expect(resolveReplyLanguage({ instructions: { reply_language: 'workspace_default' } })).toBe('workspace_default');
    for (const instructions of [{}, { reply_language: 'visitor' }, { reply_language: 'fa' }, null, undefined]) {
      expect(resolveReplyLanguage({ instructions })).toBe('visitor');
    }
    expect(resolveReplyLanguage(null)).toBe('visitor');
  });

  it('the allow-list is allowed_locales ∩ the platform, else the platform', () => {
    expect(visitorAllowList(['fa-IR', 'en', 'de'], ['en', 'fa'])).toEqual(['fa', 'en']);
    expect(visitorAllowList([], ['en', 'tr'])).toEqual(['en', 'tr']);
    expect(visitorAllowList(['de'], ['en', 'tr'])).toEqual(['en', 'tr']);
    expect(visitorAllowList(null, ['fa'])).toEqual(['fa']);
  });

  it("'workspace_default' pins the default only when it is allowed; 'visitor' never pins", () => {
    expect(pinnedReplyLocale('workspace_default', 'fa-IR', ['fa', 'en'])).toBe('fa');
    expect(pinnedReplyLocale('workspace_default', 'tr', ['fa', 'en'])).toBeNull();
    expect(pinnedReplyLocale('workspace_default', '', ['fa', 'en'])).toBeNull();
    expect(pinnedReplyLocale('workspace_default', 'fa', [])).toBeNull();
    expect(pinnedReplyLocale('visitor', 'fa', ['fa', 'en'])).toBeNull();
    expect(baseLocale(' TR_tr ')).toBe('tr');
  });
});

describe('instructions — the merge (settings.ts mergeInstructions)', () => {
  it('keeps what a write leaves out, takes what it carries, ignores undefined', () => {
    const stored = { tone: 'friendly', do_list: ['a'], custom_system_instruction: 'secret', personality: 'calm' };
    expect(mergeInstructions({ tone: 'formal', do_list: [], brand_voice: '', reply_language: undefined }, stored)).toEqual({
      tone: 'formal', do_list: [], brand_voice: '', custom_system_instruction: 'secret', personality: 'calm',
    });
    expect(mergeInstructions({ tone: 'formal' }, null)).toEqual({ tone: 'formal' });
    expect(mergeInstructions({ tone: 'formal' }, ['garbage'])).toEqual({ tone: 'formal' });
  });

  it('writing a newer key retires the legacy key the prompt would fall back to', () => {
    const stored = { escalation_instructions: 'Old handoff text.', custom_instructions: 'Old operator text.', tone: 'friendly' };
    expect(mergeInstructions({ handoff_instructions: '' }, stored)).toEqual({
      handoff_instructions: '', custom_instructions: 'Old operator text.', tone: 'friendly',
    });
    expect(mergeInstructions({ custom_system_instruction: 'New.' }, stored)).toEqual({
      custom_system_instruction: 'New.', escalation_instructions: 'Old handoff text.', tone: 'friendly',
    });
    // Unless the same write sets the legacy key itself.
    expect(mergeInstructions({ handoff_instructions: 'New.', escalation_instructions: 'Kept.' }, stored)).toMatchObject({
      handoff_instructions: 'New.', escalation_instructions: 'Kept.',
    });

    const cleared = mergeInstructions({ handoff_instructions: '', custom_system_instruction: '' }, stored) as Record<string, string>;
    const prompt = buildSystemPrompt(settings({ instructions: cleared }), 'en');
    expect(prompt).not.toContain('Old handoff text.');
    expect(prompt).not.toContain('Old operator text.');
  });

  it("the prompt reads a cleared text ('') or list ([]) as unset", () => {
    const prompt = buildSystemPrompt(settings({ instructions: { brand_voice: '', do_list: [], dont_list: [], tone: '' } }), 'en');
    expect(prompt).not.toContain('Brand voice:');
    expect(prompt).not.toContain('Always:');
    expect(prompt).not.toContain('Never:');
    expect(prompt).not.toContain('Tone preference:');
  });
});

describe('clarifying questions — the policy', () => {
  it('defaults: allowed, one per conversation', () => {
    expect(resolveClarificationPolicy({}, 0)).toEqual({ allowed: true, max: 1, asked: 0, canAskNow: true });
    expect(resolveClarificationPolicy({ max_clarification_attempts: null }, 1)).toMatchObject({ max: 1, canAskNow: false });
  });

  it('switch off, a limit of 0 or the limit reached: none may be asked now', () => {
    expect(resolveClarificationPolicy({ allow_clarifying_questions: false, max_clarification_attempts: 3 }, 0).canAskNow).toBe(false);
    expect(resolveClarificationPolicy({ max_clarification_attempts: 0 }, 0).canAskNow).toBe(false);
    expect(resolveClarificationPolicy({ max_clarification_attempts: 2 }, 2).canAskNow).toBe(false);
    expect(resolveClarificationPolicy({ max_clarification_attempts: 2 }, 1).canAskNow).toBe(true);
    expect(resolveClarificationPolicy({ max_clarification_attempts: 9 }, 0).max).toBe(5);
  });
});

describe('clarifying questions — recognising one', () => {
  it.each([
    'Which plan do you mean?',
    'Sure. Which order number is it?',
    'کدام پلن را مدنظر دارید؟',
    'Hangi siparişten bahsediyorsunuz?',
  ])('one short question back to the visitor: %s', (text) => {
    expect(looksLikeClarifyingQuestion(text)).toBe(true);
  });

  it.each([
    'Our Basic plan costs $10 per month and includes 3 seats.',
    'You can reset it at https://example.test/reset. Did that work?',
    'Which plan? And which country?',
    'Thanks. That helps. Which plan do you mean?',
    'Here are the steps:\n1. Open settings\n2. Click reset\nDid it work?',
    `${'This is a long and complete answer that explains the whole policy in detail, '.repeat(3)}does that help?`,
    '',
  ])('not one: %j', (text) => {
    expect(looksLikeClarifyingQuestion(text)).toBe(false);
  });

  it("the model's word decides when it gives one; the shape only when it does not", () => {
    expect(classifyClarifyingReply('Here you go.', true)).toEqual({ clarifying: true, source: 'model' });
    expect(classifyClarifyingReply('Which plan do you mean?', false)).toEqual({ clarifying: false, source: null });
    expect(classifyClarifyingReply('Which plan do you mean?', null)).toEqual({ clarifying: true, source: 'shape' });
    expect(classifyClarifyingReply('Which plan do you mean?', null, { shapeFallback: false })).toEqual({ clarifying: false, source: null });
  });

  it('the status block carries "clarifying_question" (true, false, or not said) and never reaches the visitor', () => {
    const yes = parseAiControl('Which plan do you mean?\n<ai_control>{"clarifying_question":true}</ai_control>');
    expect(yes.text).toBe('Which plan do you mean?');
    expect(yes.control.clarifyingQuestion).toBe(true);
    expect(parseAiControl('Done.<ai_control>{"clarifying_question":false}</ai_control>').control.clarifyingQuestion).toBe(false);
    expect(parseAiControl('Done.<ai_control>{"resolution_status":"resolved"}</ai_control>').control.clarifyingQuestion).toBeNull();
    expect(parseAiControl('Done.<ai_control>{"clarifying_question":"yes"}</ai_control>').control.clarifyingQuestion).toBeNull();
    expect(parseAiControl('Done.').control.clarifyingQuestion).toBeNull();
    expect(buildAiControlContract({ allowGuidanceRequest: false })).toContain('"clarifying_question"');
  });
});

describe('clarifying questions — what the prompt says', () => {
  const ONE = 'ask ONE short clarifying question';

  it('allowed and none asked: one short question (the rule as before)', () => {
    const prompt = buildSystemPrompt(settings(), 'en', { clarificationsAsked: 0 });
    expect(prompt).toContain(ONE);
    expect(prompt).not.toContain('Never ask the visitor a clarifying question');
  });

  it('turned off: never ask; answer with what is verified, say what is missing, or follow the handoff rules', () => {
    const prompt = buildSystemPrompt(settings({ allow_clarifying_questions: false, answer_only_from_kb: true }), 'en');
    expect(prompt).toContain('Never ask the visitor a clarifying question');
    expect(prompt).toContain('say plainly what you could not confirm');
    expect(prompt).toContain('follow the HANDOFF rules');
    expect(prompt).not.toContain(ONE);
    expect(prompt).not.toContain('or asking a clarifying question');
  });

  it('the limit reached: do not ask another one', () => {
    const prompt = buildSystemPrompt(settings({ max_clarification_attempts: 2 }), 'en', { clarificationsAsked: 2 });
    expect(prompt).toContain('You already asked the visitor 2 clarifying questions in this conversation');
    expect(prompt).toContain('Do not ask another one');
    expect(prompt).not.toContain(ONE);
  });

  it("the per-turn directive drops its \"ask ONE clarifying question\" when none may be asked", () => {
    const allowed = buildUserPrompt('price?', [], { decisionType: 'answer', groundingMode: 'unverified' });
    expect(allowed).toContain('either ask ONE clarifying question');
    const off = buildUserPrompt('price?', [], { decisionType: 'answer', groundingMode: 'unverified' }, { clarifyingQuestionAllowed: false });
    expect(off).not.toContain('ask ONE clarifying question');
    expect(off).toContain('Do not ask a clarifying question.');
  });
});

describe('clarifying questions — only the delivered ones count', () => {
  function runsTable(rows: Array<{ status: string; decision: string }>): ServiceClient {
    const data = rows.map((r) => ({ status: r.status, metadata: { answer_strategy: { decision_type: r.decision } } }));
    const builder = {
      select: () => builder, eq: () => builder, order: () => builder,
      limit: async () => ({ data, error: null }),
    };
    return { from: () => builder } as unknown as ServiceClient;
  }

  it('counts replied clarifying runs only', async () => {
    const sb = runsTable([
      { status: 'replied', decision: 'ask_clarifying_question' },
      { status: 'suggested', decision: 'ask_clarifying_question' },
      { status: 'skipped', decision: 'ask_clarifying_question' },
      { status: 'failed', decision: 'ask_clarifying_question' },
      { status: 'replied', decision: 'answer' },
      { status: 'replied', decision: 'ask_clarifying_question' },
    ]);
    expect(await countClarificationAttempts(sb, 'conv-1')).toBe(2);
  });
});

describe('escalation style — "helpful first" is its own behaviour', () => {
  function source(score: number): RetrievedSource {
    return {
      kind: 'kb_article', id: `kb-${score}`, title: 'Refund policy', excerpt: 'Refunds within 14 days.',
      content: 'Refunds are possible within 14 days of purchase.', slug: 'refunds', locale: 'en', score,
    } as RetrievedSource;
  }
  const decide = (style: string, score: number, extra: Record<string, unknown> = {}) => decideStrategy({
    settings: settings({ escalation_style: style, handoff_on_low_confidence: false, handoff_when_no_kb_match: false, ...extra }),
    question: 'can I get a refund',
    sources: [source(score)],
    clarificationAttemptCount: 0,
  });

  it("'helpful_first' (and the legacy 'proactive') get the proactive floors; anything else is balanced", () => {
    expect(thresholdsForStyle('helpful_first')).toEqual({ answerMin: 0.6, caveatMin: 0.35 });
    expect(thresholdsForStyle('proactive')).toEqual({ answerMin: 0.6, caveatMin: 0.35 });
    expect(thresholdsForStyle('conservative')).toEqual({ answerMin: 0.75, caveatMin: 0.6 });
    expect(thresholdsForStyle('balanced')).toEqual({ answerMin: 0.68, caveatMin: 0.45 });
    expect(thresholdsForStyle(undefined)).toEqual({ answerMin: 0.68, caveatMin: 0.45 });
  });

  it('weak evidence (0.40): helpful first hedges on it; balanced calls it unverified', () => {
    expect(decide('helpful_first', 0.4)).toMatchObject({ decisionType: 'answer_with_caveat', groundingMode: 'partial', reason: 'weak_evidence_only' });
    expect(decide('proactive', 0.4)).toMatchObject({ decisionType: 'answer_with_caveat', groundingMode: 'partial' });
    expect(decide('balanced', 0.4)).toMatchObject({ decisionType: 'answer', groundingMode: 'unverified' });
    expect(decide('conservative', 0.4)).toMatchObject({ decisionType: 'answer', groundingMode: 'unverified' });
  });

  it('helpful first prefers the hedge over the low-confidence handoff', () => {
    expect(decide('helpful_first', 0.4, { handoff_on_low_confidence: true })).toMatchObject({ decisionType: 'answer_with_caveat', handoffRequired: false });
    expect(decide('balanced', 0.4, { handoff_on_low_confidence: true })).toMatchObject({ decisionType: 'handoff', handoffReason: 'owner_policy' });
  });

  it('allow_answer_with_caveat off keeps its effect: no hedge, the old path', () => {
    expect(decide('helpful_first', 0.4, { allow_answer_with_caveat: false })).toMatchObject({ decisionType: 'answer', groundingMode: 'unverified' });
    expect(decide('helpful_first', 0.4, { allow_answer_with_caveat: false, handoff_on_low_confidence: true })).toMatchObject({ decisionType: 'handoff' });
  });

  it('below the floor (0.30) and in the medium band, every style answers as before', () => {
    expect(decide('helpful_first', 0.3)).toMatchObject({ decisionType: 'answer', groundingMode: 'unverified' });
    for (const style of ['balanced', 'helpful_first']) {
      expect(decide(style, 0.5)).toMatchObject({ decisionType: 'answer_with_caveat', reason: 'medium_kb_match' });
      expect(decide(style, 0.8)).toMatchObject({ decisionType: 'answer', groundingMode: 'grounded' });
    }
    expect(decide('conservative', 0.5)).toMatchObject({ decisionType: 'answer', groundingMode: 'unverified' });
  });
});

describe('handoff policy — NULL is the legacy "at once"; the switch says on or off', () => {
  it('a stored policy is used as is; NULL (or garbage) is immediate, whatever the switch', () => {
    expect(resolveHandoffPolicy({ handoff_policy: 'assist_first' })).toBe('assist_first');
    expect(resolveHandoffPolicy({ handoff_policy: null, handoff_on_human_request: true })).toBe('immediate');
    expect(resolveHandoffPolicy({ handoff_policy: null, handoff_on_human_request: false })).toBe('immediate');
  });

  it('max_assist_attempts reads 0..3, 1 when unset', () => {
    expect(resolveMaxAssistAttempts({})).toBe(1);
    expect(resolveMaxAssistAttempts({ max_assist_attempts: null as unknown as number })).toBe(1);
    expect(resolveMaxAssistAttempts({ max_assist_attempts: 0 })).toBe(0);
    expect(resolveMaxAssistAttempts({ max_assist_attempts: 7 })).toBe(3);
  });
});

describe('the dry run and the playground (policy.decide) give the runtime\'s first-turn verdict', () => {
  const ask = (overrides: Record<string, unknown>, question = 'I want to talk to a human') =>
    decide({ settings: settings({ handoff_when_no_kb_match: false, answer_only_from_kb: false, ...overrides }), question, sources: [] }).action;

  it("legacy and 'immediate' hand over; 'assist_first' and 'adaptive' make their attempt first", () => {
    expect(ask({ handoff_policy: null })).toBe('handoff');
    expect(ask({ handoff_policy: 'immediate' })).toBe('handoff');
    expect(ask({ handoff_policy: 'assist_first' })).not.toBe('handoff');
    expect(ask({ handoff_policy: 'adaptive' })).not.toBe('handoff');
    expect(ask({ handoff_policy: 'assist_first', max_assist_attempts: 0 })).toBe('handoff');
  });

  it("'adaptive' hands over at once when the visitor rejects the AI; the switch off never does", () => {
    expect(ask({ handoff_policy: 'adaptive' }, "I don't want a bot, give me a real person")).toBe('handoff');
    expect(ask({ handoff_policy: 'immediate', handoff_on_human_request: false })).not.toBe('handoff');
  });
});
