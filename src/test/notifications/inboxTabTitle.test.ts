/**
 * "(n) " in front of the tab's title while the Inbox has unread chats
 * (src/features/notifications/inboxTabTitle.ts): set, updated, capped at
 * 99+, kept when another writer (PlatformBrandingGate) rewrites the title,
 * and gone at zero and when the hook unmounts, without the observer that
 * keeps it ever writing in a loop.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { titleWithUnread, useInboxTabTitle } from '@/features/notifications/inboxTabTitle';

/** MutationObserver callbacks run as microtasks: let them. */
async function settle() {
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

beforeEach(() => {
  document.title = 'WebYar';
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('the title as it should read', () => {
  it('prefixes the count, caps it, and never stacks prefixes', () => {
    expect(titleWithUnread('WebYar', 3)).toBe('(3) WebYar');
    expect(titleWithUnread('(3) WebYar', 4)).toBe('(4) WebYar');
    expect(titleWithUnread('WebYar', 100)).toBe('(99+) WebYar');
    expect(titleWithUnread('(99+) WebYar', 2)).toBe('(2) WebYar');
    expect(titleWithUnread('(7) WebYar', 0)).toBe('WebYar');
    // A title that merely contains a number in brackets is not ours.
    expect(titleWithUnread('Inbox (beta)', 0)).toBe('Inbox (beta)');
  });

  it('writes Persian digits in Persian, as the panel does, and knows its prefix in both', () => {
    expect(titleWithUnread('وب‌یار', 3, true)).toBe('(۳) وب‌یار');
    expect(titleWithUnread('وب‌یار', 120, true)).toBe('(۹۹+) وب‌یار');
    // The language changed while it was up: replaced, not stacked.
    expect(titleWithUnread('(۳) وب‌یار', 4)).toBe('(4) وب‌یار');
    expect(titleWithUnread('(4) WebYar', 4, true)).toBe('(۴) WebYar');
    expect(titleWithUnread('(۹۹+) وب‌یار', 0, true)).toBe('وب‌یار');
  });
});

describe('useInboxTabTitle', () => {
  it('sets the prefix, updates it and caps it', async () => {
    const { rerender, unmount } = renderHook(({ n }) => useInboxTabTitle(n), { initialProps: { n: 1 } });
    expect(document.title).toBe('(1) WebYar');
    rerender({ n: 12 });
    expect(document.title).toBe('(12) WebYar');
    rerender({ n: 150 });
    expect(document.title).toBe('(99+) WebYar');
    unmount();
  });

  it('keeps it when another writer rewrites the title', async () => {
    const { unmount } = renderHook(() => useInboxTabTitle(2));
    expect(document.title).toBe('(2) WebYar');
    document.title = 'WebYar — پنل';
    await settle();
    expect(document.title).toBe('(2) WebYar — پنل');
    unmount();
  });

  it('removes it at zero and on unmount', async () => {
    const { rerender, unmount } = renderHook(({ n }) => useInboxTabTitle(n), { initialProps: { n: 5 } });
    expect(document.title).toBe('(5) WebYar');
    rerender({ n: 0 });
    expect(document.title).toBe('WebYar');
    rerender({ n: 3 });
    unmount();
    expect(document.title).toBe('WebYar');
    // And it no longer follows the title once unmounted.
    document.title = 'Other';
    await settle();
    expect(document.title).toBe('Other');
  });

  it('does not write in a loop: one write per change of the title', async () => {
    const { unmount } = renderHook(() => useInboxTabTitle(4));
    await settle();
    const original = Object.getOwnPropertyDescriptor(Document.prototype, 'title')!;
    let writes = 0;
    Object.defineProperty(document, 'title', {
      configurable: true,
      get: () => original.get!.call(document),
      set: (v: string) => { writes += 1; original.set!.call(document, v); },
    });
    try {
      document.title = 'Rebranded'; // the other writer
      await settle();
      await settle();
      expect(document.title).toBe('(4) Rebranded');
      // The other writer's write, then the prefix: and the observer settles.
      expect(writes).toBe(2);
    } finally {
      // Back to the prototype's own accessor.
      delete (document as unknown as Record<string, unknown>).title;
      unmount();
    }
  });
});
