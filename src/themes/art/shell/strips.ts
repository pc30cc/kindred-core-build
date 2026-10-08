/**
 * Strips in the Art frame: the context bar's views, and in a page its side
 * list (a row of pills on a phone, a floating panel on a laptop: settings,
 * AI agent, SEO, analytics), the call center's tabs, a row of tabs, or
 * anything a page marks with `data-art-strip`. Three helpers keep them
 * readable when they scroll: the edge that hides more fades out, and the
 * current item is always in view.
 */
import { useEffect, type RefObject } from 'react';
import { useLocation } from 'react-router-dom';

type Fade = 'start' | 'end' | 'both' | null;

/** `min`: how much must be out of view before an edge counts as hiding more. */
function fadeOf(pos: number, max: number, min = 1): Fade {
  const start = max > min && pos > 1;
  const end = max > min && pos < max - 1;
  return start && end ? 'both' : start ? 'start' : end ? 'end' : null;
}

function setFade(el: HTMLElement, name: string, fade: Fade) {
  if (fade) {
    if (el.getAttribute(name) !== fade) el.setAttribute(name, fade);
  } else if (el.hasAttribute(name)) {
    el.removeAttribute(name);
  }
}

/** Sideways: 0 at the start in either direction (RTL scrolls to negative values). */
function fadeX(el: HTMLElement): Fade {
  return fadeOf(Math.abs(el.scrollLeft), el.scrollWidth - el.clientWidth);
}

/** Downwards; a few pixels (a focus ring, a descender) are not "more". */
function fadeY(el: HTMLElement): Fade {
  return fadeOf(el.scrollTop, el.scrollHeight - el.clientHeight, 8);
}

const SCROLLS = /(auto|scroll)/;

/**
 * Marks which ends of a sideways-scrolling strip hide more of it, as
 * `data-art-fade="start" | "end" | "both"` (theme.css fades those edges), so
 * a member can tell there is more. No attribute while everything fits.
 */
