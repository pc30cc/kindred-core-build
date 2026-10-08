/**
 * src/lib/perf/prefetch.ts: when page code is downloaded ahead of a click.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  WARM_CACHE_MESSAGE,
  afterLoadWhenIdle,
  canPrefetch,
  installLinkPrefetch,
  warmServiceWorkerCache,
} from '@/lib/perf/prefetch';

const nav = (connection?: { saveData?: boolean; effectiveType?: string }) =>
  ({ connection }) as unknown as Navigator;

describe('canPrefetch', () => {
  it('prefetches unless the browser asks to save data or the connection is 2G', () => {
    expect(canPrefetch(undefined)).toBe(true);
    expect(canPrefetch(nav())).toBe(true);
    expect(canPrefetch(nav({ effectiveType: '4g' }))).toBe(true);
    expect(canPrefetch(nav({ effectiveType: '3g' }))).toBe(true);
    expect(canPrefetch(nav({ saveData: true, effectiveType: '4g' }))).toBe(false);
    expect(canPrefetch(nav({ effectiveType: '2g' }))).toBe(false);
    expect(canPrefetch(nav({ effectiveType: 'slow-2g' }))).toBe(false);
    // Offline: a failed speculative download would poison the page until a reload.
    expect(canPrefetch({ onLine: false } as Navigator)).toBe(false);
    expect(canPrefetch({ onLine: true } as Navigator)).toBe(true);
  });
});

describe('installLinkPrefetch', () => {
  let remove: () => void = () => {};

  afterEach(() => {
    remove();
    document.body.innerHTML = '';
  });

  function link(href: string, attrs: Record<string, string> = {}) {
    const anchor = document.createElement('a');
    anchor.href = href;
    for (const [name, value] of Object.entries(attrs)) anchor.setAttribute(name, value);
    const label = document.createElement('span');
    label.textContent = href;
    anchor.appendChild(label);
    document.body.appendChild(anchor);
    return label;
  }

  const hover = (target: Element) => target.dispatchEvent(new Event('pointerover', { bubbles: true }));
  const focus = (target: Element) => target.dispatchEvent(new Event('focusin', { bubbles: true }));

  it('prefetches the page behind a link that is pointed at or focused, once', () => {
    const preload = vi.fn(() => Promise.resolve());
    const resolve = vi.fn((pathname: string) => (pathname === '/studio/inbox' ? [{ preload }] : []));
    remove = installLinkPrefetch(resolve);

    const inbox = link('/studio/inbox');
    hover(inbox);
    expect(resolve).toHaveBeenCalledWith('/studio/inbox');
    expect(preload).toHaveBeenCalledTimes(1);

    hover(inbox);
    focus(inbox);
    expect(preload).toHaveBeenCalledTimes(1);

    focus(link('/studio/contacts?tab=all'));
    expect(resolve).toHaveBeenLastCalledWith('/studio/contacts');
  });

  it('leaves other origins, new tabs and downloads alone', () => {
    const resolve = vi.fn(() => []);
    remove = installLinkPrefetch(resolve);

    hover(link('https://example.com/studio/inbox'));
    hover(link('/studio/inbox', { target: '_blank' }));
    hover(link('/downloads/webyar-woocommerce.zip', { download: '' }));
    hover(document.body);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('stops listening once removed', () => {
    const resolve = vi.fn(() => []);
    remove = installLinkPrefetch(resolve);
    remove();
    hover(link('/studio/inbox'));
    expect(resolve).not.toHaveBeenCalled();
  });
});

describe('afterLoadWhenIdle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // jsdom has no requestIdleCallback; make that explicit (Safari path).
    vi.stubGlobal('requestIdleCallback', undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const loaded = () => {
    // Already "complete" in jsdom; otherwise the function waits for `load`.
    if (document.readyState !== 'complete') window.dispatchEvent(new Event('load'));
  };

  it('runs after the page has loaded and the delay has passed', () => {
    const callback = vi.fn();
    afterLoadWhenIdle(callback, 1000);
    loaded();
    vi.advanceTimersByTime(999);
    expect(callback).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('can be cancelled', () => {
    const callback = vi.fn();
    const cancel = afterLoadWhenIdle(callback, 1000);
    loaded();
    cancel();
    vi.advanceTimersByTime(5000);
    expect(callback).not.toHaveBeenCalled();
  });
});

describe('warmServiceWorkerCache', () => {
  function withWorker(connection?: { saveData?: boolean; effectiveType?: string }) {
    const postMessage = vi.fn();
    const registration = { active: { postMessage } };
    const nav = { connection, serviceWorker: { ready: Promise.resolve(registration) } } as unknown as Navigator;
    return { nav, postMessage };
  }

  it('asks the active worker to cache the rest of the build', async () => {
    const { nav, postMessage } = withWorker();
    warmServiceWorkerCache(nav);
    await Promise.resolve();
    await Promise.resolve();
    expect(postMessage).toHaveBeenCalledWith(WARM_CACHE_MESSAGE);
    expect(WARM_CACHE_MESSAGE).toBe('WARM_CACHE');
  });

  it('stands down on Save-Data and 2G', async () => {
    for (const connection of [{ saveData: true }, { effectiveType: '2g' }]) {
      const { nav, postMessage } = withWorker(connection);
      warmServiceWorkerCache(nav);
      await Promise.resolve();
      await Promise.resolve();
      expect(postMessage).not.toHaveBeenCalled();
    }
  });

  it('does nothing without a service worker', () => {
    expect(() => warmServiceWorkerCache({} as Navigator)).not.toThrow();
    expect(() => warmServiceWorkerCache(undefined)).not.toThrow();
  });
});
