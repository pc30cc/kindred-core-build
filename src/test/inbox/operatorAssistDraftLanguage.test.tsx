/**
 * The operator's AI draft (src/components/inbox/OperatorAssistPanel.tsx)
 * goes to a VISITOR, so the panel asks for it in a visitors' language
 * (usePlatformRegion().allowedLocales; Iran: Persian only): the operator's
 * own dashboard language when visitors have it, else the first.
 *
 * Since the Super Admin may open WebYar's dashboard in English or Turkish
 * (shared/panelLanguages.ts) while its visitors stay Persian, sending the
 * dashboard's language asked for an English draft to a Persian visitor.
 * RESPOK (multi, en and tr) keeps drafting in the operator's language, as
 * before. The server keeps the same rule (server/routes/ai-agent/operatorAssist.ts,
 * src/test/ai-agent/operatorAssistVisitorLanguage.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

type L = 'en' | 'fa' | 'tr';
const h = vi.hoisted(() => ({
  ui: 'en' as 'en' | 'fa' | 'tr',
  visitors: ['en', 'fa', 'tr'] as Array<'en' | 'fa' | 'tr'>,
  suggestReply: vi.fn(),
}));

vi.mock('@/i18n', () => ({ useTranslation: () => ({ t: (k: string) => k, locale: h.ui, dir: 'ltr' }) }));
vi.mock('@/hooks/usePlatformRegion', () => ({
  usePlatformRegion: () => ({ allowedLocales: h.visitors, canSwitchLanguage: h.visitors.length > 1 }),
}));
vi.mock('@/hooks/useAiAgentCapabilities', () => ({ useAiAgentCapabilities: () => ({ data: { ai_agent_enabled: true } }) }));
vi.mock('@/hooks/use-toast', () => ({ toast: vi.fn() }));
vi.mock('@/lib/ai-agent-api', () => ({
  aiAgentApi: {
    suggestReply: (...a: unknown[]) => h.suggestReply(...a),
    submitAssistFeedback: vi.fn(async () => ({})),
  },
}));

import { OperatorAssistPanel } from '@/components/inbox/OperatorAssistPanel';

beforeEach(() => {
  h.suggestReply.mockReset();
  h.suggestReply.mockResolvedValue({
    assist_run_id: 'run-1',
    suggestion: 'سلام',
    confidence: 0.8,
    selected_sources: [{ id: 's1' }],
    safety_notes: [],
  });
});
afterEach(cleanup);

async function draftLocale(ui: L, visitors: L[]): Promise<unknown> {
  h.ui = ui;
  h.visitors = visitors;
  render(
    <OperatorAssistPanel workspaceId="ws-1" conversationId="conv-1" composerHasText={false} onInsert={() => undefined} />,
  );
  fireEvent.click(screen.getByRole('button', { name: /inbox\.aiAssist\.trigger/ }));
  fireEvent.click(screen.getByRole('button', { name: /inbox\.aiAssist\.generate/ }));
  await waitFor(() => expect(h.suggestReply).toHaveBeenCalledTimes(1));
  const input = h.suggestReply.mock.calls[0][0] as { locale?: string; workspaceId: string; conversationId: string };
  expect(input).toMatchObject({ workspaceId: 'ws-1', conversationId: 'conv-1' });
  return input.locale;
}

describe('OperatorAssistPanel: the draft is asked for in a visitors\' language', () => {
  it('WebYar (iran) with an English dashboard: Persian', async () => {
    expect(await draftLocale('en', ['fa'])).toBe('fa');
  });

  it('WebYar with a Turkish dashboard: Persian', async () => {
    expect(await draftLocale('tr', ['fa'])).toBe('fa');
  });

  it('WebYar with a Persian dashboard: Persian, as before', async () => {
    expect(await draftLocale('fa', ['fa'])).toBe('fa');
  });

  it('RESPOK (multi, en and tr): the operator\'s language, as before', async () => {
    expect(await draftLocale('tr', ['en', 'tr'])).toBe('tr');
  });

  it('RESPOK with an English dashboard: English, as before', async () => {
    expect(await draftLocale('en', ['en', 'tr'])).toBe('en');
  });
});
