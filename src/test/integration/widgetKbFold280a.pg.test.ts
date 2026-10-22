// @vitest-environment node
/**
 * The widget's help center on a larger knowledge base and with whatever
 * keyboard the visitor types on, against a database built by the whole chain
 * (280a included) and the real data layer (postgres-only: the in-repo
 * PostgREST engine runs public.kb_search_folded with its select, filters
 * and limit):
 *
 *   V-30 (280a, foldedSearch.ts, widgetSuggest.ts kbFold)
 *     F1  the database's fold (public.kb_search_fold) is the server's
 *         (kbFold), on one fixture set: Arabic yeh/kaf, «ۀ» and the hamza
 *         above, Persian and Arabic-Indic digits, ZWNJ, tatweel, harakat;
 *     F2  the widget's search, word by word and as one phrase, finds
 *         «پیگیری سفارش» typed «پيگيري سفارش», «کد تخفیف» typed «كد تخفيف»,
 *         «می‌خواهم» typed «میخواهم», «1405» typed «۱۴۰۵», and the other way
 *         round (an article written with Arabic letters);
 *     F3  instant answers find them too and mark the words as written in
 *         the title; an article hidden from the widget stays out;
 *     F4  the help center's search page folds the same way;
 *     F5  a database without 280a (no kb_search_folded) answers with the
 *         plain ILIKE, as before, never an error;
 *   V-29 (kb.ts)
 *     C1  /categories lists the first 50 articles, every category with the
 *         count of ALL its published articles, and the total;
 *     C2  /articles pages one category's articles (or all of them) in the
 *         order of /categories, so the pages continue the first one exactly;
 *         drafts never count; bad parameters are 400.
 *
 * Driven by TEST_DATABASE_URL; skipped without it.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import express from 'express';
import request from 'supertest';
import { createFullChainDatabase, type FullChainDatabase } from './fullChainDatabase';
import { applyMigrationSql } from './pgMigrationChain';
import { kbFold } from '../../../server/services/knowledge-base/widgetSuggest';

const DSN = process.env.TEST_DATABASE_URL;
const suite = DSN ? describe : describe.skip;
const FILE_280A = resolve(process.cwd(), 'database/migrations/280a_widget_kb_search_fold.sql');

const who = vi.hoisted(() => ({ workspaceId: '' }));
vi.mock('../../../server/services/widget/public.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/services/widget/public.js')>()),
  resolveWorkspaceIdFromOrigin: async () => who.workspaceId,
}));

type Row = Record<string, unknown>;

suite('the widget help center: every article, whatever the keyboard (real PostgreSQL)', () => {
  let chain: FullChainDatabase;
  let app: express.Express;
  let ws = '';
  let big = '';
  const cat = { orders: '', shipping: '' };
  const q = async (sql: string, p: unknown[] = []) => (await chain.db.query(sql, p)).rows as Row[];
  const slugs = (rows: Row[] | undefined) => (rows ?? []).map((r) => String(r.slug));

  const article = async (workspace: string, slug: string, title: string, excerpt: string, content: string, extra: { category?: string | null; status?: string; visible?: boolean; sort?: number; at?: string } = {}) => {
    await q(`INSERT INTO public.knowledge_base_articles (id, workspace_id, slug, locale, title, content, excerpt, status, visible_in_widget, category_id, sort_order, created_at, updated_at)
             VALUES ($1, $2, $3, 'fa', $4, $5, $6, $7, $8, $9, $10, $11, $11)`,
      [randomUUID(), workspace, slug, title, content, excerpt, extra.status ?? 'published', extra.visible ?? true, extra.category ?? null, extra.sort ?? 0, extra.at ?? '2026-10-01T00:00:00Z']);
  };

  beforeAll(async () => {
    chain = await createFullChainDatabase(DSN!, `kb_fold280a_${Date.now()}`);
    Object.assign(process.env, {
      DATABASE_URL: chain.url,
      PLATFORM_SIGNING_SECRET: 'signing-secret-for-this-test-only-0123456789',
      SUPABASE_URL: 'https://legacy-project.supabase.co',
      SUPABASE_ANON_KEY: 'legacy-anon-key-value',
      SUPABASE_SERVICE_ROLE_KEY: 'legacy-service-role-key-value-at-least-32',
      APP_BASE_URL: 'http://127.0.0.1:5173',
    });
    delete process.env.DATABASE_MODE;
    const owner = randomUUID();
    await q(`INSERT INTO public.profiles (id, email, full_name) VALUES ($1, $2, 'Owner')`, [owner, `owner-${owner.slice(0, 6)}@test.local`]);
    ws = randomUUID();
    big = randomUUID();
    who.workspaceId = ws;
    await q(`INSERT INTO public.workspaces (id, name, slug, owner_id) VALUES ($1, 'Niloufar', $2, $4), ($3, 'Big', $5, $4)`,
      [ws, `nil-${ws.slice(0, 8)}`, big, owner, `big-${big.slice(0, 8)}`]);

    // The folding fixtures (V-30).
    await article(ws, 'track', 'پیگیری سفارش', 'کد رهگیری را پیامک می‌کنیم', '<p>وضعیت سفارش</p>', { at: '2026-10-05T00:00:00Z' });
    await article(ws, 'discount', 'کد تخفیف', 'استفاده از کوپن', '<p>متن</p>', { at: '2026-10-04T00:00:00Z' });
    await article(ws, 'want', 'می‌خواهم سفارشم را لغو کنم', 'لغو سفارش', '<p>متن</p>', { at: '2026-10-03T00:00:00Z' });
    await article(ws, 'year', 'تقویم فروش 1405', 'تخفیف‌های سال', '<p>متن</p>', { at: '2026-10-02T00:00:00Z' });
    // Written on an Arabic keyboard: found by Persian letters too.
    await article(ws, 'arabic-typed', 'شرايط مرجوعي كالا', 'ارسال كالا', '<p>متن</p>', { at: '2026-10-01T00:00:00Z' });
    await article(ws, 'hidden', 'کد تخفیف همکاران', 'داخلی', '<p>متن</p>', { visible: false, at: '2026-09-30T00:00:00Z' });

    // The larger help center (V-29): 80 published articles, «ارسال» holding
    // sort positions 51-80, and drafts that never count.
    for (const [key, name, sort] of [['orders', 'سفارش', 1], ['shipping', 'ارسال', 2]] as const) {
      const id = randomUUID();
      cat[key] = id;
      await q(`INSERT INTO public.knowledge_base_categories (id, workspace_id, name, slug, sort_order) VALUES ($1, $2, $3, $4, $5)`, [id, big, name, key, sort]);
    }
    for (let i = 1; i <= 80; i++) {
      await article(big, `a${String(i).padStart(2, '0')}`, `مقاله ${i}`, '', '<p>متن</p>', { category: i <= 50 ? cat.orders : cat.shipping, sort: i });
    }
    await article(big, 'draft-1', 'پیش‌نویس', '', '<p>متن</p>', { category: cat.shipping, status: 'draft', sort: 81 });

    const { loadConfig } = await import('../../../server/config.js');
    const config = loadConfig() as never;
    const { widgetKbRouter, publicKbRouter } = await import('../../../server/routes/kb.js');
    const { handleKbSuggest } = await import('../../../server/routes/widgetKbSuggest.js');
    app = express();
    app.use((req, _res, next) => { (req as unknown as { serverConfig: unknown }).serverConfig = config; next(); });
    app.use('/api/widget/kb', widgetKbRouter);
    app.get('/api/widget/kb-suggest', handleKbSuggest);
    app.use('/', publicKbRouter);
  }, 600_000);

  afterAll(async () => {
    const { closeDataLayer } = await import('../../../server/db/index.js');
    await closeDataLayer().catch(() => undefined);
    await chain?.drop();
  });

  const words = (text: string) => request(app).get('/api/widget/kb/search').query({ workspace_id: ws, q: text, match: 'words' });
  const phrase = (text: string) => request(app).get('/api/widget/kb/search').query({ workspace_id: ws, q: text });
  const suggest = async (text: string) => {
    const { __resetKbSuggestCachesForTests } = await import('../../../server/services/knowledge-base/widgetSuggest.js');
    __resetKbSuggestCachesForTests();
    return request(app).get('/api/widget/kb-suggest').query({ workspace_id: ws, q: text, locale: 'fa' });
  };
  const page = async (text: string) => {
    const res = await request(app).get('/help/fa/search').query({ q: text });
    expect(res.status).toBe(200);
    return ['track', 'discount', 'want', 'year', 'arabic-typed', 'hidden'].filter((slug) => res.text.includes(`/help/fa/a/${slug}"`));
  };

  describe('V-30: one fold on both sides', () => {
    it('F1 the database folds exactly as the server does', async () => {
      const fixtures = [
        'پيگيري سفارش', 'كد تخفيف', 'می‌خواهم', 'میخواهم', '۱۴۰۵', '١٤٠٥', 'خانۀ', 'خانهٔ', 'مـــرجوعی', 'سَلامٌ',
        'ى', 'ZWJ‍x', 'Shoes 42', 'مقالهٔ ۲ و ٣',
      ];
      for (const text of fixtures) {
        const [row] = await q('SELECT lower(public.kb_search_fold($1)) AS folded', [text]);
        expect(row.folded, text).toBe(kbFold(text));
      }
      expect(kbFold('پيگيري')).toBe(kbFold('پیگیری'));
      expect(kbFold('خانۀ')).toBe('خانه');
      expect(kbFold('خانهٔ')).toBe('خانه');
      expect(kbFold('۱۴۰۵')).toBe('1405');
    });

    it('F2 word by word and as one phrase, in either direction', async () => {
      expect(slugs((await words('پيگيري سفارش')).body.results)[0]).toBe('track');
      // Any of the words: the article with both comes first.
      expect(slugs((await words('كد تخفيف')).body.results)[0]).toBe('discount');
      expect(slugs((await words('میخواهم لغو')).body.results)[0]).toBe('want');
      expect(slugs((await words('تقویم ۱۴۰۵')).body.results)[0]).toBe('year');
      expect(slugs((await words('شرایط مرجوعی')).body.results)).toEqual(['arabic-typed']);
      // One phrase (the route without match=words).
      expect(slugs((await phrase('پيگيري سفارش')).body.results)).toEqual(['track']);
      // (The widget's search lists every published article, as it always
      // did; only instant answers keep to those shown in the widget.)
      expect(slugs((await phrase('كد تخفيف')).body.results)).toEqual(['discount', 'hidden']);
      expect(slugs((await phrase('میخواهم')).body.results)).toEqual(['want']);
      expect(slugs((await phrase('٢٠٢٦')).body.results)).toEqual([]);
      expect(slugs((await phrase('۱۴۰۵')).body.results)).toEqual(['year']);
      expect(slugs((await phrase('مرجوعی کالا')).body.results)).toEqual(['arabic-typed']);
    });

    it('F2 the words a result matched are the folded ones (the widget marks them)', async () => {
      const res = await words('پيگيري سفارش');
      expect(res.body.results[0]).toMatchObject({ slug: 'track' });
      expect(res.body.results[0].matches).toEqual(expect.arrayContaining(['پیگیری', 'سفارش']));
    });

    it('F3 instant answers: found, marked as written in the title; an article hidden from the widget stays out', async () => {
      const res = await suggest('كد تخفيف دارم');
      expect(res.status).toBe(200);
      expect(res.body.results.map((r: Row) => r.slug)).toEqual(['discount']);
      expect(res.body.results[0].matches).toEqual(expect.arrayContaining(['کد', 'تخفیف']));
      const back = await suggest('شرایط مرجوعی');
      expect(back.body.results.map((r: Row) => r.slug)).toEqual(['arabic-typed']);
      expect(back.body.results[0].matches).toEqual(expect.arrayContaining(['شرايط', 'مرجوعي']));
    });

    it('F4 the help center\'s search page folds the same way', async () => {
      expect(await page('پيگيري سفارش')).toEqual(['track']);
      expect(await page('كد تخفيف')).toEqual(['discount', 'hidden']);
      expect(await page('شرایط مرجوعی')).toEqual(['arabic-typed']);
    });

    it('F5 without 280a: the plain ILIKE, as before, never an error', async () => {
      await q('DROP FUNCTION public.kb_search_folded(uuid, text[], boolean, boolean)');
      try {
        // (The data layer's schema cache notices on the next call.)
        const typed = await words('پیگیری سفارش');
        expect(typed.status).toBe(200);
        expect(slugs(typed.body.results)[0]).toBe('track');
        // The visitor's words are still folded by the server, so an Arabic
        // keyboard finds a Persian title; an article written with Arabic
        // letters is found only as typed: the other half 280a brings.
        expect(slugs((await words('پيگيري')).body.results)).toEqual(['track']);
        expect(slugs((await words('شرایط مرجوعی')).body.results)).toEqual([]);
        expect(slugs((await words('شرايط')).body.results)).toEqual(['arabic-typed']);
        const one = await phrase('کد تخفیف');
        expect(one.status).toBe(200);
        expect(slugs(one.body.results).sort()).toEqual(['discount', 'hidden']);
        expect((await suggest('کد تخفیف')).body.results.map((r: Row) => r.slug)).toEqual(['discount']);
        expect(await page('پیگیری سفارش')).toEqual(['track']);
      } finally {
        await applyMigrationSql(chain.db, readFileSync(FILE_280A, 'utf8'));
      }
      // Back with 280a (the file is re-runnable).
      expect(slugs((await words('شرایط مرجوعی')).body.results)).toEqual(['arabic-typed']);
    });
  });

  describe('V-29: every category with its count, every article page by page', () => {
    const list = (params: Record<string, string | number>) => request(app).get('/api/widget/kb/articles').query({ workspace_id: big, ...params });

    it('C1 /categories: the first 50 articles, each category counted in full, and the total', async () => {
      const res = await request(app).get('/api/widget/kb/categories').query({ workspace_id: big });
      expect(res.status).toBe(200);
      expect(res.body.articles).toHaveLength(50);
      expect(res.body.article_total).toBe(80);
      const counts = Object.fromEntries((res.body.categories as Row[]).map((c) => [c.slug, c.article_count]));
      expect(counts).toEqual({ orders: 50, shipping: 30 });
      // The first page holds none of «ارسال»: its count is not the first page's.
      expect((res.body.articles as Row[]).filter((a) => a.category_id === cat.shipping)).toHaveLength(0);
    });

    it('C2 /articles: a category page by page, and the whole list continuing the first page exactly', async () => {
      const first = await list({ category_id: cat.shipping, limit: 20 });
      expect(first.status).toBe(200);
      expect(first.body.articles).toHaveLength(20);
      expect(first.body.next_offset).toBe(20);
      const second = await list({ category_id: cat.shipping, offset: 20, limit: 20 });
      expect(second.body.articles).toHaveLength(10);
      expect(second.body.next_offset).toBeNull();
      const shipping = [...first.body.articles, ...second.body.articles].map((a: Row) => a.slug);
      expect(shipping).toEqual(Array.from({ length: 30 }, (_, i) => `a${51 + i}`));
      expect(shipping).not.toContain('draft-1');

      const categories = await request(app).get('/api/widget/kb/categories').query({ workspace_id: big });
      const rest = await list({ offset: 50, limit: 50 });
      expect(rest.body.next_offset).toBeNull();
      const all = [...categories.body.articles, ...rest.body.articles].map((a: Row) => a.slug);
      expect(all).toEqual(Array.from({ length: 80 }, (_, i) => `a${String(i + 1).padStart(2, '0')}`));
      expect(Object.keys(rest.body.articles[0]).sort()).toEqual(['category_id', 'excerpt', 'id', 'locale', 'slug', 'sort_order', 'title']);
    });

    it('C2 parameters out of range are refused; another workspace\'s category lists nothing', async () => {
      expect((await list({ limit: 0 })).status).toBe(400);
      expect((await list({ limit: 101 })).status).toBe(400);
      expect((await list({ offset: -1 })).status).toBe(400);
      expect((await list({ category_id: 'nope' })).status).toBe(400);
      expect((await request(app).get('/api/widget/kb/articles').query({ workspace_id: 'nope' })).status).toBe(400);
      const foreign = await request(app).get('/api/widget/kb/articles').query({ workspace_id: ws, category_id: cat.shipping });
      expect(foreign.body).toEqual({ articles: [], next_offset: null });
    });
  });
});
