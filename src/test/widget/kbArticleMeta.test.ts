// @vitest-environment node
/**
 * GET /api/widget/kb/article and the author byline (`meta=1`, issue #340
 * g5-2a), against a recording fake of the data layer:
 *
 *   - without meta=1 (default/intl, the help center, every older widget):
 *     the same columns are read and the same body answered as before;
 *   - meta=1: one more column, `author_name` from the author's profile while
 *     they are a member, never their id;
 *   - before migration 276 (42703 on that column): read again without it,
 *     200 with `author_name: null`, never a 404.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const AUTHOR = '3f1c2b9a-0000-4000-8000-00000000aaaa';
const WS = '7b0e9d8c-1f2a-4b3c-9d4e-5f6a7b8c9d0e';
const h = vi.hoisted(() => ({
  selects: [] as Array<{ table: string; columns: string }>,
  missingColumn: false,
  member: true,
  article: null as Record<string, unknown> | null,
}));

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    from: (table: string) => {
      let columns = '';
      const b: Record<string, unknown> = {};
      const self = () => b;
      Object.assign(b, {
        select: (c: string) => { columns = c; h.selects.push({ table, columns: c }); return b; },
        eq: self, order: self, in: self, is: self, or: self, limit: self,
        maybeSingle: async () => {
          if (table === 'workspace_members') return { data: h.member ? { user_id: AUTHOR } : null, error: null };
          if (table === 'profiles') return { data: { full_name: ' Sara   Rezaei ' }, error: null };
          return { data: null, error: null };
        },
        then: (resolve: (r: unknown) => unknown) => {
          if (h.missingColumn && columns.includes('author_user_id')) {
            return Promise.resolve({ data: null, error: { code: '42703', message: 'column "author_user_id" does not exist' } }).then(resolve);
          }
          const row = h.article ? Object.fromEntries(Object.entries(h.article).filter(([k]) => columns.split(', ').includes(k))) : null;
          return Promise.resolve({ data: row ? [row] : [], error: null }).then(resolve);
        },
      });
      return b;
    },
  }),
}));
vi.mock('../../../server/services/knowledge-base/locks.js', () => ({
  resolveKbLock: async () => ({ active: false }),
  applyKbUnlockedFilter: (q: unknown) => q,
}));

const { widgetKbRouter } = await import('../../../server/routes/kb.js');
const app = express();
app.use((req, _res, next) => { (req as unknown as Record<string, unknown>).serverConfig = {}; next(); });
app.use('/api/widget/kb', widgetKbRouter);

const TODAY_COLUMNS = 'id, title, slug, excerpt, content, locale, updated_at, category_id';
const ROW = {
  id: 'a1', title: 'Returns', slug: 'returns', excerpt: 'x', content: '<p>y</p>', locale: 'en',
  updated_at: '2026-10-10T00:00:00Z', category_id: null, author_user_id: AUTHOR,
};
const get = (query: Record<string, string>) => request(app).get('/api/widget/kb/article').query({ workspace_id: WS, slug: 'returns', ...query });

beforeEach(() => {
  h.selects = [];
  h.missingColumn = false;
  h.member = true;
  h.article = { ...ROW };
});

describe('GET /api/widget/kb/article', () => {
  it('without meta=1: today\'s columns, today\'s body', async () => {
    const res = await get({});
    expect(res.status).toBe(200);
    expect(h.selects).toEqual([{ table: 'knowledge_base_articles', columns: TODAY_COLUMNS }]);
    const { author_user_id: _a, ...today } = ROW;
    expect(res.body).toEqual({ article: today });
    // Any other value of meta is today's request too.
    h.selects = [];
    await get({ meta: 'true' });
    expect(h.selects).toEqual([{ table: 'knowledge_base_articles', columns: TODAY_COLUMNS }]);
  });

  it('meta=1: author_name, never the id', async () => {
    const res = await get({ meta: '1' });
    expect(res.status).toBe(200);
    expect(h.selects[0]).toEqual({ table: 'knowledge_base_articles', columns: `${TODAY_COLUMNS}, author_user_id` });
    expect(res.body.article.author_name).toBe('Sara Rezaei');
    expect(res.body.article).not.toHaveProperty('author_user_id');
    expect(JSON.stringify(res.body)).not.toContain(AUTHOR);
  });

  it('meta=1: an author who is no longer a member, or none, is null', async () => {
    h.member = false;
    expect((await get({ meta: '1' })).body.article.author_name).toBeNull();
    h.member = true;
    h.article = { ...ROW, author_user_id: null };
    expect((await get({ meta: '1' })).body.article.author_name).toBeNull();
  });

  it('meta=1 before migration 276: today\'s columns again, 200 without a byline', async () => {
    h.missingColumn = true;
    const res = await get({ meta: '1' });
    expect(res.status).toBe(200);
    expect(h.selects.map((s) => s.columns)).toEqual([`${TODAY_COLUMNS}, author_user_id`, TODAY_COLUMNS]);
    expect(res.body.article).toMatchObject({ slug: 'returns', author_name: null });
  });

  it('an unknown slug is 404 with or without meta', async () => {
    h.article = null;
    expect((await get({})).status).toBe(404);
    expect((await get({ meta: '1' })).status).toBe(404);
  });
});
