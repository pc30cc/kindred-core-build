/**
 * Reactions in the inbox thread (issue #340 g2):
 *
 *  - the chips under a bubble: one per emoji with its count in the reader's
 *    digits, a label that says who reacted (the visitor, you, teammates —
 *    never a teammate's name), `aria-pressed` on the operator's own; they
 *    toggle only on a message the operator may react to, and only show the
 *    visitor's heart on a team message;
 *  - the picker: the six reactions, the operator's own pressed, one click
 *    sets or takes back and closes;
 *  - useMessageReaction: shown at once, put back when the server refuses;
 *  - the thread hears `message_reactions` on the inbox channel and re-reads
 *    its messages (nothing else).
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import en from '@/i18n/locales/en';
import fa from '@/i18n/locales/fa';
import tr from '@/i18n/locales/tr';
import type { RealtimeHandlers } from '@/realtime/types';

const i18n = vi.hoisted(() => ({ locale: 'en' as 'en' | 'fa' | 'tr' }));
const dictionaries = { en, fa, tr } as unknown as Record<string, Record<string, Record<string, string>>>;
vi.mock('@/i18n', () => ({
  useTranslation: () => ({
    locale: i18n.locale,
    dir: i18n.locale === 'fa' ? 'rtl' : 'ltr',
    t: (key: string, params?: Record<string, string | number>) => {
      const [ns, k] = key.split('.');
      let v = dictionaries[i18n.locale][ns]?.[k] ?? key;
      for (const [p, val] of Object.entries(params || {})) v = v.split(`{{${p}}}`).join(String(val));
      return v;
    },
  }),
}));

const api = vi.hoisted(() => ({ setReaction: vi.fn() }));
vi.mock('@/lib/conversations-api', async (orig) => {
  const real = await orig<typeof import('@/lib/conversations-api')>();
  return { ...real, conversationsApi: { ...real.conversationsApi, setReaction: api.setReaction } };
});

const subs = vi.hoisted(() => [] as Array<{ channel: string; handlers: RealtimeHandlers }>);
vi.mock('@/realtime', () => ({
  resolveClientRealtimeProvider: async () => ({
    vendor: 'centrifugo',
    async subscribe(channel: string, handlers: RealtimeHandlers) {
      subs.push({ channel, handlers });
      return { unsubscribe: () => undefined };
    },
  }),
}));

const { MessageReactionChips, ReactionPickerButton } = await import('@/components/inbox/MessageReactions');
const { useMessageReaction } = await import('@/hooks/useConversations');
const { useInboxRealtime } = await import('@/hooks/useInboxRealtime');

const HEART = '❤️';
const WS = '11111111-1111-4111-8111-111111111111';
const CID = '22222222-2222-4222-8222-222222222222';

afterEach(() => { i18n.locale = 'en'; api.setReaction.mockReset(); subs.length = 0; vi.restoreAllMocks(); });

describe('MessageReactionChips', () => {
  const reactions = [
    { emoji: HEART, count: 3, visitor: true, mine: true },
    { emoji: '👍', count: 2, visitor: false, mine: false },
  ];

  it('toggleable chips: aria-pressed on the operator\'s own, a label of who reacted, a click sets or takes back', () => {
    const onToggle = vi.fn();
    render(<MessageReactionChips reactions={reactions} canToggle onToggle={onToggle} align="start" />);
    const group = screen.getByRole('group', { name: 'Reactions' });
    expect(group.className).toContain('justify-start');
    const heart = screen.getByRole('button', { name: `${HEART} 3 — Visitor, you, a teammate` });
    expect(heart.getAttribute('aria-pressed')).toBe('true');
    const thumbs = screen.getByRole('button', { name: '👍 2 — 2 teammates' });
    expect(thumbs.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(heart);
    fireEvent.click(thumbs);
    expect(onToggle.mock.calls).toEqual([[HEART, false], ['👍', true]]);
  });

  it('display only (the visitor\'s heart on a team message): no buttons, an image label; nothing for an empty list', () => {
    const { container, rerender } = render(
      <MessageReactionChips reactions={[{ emoji: HEART, count: 1, visitor: true, mine: false }]} canToggle={false} align="end" />,
    );
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByRole('img', { name: `${HEART} 1 — Visitor` })).toBeTruthy();
    expect(container.querySelector('[data-inbox="reactions"]')!.className).toContain('justify-end');
    rerender(<MessageReactionChips reactions={[]} canToggle={false} align="end" />);
    expect(container.querySelector('[data-inbox="reactions"]')).toBeNull();
  });

  it('Persian: Persian digits and «، » between who reacted', () => {
    i18n.locale = 'fa';
    render(<MessageReactionChips reactions={[{ emoji: HEART, count: 12, visitor: true, mine: true }]} canToggle onToggle={() => {}} align="start" />);
    const chip = screen.getByRole('button', { name: `${HEART} ۱۲ — بازدیدکننده، شما، ۱۰ همکار` });
    expect(chip.textContent).toContain('۱۲');
    expect(screen.getByRole('group', { name: 'واکنش‌ها' })).toBeTruthy();
  });
});

describe('ReactionPickerButton', () => {
  it('offers the six reactions, the operator\'s own pressed; a pick sets it (or takes it back) and closes', async () => {
    const onToggle = vi.fn();
    render(<ReactionPickerButton reactions={[{ emoji: '😂', count: 1, visitor: false, mine: true }]} onToggle={onToggle} />);
    const trigger = screen.getByRole('button', { name: 'React' });
    fireEvent.click(trigger);
    const group = await screen.findByRole('group', { name: 'React' });
    const options = Array.from(group.querySelectorAll('button'));
    expect(options.map((b) => b.getAttribute('aria-label'))).toEqual([HEART, '👍', '😂', '😮', '😢', '🙏']);
    expect(options.map((b) => b.getAttribute('aria-pressed'))).toEqual(['false', 'false', 'true', 'false', 'false', 'false']);
    fireEvent.click(options[2]);
    expect(onToggle).toHaveBeenCalledWith('😂', false);
    await waitFor(() => expect(screen.queryByRole('group', { name: 'React' })).toBeNull());
    fireEvent.click(trigger);
    fireEvent.click(Array.from((await screen.findByRole('group', { name: 'React' })).querySelectorAll('button'))[5]);
    expect(onToggle).toHaveBeenLastCalledWith('🙏', true);
  });
});

describe('useMessageReaction', () => {
  function setup() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    qc.setQueryData(['messages', CID], [
      { id: 'm1', sender_type: 'contact', reactions: [{ emoji: HEART, count: 1, visitor: false, mine: false }], can_react: true },
      { id: 'm2', sender_type: 'contact', can_react: true },
    ]);
    vi.spyOn(qc, 'invalidateQueries').mockResolvedValue();
    const onError = vi.fn();
    const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: qc }, children);
    const hook = renderHook(() => useMessageReaction(CID, WS, onError), { wrapper });
    const row = (id: string) => (qc.getQueryData(['messages', CID]) as Array<{ id: string; reactions?: unknown }>).find((r) => r.id === id);
    return { qc, hook, onError, row };
  }

  it('shows the reaction at once, then the server\'s list', async () => {
    let answer: (v: unknown) => void = () => {};
    api.setReaction.mockImplementation(() => new Promise((r) => { answer = r; }));
    const { hook, row } = setup();
    act(() => { hook.result.current.mutate({ messageId: 'm1', emoji: HEART, on: true }); });
    await waitFor(() => expect(row('m1')!.reactions).toEqual([{ emoji: HEART, count: 2, visitor: false, mine: true }]));
    expect(api.setReaction).toHaveBeenCalledWith({ workspace_id: WS, conversation_id: CID, message_id: 'm1', emoji: HEART, on: true });
    await act(async () => { answer({ ok: true, message_id: 'm1', reactions: [{ emoji: HEART, count: 3, visitor: true, mine: true }], at: 1 }); });
    await waitFor(() => expect(row('m1')!.reactions).toEqual([{ emoji: HEART, count: 3, visitor: true, mine: true }]));
  });

  it('puts the row back as it was when the server refuses, and says so', async () => {
    api.setReaction.mockRejectedValue(new Error('reactions_not_shown'));
    const { hook, row, onError } = setup();
    act(() => { hook.result.current.mutate({ messageId: 'm2', emoji: '👍', on: true }); });
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(row('m2')!.reactions).toBeUndefined();
    expect(row('m1')!.reactions).toEqual([{ emoji: HEART, count: 1, visitor: false, mine: false }]);
  });

  it('a refused toggle does not undo a later one still on its way: that one\'s answer settles the row', async () => {
    const answers: Array<{ ok: (v: unknown) => void; no: (e: Error) => void }> = [];
    api.setReaction.mockImplementation(() => new Promise((ok, no) => { answers.push({ ok, no }); }));
    const { hook, row, onError } = setup();
    act(() => { hook.result.current.mutate({ messageId: 'm2', emoji: '👍', on: true }); });
    act(() => { hook.result.current.mutate({ messageId: 'm2', emoji: HEART, on: true }); });
    await waitFor(() => expect(answers).toHaveLength(2));
    expect(row('m2')!.reactions).toEqual([
      { emoji: HEART, count: 1, visitor: false, mine: true },
      { emoji: '👍', count: 1, visitor: false, mine: true },
    ]);
    await act(async () => { answers[0].no(new Error('boom')); });
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    // The ❤️ given after it is still on screen.
    expect(row('m2')!.reactions).toEqual(expect.arrayContaining([{ emoji: HEART, count: 1, visitor: false, mine: true }]));
    await act(async () => { answers[1].ok({ ok: true, message_id: 'm2', reactions: [{ emoji: HEART, count: 1, visitor: false, mine: true }], at: 2 }); });
    await waitFor(() => expect(row('m2')!.reactions).toEqual([{ emoji: HEART, count: 1, visitor: false, mine: true }]));
  });

  it('a toggle stays with its thread when the operator opens another before the answer', async () => {
    let answer: (v: unknown) => void = () => {};
    api.setReaction.mockImplementation(() => new Promise((r) => { answer = r; }));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    qc.setQueryData(['messages', CID], [{ id: 'm1', sender_type: 'contact', can_react: true }]);
    qc.setQueryData(['messages', 'other'], [{ id: 'x1', sender_type: 'contact', can_react: true }]);
    const invalidate = vi.spyOn(qc, 'invalidateQueries').mockResolvedValue();
    const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: qc }, children);
    const hook = renderHook(({ cid }) => useMessageReaction(cid, WS), { wrapper, initialProps: { cid: CID } });
    act(() => { hook.result.current.mutate({ messageId: 'm1', emoji: HEART, on: true }); });
    await waitFor(() => expect(api.setReaction).toHaveBeenCalledWith(expect.objectContaining({ conversation_id: CID, message_id: 'm1' })));
    hook.rerender({ cid: 'other' });
    await act(async () => { answer({ ok: true, message_id: 'm1', reactions: [{ emoji: HEART, count: 2, visitor: true, mine: true }], at: 1 }); });
    const rowsOf = (cid: string) => qc.getQueryData(['messages', cid]) as Array<{ id: string; reactions?: unknown }>;
    await waitFor(() => expect(rowsOf(CID)[0].reactions).toEqual([{ emoji: HEART, count: 2, visitor: true, mine: true }]));
    expect(rowsOf('other')[0].reactions).toBeUndefined();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['messages', CID] });
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ['messages', 'other'] });
  });
});

describe('the open thread hears reactions', () => {
  it('message_reactions on the inbox channel re-reads the thread\'s messages, nothing else', async () => {
    const qc = new QueryClient();
    const invalidated: string[] = [];
    vi.spyOn(qc, 'invalidateQueries').mockImplementation(async (filters?: { queryKey?: readonly unknown[] }) => {
      invalidated.push(JSON.stringify(filters?.queryKey));
    });
    const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: qc }, children);
    const onEvent = vi.fn();
    renderHook(() => useInboxRealtime({ workspaceId: WS, conversationId: CID, onEvent }), { wrapper });
    await waitFor(() => expect(subs.find((s) => s.channel === `ws:${WS}:inbox`)).toBeTruthy());
    const inbox = subs.find((s) => s.channel === `ws:${WS}:inbox`)!.handlers;
    inbox.onEvent!({ kind: 'message_reactions', conversation_id: CID, workspace_id: WS, message_id: 'm1', reactions: [], at: 1 });
    await waitFor(() => expect(invalidated).toContain(JSON.stringify(['messages', CID])));
    expect(invalidated.filter((k) => k !== JSON.stringify(['messages', CID]))).toEqual([]);
    expect(onEvent).toHaveBeenCalledTimes(1);
  });
});
