/**
 * Horizontal strips in the Art frame: the context bar's views, and the side
 * lists that turn into a row of pills on a phone (settings, AI agent, SEO,
 * analytics). Two helpers keep them readable when they scroll sideways.
 */
import { useEffect, type RefObject } from 'react';
import { useLocation } from 'react-router-dom';

/**
 * Marks which ends of a sideways-scrolling strip hide more of it, as
 * `data-art-fade="start" | "end" | "both"` (theme.css fades those edges), so
 * a member can tell there is more. No attribute while everything fits.
 */
export function useScrollFade(ref: RefObject<HTMLElement>, enabled = true) {
  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    const update = () => {
      const max = el.scrollWidth - el.clientWidth;
      // 0 at the start in either direction (RTL scrolls to negative values).
      const pos = Math.abs(el.scrollLeft);
      const start = max > 1 && pos > 1;
      const end = max > 1 && pos < max - 1;
      const next = start && end ? 'both' : start ? 'start' : end ? 'end' : null;
      if (next) el.setAttribute('data-art-fade', next);
      else el.removeAttribute('data-art-fade');
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    // Its own width, and its content's (pages portal into the context bar).
    const resize = new ResizeObserver(update);
    const watch = () => {
      resize.disconnect();
      resize.observe(el);
      for (const child of Array.from(el.children)) resize.observe(child);
    };
    watch();
    const mutation = new MutationObserver(() => {
      watch();
      update();
    });
    mutation.observe(el, { childList: true, subtree: true });
    return () => {
      el.removeEventListener('scroll', update);
      resize.disconnect();
      mutation.disconnect();
      el.removeAttribute('data-art-fade');
    };
  }, [ref, enabled]);
}

// The strips, and in each the item that says where the member is.
const STRIPS = '[data-shell="context-bar"], [data-shell="main"] [data-section-nav]';
const CURRENT = [
  '[data-section-nav-item][data-active="true"]',
  '[data-nav-item][data-active="true"]',
  '[data-section-nav-group][data-active="true"]',
];
// Room left for the edge fade.
const EDGE = 24;

function sidewaysScroller(from: HTMLElement, root: HTMLElement) {
  for (let el: HTMLElement | null = from.parentElement; el; el = el.parentElement) {
    if (el.matches('[data-shell="main"], [data-shell="app"]')) return null;
    if (el.scrollWidth > el.clientWidth + 1 && /(auto|scroll)/.test(getComputedStyle(el).overflowX)) return el;
    if (el === root) return null;
  }
  return null;
}

function revealCurrentItems() {
  for (const root of Array.from(document.querySelectorAll<HTMLElement>(STRIPS))) {
    // The most precise marker that is actually shown (a phone strip may
    // hide the open group's pages and show only the group).
    let item: HTMLElement | null = null;
    for (const selector of CURRENT) {
      item = Array.from(root.querySelectorAll<HTMLElement>(selector)).find((el) => el.getClientRects().length > 0) ?? null;
      if (item) break;
    }
    if (!item) continue;
    const scroller = sidewaysScroller(item, root);
    if (!scroller) continue;
    const box = scroller.getBoundingClientRect();
    const rect = item.getBoundingClientRect();
    if (rect.left >= box.left + EDGE && rect.right <= box.right - EDGE) continue;
    // Centre it. A larger scrollLeft always moves the view rightwards, in
    // RTL too, so the same sum works in both directions.
    const delta = rect.left + rect.width / 2 - (box.left + box.width / 2);
    scroller.scrollTo({ left: scroller.scrollLeft + delta, behavior: 'auto' });
  }
}

/**
 * After every navigation, scrolls each sideways strip so its current item is
 * in view (on a phone the open settings page can sit far off-screen in a long
 * row of pills). Only scrolls strips whose current item is out of view; the
 * page itself never moves. Pages load lazily, so it looks again a few times.
 */
export function useRevealCurrentInStrips() {
  const { pathname, search } = useLocation();
  useEffect(() => {
    const frame = requestAnimationFrame(revealCurrentItems);
    const timers = [200, 700, 1600].map((ms) => window.setTimeout(revealCurrentItems, ms));
    return () => {
      cancelAnimationFrame(frame);
      timers.forEach((id) => window.clearTimeout(id));
    };
  }, [pathname, search]);
}
