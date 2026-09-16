import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { render, act } from '@testing-library/react';
import { useRef } from 'react';
import { useStickToBottom } from '@/hooks/useStickToBottom';

/**
 * The operator inbox scrolled with one line: a smooth `scrollIntoView` keyed
 * on the message COUNT. Three things were wrong with it — opening a different
 * conversation with the same number of messages did not scroll at all, a
 * thousand-message thread animated all the way down, and an image that
 * finished loading after that scroll pushed the newest message out of view.
 *
 * jsdom has no layout, so this tests the decisions — when to scroll, how, and
 * when to leave the reader alone — not the pixels.
 */

let resizeCallbacks: Array<() => void> = [];

class FakeResizeObserver {
  constructor(private cb: () => void) { resizeCallbacks.push(() => this.cb()); }
  observe() { /* single element per test */ }
  disconnect() { /* no-op */ }
}

interface Harness { conversationKey: string | null; revision: unknown }

function Host({ conversationKey, revision }: Harness) {
  const container = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  useStickToBottom(container, content, { conversationKey, revision });
  return (
    <div ref={container} data-testid="container">
      <div ref={content}>rows</div>
    </div>
  );
}

/** Every scroll the hook asked for, in order. */
let calls: Array<{ top: number; behavior?: ScrollBehavior }> = [];

const CONTENT_HEIGHT = 1000;
const VIEWPORT_HEIGHT = 400;

function setup(props: Harness) {
  const view = render(<Host {...props} />);
  const el = view.getByTestId('container') as HTMLDivElement;
  // Pinned to start: 1000 - 600 - 400 = 0px from the bottom.
  el.scrollTop = 600;
  return { view, el };
}

beforeEach(() => {
  calls = [];
  resizeCallbacks = [];
  // The hook's effects run during render(), so every stub has to be on the
  // prototype before the first one mounts. jsdom also reports 0 for every
  // layout box, so give elements a real shape — otherwise "am I at the
  // bottom?" is always trivially true.
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true, get: () => CONTENT_HEIGHT,
  });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true, get: () => VIEWPORT_HEIGHT,
  });
  HTMLElement.prototype.scrollTo = function scrollToStub(opts?: ScrollToOptions | number) {
    if (opts && typeof opts === 'object') {
      calls.push({ top: opts.top as number, behavior: opts.behavior });
    }
  } as HTMLElement['scrollTo'];
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0); return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', () => { /* no-op */ });
});

describe('opening a conversation', () => {
  it('jumps to the bottom instead of animating through the whole thread', () => {
    const { el } = setup({ conversationKey: 'c1', revision: 3 });
    act(() => { el.dispatchEvent(new Event('scroll')); });
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.behavior === 'auto')).toBe(true);
    expect(calls.at(-1)!.top).toBe(CONTENT_HEIGHT);
  });

  it('scrolls for a different conversation with the SAME message count', () => {
    // The old effect keyed on `rawMessages.length` alone, so this did nothing.
    const { view, el } = setup({ conversationKey: 'c1', revision: 3 });
    act(() => { el.dispatchEvent(new Event('scroll')); });
    calls = [];
    act(() => { view.rerender(<Host conversationKey="c2" revision={3} />); });
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.at(-1)).toMatchObject({ top: CONTENT_HEIGHT, behavior: 'auto' });
  });

  it('starts at the bottom even if the reader had scrolled up in the last one', () => {
    const { view, el } = setup({ conversationKey: 'c1', revision: 1 });
    el.scrollTop = 0; // reader is far from the bottom
    act(() => { el.dispatchEvent(new Event('scroll')); });
    calls = [];
    act(() => { view.rerender(<Host conversationKey="c2" revision={1} />); });
    expect(calls.at(-1)).toMatchObject({ top: CONTENT_HEIGHT, behavior: 'auto' });
  });
});

describe('a message arriving', () => {
  it('glides down when the reader is already at the bottom', () => {
    const { view, el } = setup({ conversationKey: 'c1', revision: 1 });
    act(() => { el.dispatchEvent(new Event('scroll')); });
    calls = [];
    act(() => { view.rerender(<Host conversationKey="c1" revision={2} />); });
    expect(calls).toEqual([{ top: CONTENT_HEIGHT, behavior: 'smooth' }]);
  });

  it('leaves a reader who scrolled up exactly where they were', () => {
    // Being yanked away mid-sentence is worse than missing a scroll.
    const { view, el } = setup({ conversationKey: 'c1', revision: 1 });
    el.scrollTop = 0;
    act(() => { el.dispatchEvent(new Event('scroll')); });
    calls = [];
    act(() => { view.rerender(<Host conversationKey="c1" revision={2} />); });
    expect(calls).toEqual([]);
  });
});

describe('content that lands late', () => {
  it('re-pins when an image grows the thread under the newest message', () => {
    // The whole reason the widget needed a ResizeObserver: the first scroll
    // happens before the image has a height.
    const { el } = setup({ conversationKey: 'c1', revision: 1 });
    act(() => { el.dispatchEvent(new Event('scroll')); });
    calls = [];
    act(() => { resizeCallbacks.forEach((fire) => fire()); });
    expect(calls).toEqual([{ top: CONTENT_HEIGHT, behavior: 'auto' }]);
  });

  it('does not re-pin under a reader who scrolled up', () => {
    const { el } = setup({ conversationKey: 'c1', revision: 1 });
    el.scrollTop = 0;
    act(() => { el.dispatchEvent(new Event('scroll')); });
    calls = [];
    act(() => { resizeCallbacks.forEach((fire) => fire()); });
    expect(calls).toEqual([]);
  });
});

describe('the inbox actually uses it', () => {
  const INBOX = readFileSync('src/pages/app/InboxPage.tsx', 'utf8');

  it('replaced the one-line auto-scroll with the hook', () => {
    expect(INBOX).toContain('useStickToBottom(messagesContainerRef, messagesContentRef, {');
    expect(INBOX).toContain('conversationKey: selectedId,');
    // The old effect keyed on message count alone and animated every open.
    expect(INBOX).not.toContain("messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });");
  });

  it('gives the observer a single wrapper whose height is the content height', () => {
    // ResizeObserver watches an element's box, so without one wrapper around
    // every row there is nothing that grows when a late image lands.
    expect(INBOX).toContain('<div ref={messagesContentRef}>');
    expect(INBOX).toContain('const messagesContentRef = useRef<HTMLDivElement>(null);');
  });
});
