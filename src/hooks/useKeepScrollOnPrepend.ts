import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react';

/**
 * Keeps what the reader looks at in place when rows are put BEFORE the ones
 * on screen (an older page of a thread). Call `prepare()` right before the
 * rows are written (not before they are asked for: the reader may scroll
 * meanwhile); on the next change of `revision` (the rows), the scroller
 * moves down by exactly the height the new rows took, before the browser
 * paints. Browser scroll anchoring is not relied on (Safari has none).
 */
export function useKeepScrollOnPrepend(containerRef: RefObject<HTMLElement | null>, revision: unknown) {
  const saved = useRef<{ height: number; top: number; at: number } | null>(null);

  // A mark older than a second is stale (the rows never came), so a later
  // new message never moves the reader.
  const prepare = useCallback(() => {
    const el = containerRef.current;
    saved.current = el ? { height: el.scrollHeight, top: el.scrollTop, at: Date.now() } : null;
  }, [containerRef]);

  const cancel = useCallback(() => { saved.current = null; }, []);

  useLayoutEffect(() => {
    const el = containerRef.current;
    const was = saved.current;
    if (!el || !was) return;
    saved.current = null;
    if (Date.now() - was.at > 1000) return;
    const grown = el.scrollHeight - was.height;
    if (grown > 0) el.scrollTop = was.top + grown;
  }, [containerRef, revision]);

  return { prepare, cancel };
}
