/**
 * Guidance → "Add default rules" saves five starter rules whose title and
 * text become the rules themselves (and go into the AI's prompt). They are
 * written in the dashboard's language at that moment: in English they stay
 * byte for byte what they always were, and a Persian dashboard gets Persian
 * rules its owner can read and edit. The rule types sent never change.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { I18nProvider } from '@/i18n';
import en from '@/i18n/locales/en';
import fa from '@/i18n/locales/fa';

const api = vi.hoisted(() => ({
  listGuidance: vi.fn(async () => ({ items: [] })),
  createGuidance: vi.fn<(input: Record<string, unknown>) => Promise<{ item: object }>>(async () => ({ item: {} })),
  updateGuidance: vi.fn(),
  deleteGuidance: vi.fn(),
}));
vi.mock('@/lib/ai-agent-api', () => ({ aiAgentApi: api }));
vi.mock('@/hooks/useWorkspace', () => ({ useCurrentWorkspace: () => ({ id: 'ws-1' }) }));
vi.mock('@/hooks/use-toast', () => ({ toast: vi.fn() }));

const GuidancePage = (await import('@/pages/app/ai-agent/GuidancePage')).default;

const ENGLISH_DEFAULTS = [
  { workspaceId: 'ws-1', title: 'Never claim to be human', description: 'Honesty rule', rule_type: 'answer_policy',
    instruction: 'If a visitor asks whether you are a human, clearly say you are an AI assistant.' },
  { workspaceId: 'ws-1', title: 'Do not invent exact prices', description: 'Pricing safety', rule_type: 'pricing_guidance',
    instruction: 'Never quote exact prices unless the knowledge base contains them. Offer to connect the visitor with sales instead.' },
  { workspaceId: 'ws-1', title: 'Offer human help on request', description: 'Escalation rule', rule_type: 'escalation_policy',
    instruction: 'If the visitor asks for a human, immediately offer to hand off and stop attempting to answer.' },
  { workspaceId: 'ws-1', title: 'Ask one clarification before handoff', description: 'Vague questions', rule_type: 'fallback_behavior',
    instruction: 'If a question is too vague to answer, ask exactly one short clarifying question before handing off.' },
  { workspaceId: 'ws-1', title: 'Friendly and concise tone', description: 'Voice rule', rule_type: 'tone',
    instruction: 'Use a friendly, concise tone. Avoid long paragraphs. Prefer short, helpful answers.' },
];

async function seedDefaults(locale: 'en' | 'fa') {
  const messages = locale === 'fa' ? fa : en;
  render(
    <I18nProvider initialLocale={locale} initialTranslations={messages}>
      <GuidancePage />
    </I18nProvider>,
  );
  fireEvent.click(await screen.findByRole('button', { name: messages.aiAgent.guidance.addDefaults }));
  await waitFor(() => expect(api.createGuidance).toHaveBeenCalledTimes(5));
  return api.createGuidance.mock.calls.map(([input]) => input);
}

beforeEach(() => {
  api.createGuidance.mockClear();
});

describe('Guidance default rules follow the dashboard language', () => {
  it('in English they are the same five rules as before, byte for byte', async () => {
    expect(await seedDefaults('en')).toEqual(ENGLISH_DEFAULTS);
  });

  it('in Persian they are written in Persian, with the same rule types', async () => {
    const rules = await seedDefaults('fa');
    expect(rules.map((r) => r.rule_type)).toEqual(ENGLISH_DEFAULTS.map((r) => r.rule_type));
    expect(rules[0].title).toBe(fa.aiAgent.guidance.defaults.human.title);
    for (const rule of rules) {
      for (const text of [rule.title, rule.description, rule.instruction]) {
        expect(text).toMatch(/[؀-ۿ]/);
        expect(text).not.toMatch(/[A-Za-z]/);
      }
    }
  });
});
