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