export function useScrollFade(ref: RefObject<HTMLElement>, enabled = true) {
  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    const update = () => setFade(el, 'data-art-fade', fadeX(el));
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
const PAGE_STRIPS =
  '[data-shell="main"] :is([data-section-nav], [data-section-tabs], [data-slot="tabs-list"], [data-art-strip])';
const STRIPS = `[data-shell="context-bar"], ${PAGE_STRIPS}`;
const CURRENT = [
  '[data-section-nav-item][data-active="true"]',
  '[data-nav-item][data-active="true"]',
  '[data-section-nav-group][data-active="true"]',
  '[aria-current="page"]',
  '[role="tab"][aria-selected="true"]',
];
// Room left for the edge fade: a row's mask, a side list's taller veil.
const EDGE = 24;
const EDGE_Y = 48;

/** The nearest box between `from` and its strip `root` that scrolls, and which way. */
function scrollerOf(from: HTMLElement, root: HTMLElement) {
  for (let el: HTMLElement | null = from.parentElement; el; el = el.parentElement) {
    if (el.matches('[data-shell="main"], [data-shell="app"]')) return null;
    const style = getComputedStyle(el);
    if (el.scrollWidth > el.clientWidth + 1 && SCROLLS.test(style.overflowX)) return { el, axis: 'x' as const };
    if (el.scrollHeight > el.clientHeight + 1 && SCROLLS.test(style.overflowY)) return { el, axis: 'y' as const };
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
    const scroller = scrollerOf(item, root);
    if (!scroller) continue;
    const { el } = scroller;
    const box = el.getBoundingClientRect();
    const rect = item.getBoundingClientRect();
    // Centre it. A larger scrollLeft always moves the view rightwards, in
    // RTL too, so the same sum works in both directions.
    if (scroller.axis === 'x') {
      if (rect.left >= box.left + EDGE && rect.right <= box.right - EDGE) continue;
      el.scrollTo({ left: el.scrollLeft + rect.left + rect.width / 2 - (box.left + box.width / 2), behavior: 'auto' });
    } else {
      if (rect.top >= box.top + EDGE_Y && rect.bottom <= box.bottom - EDGE_Y) continue;
      el.scrollTo({ top: el.scrollTop + rect.top + rect.height / 2 - (box.top + box.height / 2), behavior: 'auto' });
    }
  }
}

/**
 * After every navigation, scrolls each strip so its current item is in view
 * (on a phone the open settings page can sit far off-screen in a long row of
 * pills; on a short laptop screen, below the fold of the side list). Only
 * scrolls strips whose current item is out of view; the page itself never
 * moves. Pages load lazily, so it looks again a few times; and again when
 * the language changes (every pill changes width).
 */
export function useRevealCurrentInStrips(locale?: string) {
  const { pathname, search } = useLocation();
  useEffect(() => {
    const frame = requestAnimationFrame(revealCurrentItems);
    const timers = [200, 700, 1600].map((ms) => window.setTimeout(revealCurrentItems, ms));
    return () => {
      cancelAnimationFrame(frame);
      timers.forEach((id) => window.clearTimeout(id));
    };
  }, [pathname, search, locale]);
}

/** A strip's boxes that scroll: the strip itself, or a box just inside it. */
function scrollersIn(root: HTMLElement) {
  const scrolls = (el: Element) => {
    const style = getComputedStyle(el);
    return SCROLLS.test(style.overflowX) || SCROLLS.test(style.overflowY);
  };
  if (scrolls(root)) return [root];
  return (Array.from(root.children) as HTMLElement[]).filter(scrolls);
}

// What theme.css needs to lay a veil exactly over a side list's edge: its
// padding (a sticky box stops inside it), its gap (a flex column puts one
// after the veil too) and its paper.
const VEIL_PROPS = ['--art-veil-start', '--art-veil-end', '--art-veil-gap', '--art-veil-paper'];

/** The colour a box is painted on: its own, or the nearest box's under it. */
function paperOf(el: HTMLElement) {
  for (let node: HTMLElement | null = el; node; node = node.parentElement) {
    const color = getComputedStyle(node).backgroundColor;
    if (color && color !== 'transparent' && !/^rgba\(.*,\s*0\)$/.test(color)) return color;
  }
  return '';
}

function markFades(el: HTMLElement) {
  const style = getComputedStyle(el);
  const scrolls = SCROLLS.test(style.overflowX) || SCROLLS.test(style.overflowY);
  // One axis per strip: a list that runs downwards (a block or a flex
  // column, more of it below than beside) fades at its top and bottom;
  // anything else is a row and fades at its ends.
  const column =
    style.display === 'block' || style.display === 'flow-root' || (style.display === 'flex' && style.flexDirection.startsWith('column'));
  const downwards = column && el.scrollHeight - el.clientHeight > el.scrollWidth - el.clientWidth;
  const y = scrolls && downwards ? fadeY(el) : null;
  const x = scrolls && !y ? fadeX(el) : null;
  setFade(el, 'data-art-fade', x);
  setFade(el, 'data-art-fade-y', y);
  if (y) {
    const gap = style.rowGap === 'normal' || style.display !== 'flex' ? '0px' : style.rowGap;
    const values = [style.paddingTop, style.paddingBottom, gap, paperOf(el)];
    VEIL_PROPS.forEach((name, i) => {
      if (values[i] && el.style.getPropertyValue(name) !== values[i]) el.style.setProperty(name, values[i]);
    });
  } else {
    VEIL_PROPS.forEach((name) => el.style.removeProperty(name));
  }
}

function clearFades(el: HTMLElement) {
  el.removeAttribute('data-art-fade');
  el.removeAttribute('data-art-fade-y');
  VEIL_PROPS.forEach((name) => el.style.removeProperty(name));
}

/**
 * Fades the edges of every strip a page shows (PAGE_STRIPS) that hide more
 * of it: `data-art-fade` sideways (a row of pills cut by the screen's edge),
 * `data-art-fade-y` downwards or upwards (a side list taller than the
 * screen); theme.css draws both. Pages need no code of their own for it,
 * and it follows them as they load, change and resize.
 */
export function useStripFades() {
  useEffect(() => {
    const tracked = new Set<HTMLElement>();
    // Each strip's own size, and its content's (a group opening, a late
    // web font): either changes what is hidden.
    let watched = new WeakSet<Element>();
    const resize = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const el = entry.target as HTMLElement;
        const strip = tracked.has(el) ? el : el.parentElement;
        if (strip && tracked.has(strip)) markFades(strip);
      }
    });
    const watch = (el: Element) => {
      if (watched.has(el)) return;
      watched.add(el);
      resize.observe(el);
    };
    const scan = () => {
      const now = new Set<HTMLElement>();
      for (const root of Array.from(document.querySelectorAll<HTMLElement>(PAGE_STRIPS))) {
        for (const el of scrollersIn(root)) now.add(el);
      }
      const gone = Array.from(tracked).filter((el) => !now.has(el));
      if (gone.length) {
        // Start over, so nothing that left the page is still observed.
        resize.disconnect();
        watched = new WeakSet();
        for (const el of gone) {
          tracked.delete(el);
          clearFades(el);
        }
      }
      for (const el of now) {
        if (!tracked.has(el)) {
          tracked.add(el);
          markFades(el);
        }
        watch(el);
        for (const child of Array.from(el.children)) watch(child);
      }
    };
    let frame = 0;
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(() => {
        frame = 0;
        scan();
      });
    };
    const onScroll = (event: Event) => {
      const el = event.target as HTMLElement;
      if (tracked.has(el)) markFades(el);
    };
    scan();
    // Scroll events do not bubble; a capturing listener sees them all.
    document.addEventListener('scroll', onScroll, { capture: true, passive: true });
    // A breakpoint can turn a side list into a row (and back).
    const onResize = () => {
      schedule();
      tracked.forEach(markFades);
    };
    window.addEventListener('resize', onResize);
    const mutation = new MutationObserver(schedule);
    mutation.observe(document.body, { childList: true, subtree: true });
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('scroll', onScroll, { capture: true });
      window.removeEventListener('resize', onResize);
      mutation.disconnect();
      resize.disconnect();
      tracked.forEach(clearFades);
    };
  }, []);
}
