/**
 * The open thread stays read while the operator reads it
 * (src/features/notifications/keepThreadSeen.ts): a visitor message arriving
 * in it is marked seen while the tab is being looked at, at most once a
 * second with the last of a burst marked too; while the tab is hidden or not
 * focused it stays unread (the Inbox badge shows it) until the operator
 * comes back. The team's and the system's messages never mark anything.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { KEEP_SEEN_THROTTLE_MS, useKeepThreadSeen } from '@/features/notifications/keepThreadSeen';

let visible = true;
let focused = true;

beforeEach(() => {
  vi.useFakeTimers();
  visible = true;
  focused = true;
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (visible ? 'visible' : 'hidden') });
  vi.spyOn(document, 'hasFocus').mockImplementation(() => focused);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const fromVisitor = { sender_type: 'contact', conversation_id: 'c-1' };

function mount(conversationId: string | null = 'c-1') {
  const marked: string[] = [];
  const hook = renderHook(({ id }) => useKeepThreadSeen(id, (cid) => marked.push(cid)), { initialProps: { id: conversationId } });
  return { marked, hook };
}

describe('useKeepThreadSeen', () => {
  it('marks the thread seen when a visitor message arrives while it is watched', () => {
    const { marked, hook } = mount();
    hook.result.current(fromVisitor);
    expect(marked).toEqual(['c-1']);
  });

  it('marks at most once a second, and the last of a burst too', () => {
    const { marked, hook } = mount();
    hook.result.current(fromVisitor);
    hook.result.current(fromVisitor);
    hook.result.current(fromVisitor);
    expect(marked).toEqual(['c-1']);
    act(() => { vi.advanceTimersByTime(KEEP_SEEN_THROTTLE_MS); });
    expect(marked).toEqual(['c-1', 'c-1']);
    // Quiet again: the next one goes at once.
    act(() => { vi.advanceTimersByTime(KEEP_SEEN_THROTTLE_MS); });
    hook.result.current(fromVisitor);
    expect(marked).toEqual(['c-1', 'c-1', 'c-1']);
  });

  it('leaves it unread while the tab is hidden, and marks it once when the operator comes back', () => {
    const { marked, hook } = mount();
    visible = false;
    hook.result.current(fromVisitor);
    hook.result.current(fromVisitor);
    expect(marked).toEqual([]);
    visible = true;
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(marked).toEqual(['c-1']);
    // Owed nothing more: a second return marks nothing.
    act(() => { window.dispatchEvent(new Event('focus')); });
    expect(marked).toEqual(['c-1']);
  });

  it('leaves it unread while the window is not focused, until it is', () => {
    const { marked, hook } = mount();
    focused = false;
    hook.result.current(fromVisitor);
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(marked).toEqual([]);
    focused = true;
    act(() => { window.dispatchEvent(new Event('focus')); });
    expect(marked).toEqual(['c-1']);
  });

  it('a burst\'s last message arriving as the operator leaves waits for their return', () => {
    const { marked, hook } = mount();
    hook.result.current(fromVisitor);
    hook.result.current(fromVisitor);
    visible = false;
    act(() => { vi.advanceTimersByTime(KEEP_SEEN_THROTTLE_MS); });
    expect(marked).toEqual(['c-1']);
    visible = true;
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(marked).toEqual(['c-1', 'c-1']);
  });

  it('never marks for the team\'s, the AI\'s or the system\'s messages, or another conversation\'s', () => {
    const { marked, hook } = mount();
    for (const sender_type of ['agent', 'ai', 'system', 'bot']) hook.result.current({ sender_type, conversation_id: 'c-1' });
    hook.result.current({ sender_type: 'contact', conversation_id: 'c-2' });
    expect(marked).toEqual([]);
  });

  it('owes the previous thread nothing once another is open, and nothing with none open', () => {
    const { marked, hook } = mount();
    visible = false;
    hook.result.current(fromVisitor);
    hook.rerender({ id: 'c-2' });
    visible = true;
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(marked).toEqual([]);
    hook.rerender({ id: null });
    hook.result.current(fromVisitor);
    expect(marked).toEqual([]);
  });
});
