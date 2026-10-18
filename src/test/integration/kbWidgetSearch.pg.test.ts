// @vitest-environment node
/**
 * The widget's search as you type, word by word (`match=words`, sent by
 * runtime-ext.js for a renderer declaring `kbSearch`;
 * server/services/knowledge-base/widgetSearch.ts), against a database built
 * by the whole chain and the real data layer (postgres-only: the in-repo
 * PostgREST engine parses the `or=(...)` filter):
 *
 *   - a comma or a parenthesis in the query no longer makes the filter
 *     unparsable (as one phrase the route answers no results at all);
 *   - words that are not next to each other in a title still find it, and
 *     the article with more of the words comes first;
 *   - the help center (its search page, and the route without
 *     `match=words`) keeps its one-phrase search, as before;
 *   - each word-by-word result also carries its snippet and matched words;
 *     without `match=words` the rows are exactly what they always were;
 *   - instant answers (GET /api/widget/kb-suggest, widgetSuggest.ts): the
 *     same data layer parses their title/summary filter whatever the draft
 *     holds; only published, widget-visible articles; reading time from the
 *     article's text;
 *   - the article view's `meta=1` (the author byline): `author_name` from the
 *     author's profile while they are a member, never their id; without
 *     `meta=1` the answer is exactly today's; before migration 276 (no
 *     column) the article answers without a byline, never a 404;
 *   - the article vote's middle face: with migration 275 the database takes
 *     'neutral'; without it the CHECK refuses the row with SQLSTATE 23514,
 *     which the feedback route (server/routes/widget.ts) answers as 400
 *     invalid_rating rather than a server error.
 *
 * Driven by TEST_DATABASE_URL; skipped without it.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { createFullChainDatabase, type FullChainDatabase } from './fullChainDatabase';

const DSN = process.env.TEST_DATABASE_URL;
const suite = DSN ? describe : describe.skip;

const who = vi.hoisted(() => ({ workspaceId: '' }));
vi.mock('../../../server/services/widget/public.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/services/widget/public.js')>()),
  resolveWorkspaceIdFromOrigin: async () => who.workspaceId,
}));

type Row = Record<string, unknown>;

suite('help search: word by word, whatever the visitor typed', () => {
  let chain: FullChainDatabase;
  let app: express.Express;
  let config: never;
  let ws = '';
  let articleId = '';
  let author = '';
  let outsider = '';
  const q = async (sql: string, p: unknown[] = []) => (await chain.db.query(sql, p)).rows as Row[];
  const slugs = (rows: Row[] | undefined) => (rows ?? []).map((r) => String(r.slug));

  beforeAll(async () => {
    chain = await createFullChainDatabase(DSN!, `kb_search_${Date.now()}`);
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
    who.workspaceId = ws;
    await q(`INSERT INTO public.workspaces (id, name, slug, owner_id) VALUES ($1, 'Niloufar', $2, $3)`, [ws, `nil-${ws.slice(0, 8)}`, owner]);
    author = randomUUID();
    await q(`INSERT INTO public.profiles (id, email, full_name) VALUES ($1, $2, 'سارا  رضایی')`, [author, `sara-${author.slice(0, 6)}@test.local`]);
    outsider = randomUUID();
    await q(`INSERT INTO public.profiles (id, email, full_name) VALUES ($1, $2, 'Outsider')`, [outsider, `out-${outsider.slice(0, 6)}@test.local`]);
    await q(`INSERT INTO public.workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'agent')`, [ws, author]);
    const articles: Array<[string, string, string, string, string]> = [
      // slug, title, excerpt, content, updated_at
      ['track', 'زمان ارسال و پیگیری سفارش', 'کد رهگیری را پیامک می‌کنیم', 'متن', '2026-10-01T00:00:00Z'],
      ['shipping', 'زمان و هزینه ارسال', 'برای خریدهای بالای ۲ میلیون رایگان', 'متن', '2026-10-02T00:00:00Z'],
      ['returns', 'شرایط مرجوعی', 'تا ۷ روز', 'سفارش را برگردانید', '2026-10-03T00:00:00Z'],
      ['size', 'راهنمای سایز', 'جدول سایز', 'متن', '2026-10-04T00:00:00Z'],
    ];
    for (const [slug, title, excerpt, content, at] of articles) {
      const id = randomUUID();
      if (!articleId) articleId = id;
      await q(`INSERT INTO public.knowledge_base_articles (id, workspace_id, slug, locale, title, content, excerpt, status, created_at, updated_at)
               VALUES ($1, $2, $3, 'fa', $4, $5, $6, 'published', $7, $7)`,
        [id, ws, slug, title, content, excerpt, at]);
    }

    const { loadConfig } = await import('../../../server/config.js');
    config = loadConfig() as never;
    const { widgetKbRouter, publicKbRouter } = await import('../../../server/routes/kb.js');
    app = express();
    app.use((req, _res, next) => { (req as unknown as { serverConfig: unknown }).serverConfig = config; next(); });
    app.use('/api/widget/kb', widgetKbRouter);
    // The instant answers' handler (its token, origin and rate limits are
    // widget.ts's, covered by src/test/widget/kbSuggest.test.ts).
    const { handleKbSuggest } = await import('../../../server/routes/widgetKbSuggest.js');
    app.get('/api/widget/kb-suggest', handleKbSuggest);
    app.use('/', publicKbRouter);
  }, 600_000);

  afterAll(async () => {
    const { closeDataLayer } = await import('../../../server/db/index.js');
    await closeDataLayer().catch(() => undefined);
    await chain?.drop();
  });

  // `match=words`: what runtime-ext.js sends for a renderer declaring `kbSearch`.
  const search = (text: string) => request(app).get('/api/widget/kb/search').query({ workspace_id: ws, q: text, match: 'words' });

  it('a comma no longer empties the answer', async () => {
    const res = await search('سلام, سفارش');
    expect(res.status).toBe(200);
    expect(slugs(res.body.results).sort()).toEqual(['returns', 'track']);
  });

  it('parentheses are searched as text, not as filter syntax', async () => {
    const res = await search('سایز (جدید)');
    expect(res.status).toBe(200);
    expect(slugs(res.body.results)).toEqual(['size']);
  });

  it('words apart in a title still find it, and more words in the title rank first', async () => {
    const res = await search('ارسال سفارش');
    expect(slugs(res.body.results)).toEqual(['track', 'shipping', 'returns']);
  });

  it('the help center keeps its phrase search: its page, and the route without match=words', async () => {
    const page = await request(app).get('/help/fa/search').query({ q: 'زمان ارسال' });
    expect(page.status).toBe(200);
    expect(page.text).toContain('/help/fa/a/track');
    expect(page.text).not.toContain('/help/fa/a/shipping');
    const api = await request(app).get('/api/widget/kb/search').query({ workspace_id: ws, q: 'ارسال سفارش' });
    expect(api.status).toBe(200);
    expect(slugs(api.body.results)).toEqual([]);
  });

  it('match=words results carry their snippet and the words they matched; the phrase search\'s rows are as they were', async () => {
    const res = await search('پیگیری سفارش');
    expect(res.body.results[0]).toMatchObject({ slug: 'track', snippet: 'کد رهگیری را پیامک می‌کنیم', matches: ['پیگیری', 'سفارش'] });
    const phrase = await request(app).get('/api/widget/kb/search').query({ workspace_id: ws, q: 'زمان' });
    for (const row of phrase.body.results) expect(Object.keys(row).sort()).toEqual(['excerpt', 'id', 'locale', 'slug', 'title']);
  });

  describe('instant answers (kb-suggest)', () => {
    const suggest = (text: string, extra: Record<string, string> = {}) =>
      request(app).get('/api/widget/kb-suggest').query({ workspace_id: ws, q: text, locale: 'fa', ...extra });

    beforeAll(async () => {
      const rows: Array<[string, string, string, string, boolean]> = [
        // slug, title, excerpt, status, visible_in_widget
        ['warranty', 'گارانتی کالا', 'شرایط گارانتی و تعمیر', 'published', true],
        ['warranty-hidden', 'گارانتی کالا (داخلی)', 'فقط برای تیم', 'published', false],
        ['warranty-draft', 'گارانتی کالا (پیش‌نویس)', '', 'draft', true],
        ['returns-tr', 'İade politikası', 'Ürün iadesi 14 gün içinde', 'published', true],
      ];
      for (const [slug, title, excerpt, status, visible] of rows) {
        await q(`INSERT INTO public.knowledge_base_articles (id, workspace_id, slug, locale, title, content, excerpt, status, visible_in_widget)
                 VALUES ($1, $2, $3, 'fa', $4, $5, $6, $7, $8)`,
          [randomUUID(), ws, slug, title, `<p>${'کلمه '.repeat(650)}</p>`, excerpt, status, visible]);
      }
      const { __resetKbSuggestCachesForTests } = await import('../../../server/services/knowledge-base/widgetSuggest.js');
      __resetKbSuggestCachesForTests();
    });

    it('only published articles shown in the widget, with matches, snippet and reading time', async () => {
      const res = await suggest('سلام، گارانتی کالا چطوره؟');
      expect(res.status).toBe(200);
      expect(res.body.results).toEqual([{
        slug: 'warranty', title: 'گارانتی کالا', snippet: 'شرایط گارانتی و تعمیر', matches: ['گارانتی', 'کالا'], readingMinutes: 3,
      }]);
    });

    it('title and summary only: a word only in an article\'s text finds nothing', async () => {
      expect((await suggest('برگردانید')).body.results).toEqual([]);
      // «سفارش» is in a title (track) and in the returns article's text only.
      expect((await suggest('سفارش')).body.results.map((r: Row) => r.slug)).toEqual(['track']);
    });

    it('whatever the draft holds, the filter parses and nothing outside the workspace is read', async () => {
      for (const text of ['گارانتی, (کالا)', 'گارانتی%_*\\', 'گارانتی "x" {y}', 'title.eq.گارانتی', 'گارانتی:کالا', 'گارانتی) OR (1=1', 'گارانتی\u0000کالا']) {
        const res = await suggest(text);
        expect(res.status, text).toBe(200);
        expect(res.body.results.map((r: Row) => r.slug), text).toEqual(['warranty']);
      }
    });

    it('a Turkish capital «İ» finds its title (folded as ILIKE folds it), and «İstiyorum» is filler', async () => {
      const res = await suggest('İade İstiyorum', { locale: 'tr' });
      expect(res.body.results.map((r: Row) => [r.slug, r.matches])).toEqual([['returns-tr', ['iade']]]);
    });

    it('a draft of greetings reads nothing, and finds nothing', async () => {
      expect((await suggest('سلام وقت بخیر')).body).toEqual({ results: [] });
    });
  });

  describe('the article view\'s author (meta=1)', () => {
    const article = (slug: string, meta?: string) =>
      request(app).get('/api/widget/kb/article').query({ workspace_id: ws, slug, ...(meta ? { meta } : {}) });

    it('without meta=1: exactly today\'s answer, even with an author set', async () => {
      await q(`UPDATE public.knowledge_base_articles SET author_user_id = $2 WHERE workspace_id = $1 AND slug = 'track'`, [ws, author]);
      const res = await article('track');
      expect(res.status).toBe(200);
      expect(Object.keys(res.body.article).sort()).toEqual(['category_id', 'content', 'excerpt', 'id', 'locale', 'slug', 'title', 'updated_at']);
      expect(JSON.stringify(res.body)).not.toContain(author);
    });

    it('meta=1: the author\'s name, never their id; none set or not a member: null', async () => {
      const res = await article('track', '1');
      expect(res.body.article.author_name).toBe('سارا رضایی');
      expect(res.body.article).not.toHaveProperty('author_user_id');
      expect(JSON.stringify(res.body)).not.toContain(author);
      expect((await article('shipping', '1')).body.article.author_name).toBeNull();
      await q(`UPDATE public.knowledge_base_articles SET author_user_id = $2 WHERE workspace_id = $1 AND slug = 'shipping'`, [ws, outsider]);
      expect((await article('shipping', '1')).body.article.author_name).toBeNull();
      // Any other value of meta is today's answer.
      expect((await article('track', 'yes')).body.article).not.toHaveProperty('author_name');
      expect((await article('nope', '1')).status).toBe(404);
    });

    it('before migration 276 (no author column): the article without a byline, never a 404', async () => {
      await q(`ALTER TABLE public.knowledge_base_articles RENAME COLUMN author_user_id TO author_user_id_hidden`);
      try {
        const res = await article('track', '1');
        expect(res.status).toBe(200);
        expect(res.body.article).toMatchObject({ slug: 'track', author_name: null });
      } finally {
        await q(`ALTER TABLE public.knowledge_base_articles RENAME COLUMN author_user_id_hidden TO author_user_id`);
      }
    });
  });

  it('the vote\'s neutral face: stored with migration 275, refused with SQLSTATE 23514 without it', async () => {
    const { getServiceClient } = await import('../../../server/supabase.js');
    const sb = getServiceClient(config);
    const vote = { workspace_id: ws, article_id: articleId, rating: 'neutral' };
    const widened = await q(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'kb_article_feedback_rating_chk'`);
    if (String(widened[0]?.def || '').includes('neutral')) {
      expect((await sb.from('kb_article_feedback').insert(vote)).error).toBeNull();
    }
    // The database as it is before 275.
    await q(`ALTER TABLE public.kb_article_feedback DROP CONSTRAINT IF EXISTS kb_article_feedback_rating_chk`);
    await q(`DELETE FROM public.kb_article_feedback WHERE rating NOT IN ('up', 'down')`);
    await q(`ALTER TABLE public.kb_article_feedback ADD CONSTRAINT kb_article_feedback_rating_chk CHECK (rating IN ('up','down'))`);
    const { error } = await sb.from('kb_article_feedback').insert(vote);
    expect(error?.code).toBe('23514');
  });
});
