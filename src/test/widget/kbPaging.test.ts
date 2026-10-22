/**
 * V-29: the widget's help center past its first 50 articles, through the
 * shipped runtime.js, runtime-kb.js and runtime-ext.js with each template's
 * real renderer (coreFeaturesHarness.ts):
 *
 *   - t1 and t2 (`kbCategories`): a category counts ALL its articles (the
 *     server's `article_count`), so one past the first page is listed (t1
 *     used to hide it) with its count (t2 used to say 0), and opening it
 *     reads its own articles (GET /api/widget/kb/articles?category_id);
 *   - default (no categories): the list reads the next page when its
 *     scroller nears the end, until it holds `article_total`;
 *   - an older server (no counts, no total) keeps today's behaviour: the
 *     counts of the list the widget has, nothing more is read.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { boot, click, flush, resetWindow, type ApiAnswer } from './coreFeaturesHarness';

beforeEach(() => { vi.useRealTimers(); resetWindow(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

interface Art { id: string; slug: string; title: string; excerpt: string; category_id: string | null }
const art = (i: number, category: string | null): Art => ({ id: `id-${i}`, slug: `a${i}`, title: `مقاله ${i}`, excerpt: '', category_id: category });

/** 80 published articles: «سفارش» holds 1-50 (the first page), «ارسال» 51-80. */
const ALL = Array.from({ length: 80 }, (_, i) => art(i + 1, i < 50 ? 'cat-orders' : 'cat-ship'));
const CATEGORIES = [
  { id: 'cat-orders', name: 'سفارش', slug: 'orders', icon: null, sort_order: 1, article_count: 50 },
  { id: 'cat-ship', name: 'ارسال', slug: 'shipping', icon: null, sort_order: 2, article_count: 30 },
];

/** The help center's routes, as kb.ts answers them; `seen` lists the article pages read. */
function helpCenter(opts: { categories?: unknown[]; counts?: boolean; articles?: Art[] } = {}) {
  const seen: Array<Record<string, string>> = [];
  const articles = opts.articles ?? ALL;
  const api = (url: string): ApiAnswer | undefined => {
    if (url.includes('/api/widget/kb/categories')) {
      const categories = (opts.categories ?? CATEGORIES).map((c) => {
        if (opts.counts !== false) return c;
        const { article_count: _drop, ...rest } = c as Record<string, unknown>;
        return rest;
      });
      return { body: { categories, articles: articles.slice(0, 50), ...(opts.counts === false ? {} : { article_total: articles.length }) } };
    }
    if (url.includes('/api/widget/kb/articles?')) {
      const p = Object.fromEntries(new URL(url).searchParams.entries());
      seen.push(p);
      const pool = p.category_id ? articles.filter((a) => a.category_id === p.category_id) : articles;
      const offset = Number(p.offset || 0);
      const limit = Number(p.limit || 50);
      const page = pool.slice(offset, offset + limit);
      return { body: { articles: page, next_offset: offset + limit < pool.length ? offset + limit : null } };
    }
    return undefined;
  };
  return { api, seen };
}

type KbVm = { state?: string; categories?: Array<{ id: string; count: number }>; articles?: Array<{ slug: string }>; category?: { id: string; count: number } };
const lastKbVm = (h: ReturnType<typeof boot>) => (h.lastCall('kbHtml')?.[0] ?? {}) as KbVm;

describe.each(['t1', 't2'] as const)('%s: a category past the first page', (renderer) => {
  it('is listed with the count of all its articles, and opens with all of them', async () => {
    const center = helpCenter();
    const h = boot({ renderer, api: center.api });
    await flush();
    h.runtime.setTab('help');
    await flush(30);
    const vm = lastKbVm(h);
    expect(vm.categories?.map((c) => [c.id, c.count])).toEqual([['cat-orders', 50], ['cat-ship', 30]]);
    const button = h.q('[data-kb-category="cat-ship"]');
    expect(button).not.toBeNull();
    expect(button!.textContent).toMatch(/30|۳۰/);

    click(button);
    await flush(30);
    expect(center.seen).toEqual([expect.objectContaining({ category_id: 'cat-ship', offset: '0', limit: '100' })]);
    const opened = lastKbVm(h);
    expect(opened.category).toMatchObject({ id: 'cat-ship', count: 30 });
    expect(opened.articles?.map((a) => a.slug)).toEqual(Array.from({ length: 30 }, (_, i) => `a${51 + i}`));
    expect(h.q('[data-kb-slug="a80"]')).not.toBeNull();

    // A category the first page already holds in full reads nothing more.
    click(h.q('[data-view-back="back"], [data-view-back]'));
    await flush(20);
    const orders = h.q('[data-kb-category="cat-orders"]');
    if (orders) {
      click(orders);
      await flush(20);
      expect(center.seen).toHaveLength(1);
      expect(lastKbVm(h).articles).toHaveLength(50);
    }
  });

  it('an older server (no counts): the counts of the list the widget has, nothing more read', async () => {
    const center = helpCenter({ counts: false });
    const h = boot({ renderer, api: center.api });
    await flush();
    h.runtime.setTab('help');
    await flush(30);
    expect(lastKbVm(h).categories?.map((c) => [c.id, c.count])).toEqual([['cat-orders', 50], ['cat-ship', 0]]);
    expect(center.seen).toEqual([]);
  });
});

describe('default: the list past its first 50', () => {
  const scrollList = (h: ReturnType<typeof boot>) => {
    const el = h.q('.wy-kb-scroll');
    expect(el).not.toBeNull();
    el!.dispatchEvent(new Event('scroll'));
  };

  it('reads the next page near the end of its scroller, until it holds every article', async () => {
    const center = helpCenter({ categories: [], articles: ALL.map((a) => ({ ...a, category_id: null })) });
    const h = boot({ renderer: 'default', api: center.api });
    await flush();
    h.runtime.setTab('help');
    await flush(30);
    expect(h.q('[data-kb-slug="a50"]')).not.toBeNull();
    expect(h.q('[data-kb-slug="a51"]')).toBeNull();
    expect(center.seen).toEqual([]);

    scrollList(h);
    await flush(30);
    expect(center.seen).toEqual([expect.objectContaining({ offset: '50', limit: '50' })]);
    expect(center.seen[0]).not.toHaveProperty('category_id');
    expect(h.q('[data-kb-slug="a80"]')).not.toBeNull();
    expect(h.shadow.querySelectorAll('[data-kb-slug]').length).toBe(80);

    // Everything is there: another scroll reads nothing.
    scrollList(h);
    await flush(20);
    expect(center.seen).toHaveLength(1);
  });

  it('an older server (no total) reads nothing more', async () => {
    const center = helpCenter({ categories: [], counts: false, articles: ALL.map((a) => ({ ...a, category_id: null })) });
    const h = boot({ renderer: 'default', api: center.api });
    await flush();
    h.runtime.setTab('help');
    await flush(30);
    scrollList(h);
    await flush(20);
    expect(center.seen).toEqual([]);
  });
});
