import { useEffect, useRef, type RefObject } from 'react';

/**
 * Keeps a message list pinned to its newest message.
 *
 * Scrolling once, when the messages first render, is not enough: an image or
 * a file card finishes loading AFTER that scroll and grows the content under
 * it, which leaves the newest message sitting below the fold. The widget hit
 * exactly this and solved it by re-pinning on every content resize; the
 * operator inbox had the naive version — a single smooth `scrollIntoView`
 * keyed on message COUNT, so opening a different conversation with the same
 * number of messages did not scroll at all.
 *
 * Two behaviours, deliberately different:
 *   - Opening a conversation jumps instantly to the bottom. A smooth scroll
 *     through a thousand messages is a long, useless animation.
 *   - A message arriving while you are already at the bottom scrolls
 *     smoothly. One arriving while you are reading history does NOT — being
 *     yanked away mid-sentence is worse than missing a scroll.
 */
export interface StickToBottomOptions {
  /** Changing this is "a different conversation opened" — jump, don't glide. */
  conversationKey: string | null | undefined;
  /** Changing this is "the messages changed" — glide, if we were pinned. */
  revision: unknown;
  /** Treated as "at the bottom" within this many pixels. */
  threshold?: number;
}

export function useStickToBottom(
  containerRef: RefObject<HTMLElement | null>,
  contentRef: RefObject<HTMLElement | null>,
  { conversationKey, revision, threshold = 80 }: StickToBottomOptions,
): void {
  /** False once the reader scrolls up; true again when they come back down. */
  const pinnedRef = useRef(true);
  const lastKeyRef = useRef<string | null | undefined>(undefined);

  const scrollToBottom = (behavior: ScrollBehavior) => {
    const el = containerRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
  };

  // Track whether the reader is at the bottom. Passive: never blocks scroll.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onScroll = () => {
      pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [containerRef, threshold]);

  // Re-pin whenever the content grows under us — a late image, a file card,
  // a font swap. Only while pinned, so it never fights a reader who has
  // deliberately scrolled up.
  useEffect(() => {
    const content = contentRef.current;
    if (!content || typeof ResizeObserver !== 'function') return;
    const observer = new ResizeObserver(() => {
      if (pinnedRef.current) scrollToBottom('auto');
    });
    observer.observe(content);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contentRef, containerRef]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const opened = lastKeyRef.current !== conversationKey;
    lastKeyRef.current = conversationKey;

    if (opened) {
      // A freshly opened conversation always starts at its newest message,
      // whatever the reader was doing in the previous one.
      pinnedRef.current = true;
      scrollToBottom('auto');
      // The first paint can precede layout of the rows themselves, so take
      // the next frame too. The ResizeObserver above covers everything that
      // lands later.
      const raf = requestAnimationFrame(() => scrollToBottom('auto'));
      return () => cancelAnimationFrame(raf);
    }
    if (pinnedRef.current) scrollToBottom('smooth');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationKey, revision]);
}
