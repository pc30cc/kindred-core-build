// @vitest-environment node
/**
 * The KB article's author (migration 276 `author_user_id`, issue #340 g5-2a)
 * on the dashboard's write API (server/routes/knowledgeBase.ts), against a
 * database built by the whole chain and the real data layer:
 *
 *   - create: no author given → its creator, while they are a member (a
 *     platform admin working in the workspace is not named); null → none; a
 *     member's id → that member; anyone else → 400 invalid_author;
 *   - update: no author given → unchanged; null clears it; the same member
 *     rule;
 *   - the editor's list carries `author_user_id`;
 *   - before migration 276 (no column) create and update still work, without
 *     the author;
 *   - the AI's article writers (the generated-draft transaction, a learned
 *     answer turned into an article) name no author.
 *
 * Only authentication, the article quota and the publish permission are
 * stubbed. Driven by TEST_DATABASE_URL; skipped without it.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import express from 'express';
import request from 'supertest';
import { createFullChainDatabase, type FullChainDatabase } from './fullChainDatabase';

const DSN = process.env.TEST_DATABASE_URL;
const suite = DSN ? describe : describe.skip;

const who = vi.hoisted(() => ({ userId: '' }));
vi.mock('../../../server/lib/workspaceAuth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/lib/workspaceAuth.js')>()),
  authorizeWorkspaceAccess: async () => ({ userId: who.userId, isAdmin: true, role: 'owner' }),
}));
vi.mock('../../../server/services/billing/kbArticleQuota.js', () => ({
  resolveKbArticleQuota: async () => ({ allowed: true }),
  isKbQuotaDenied: () => false,
}));

type Row = Record<string, unknown>;

suite('KB article author: the write API', () => {
  let chain: FullChainDatabase;
  let app: express.Express;
  let ws = '';
  let owner = '';
  let agent = '';
  let stranger = '';
  let admin = '';
  const q = async (sql: string, p: unknown[] = []) => (await chain.db.query(sql, p)).rows as Row[];
  const authorOf = async (id: string) => (await q(`SELECT author_user_id FROM public.knowledge_base_articles WHERE id = $1`, [id]))[0]?.author_user_id ?? null;
  let n = 0;
  const create = (extra: Row = {}) => request(app).post('/api/knowledge-base/articles').query({ workspaceId: ws })
    .send({ workspaceId: ws, article: { title: `Article ${++n}`, slug: `article-${n}`, locale: 'fa', ...extra } });
  const patch = (id: string, extra: Row) => request(app).patch(`/api/knowledge-base/articles/${id}`).query({ workspaceId: ws })
    .send({ workspaceId: ws, article: extra });

  beforeAll(async () => {
    chain = await createFullChainDatabase(DSN!, `kb_author_${Date.now()}`);
    Object.assign(process.env, {
      DATABASE_URL: chain.url,
      PLATFORM_SIGNING_SECRET: 'signing-secret-for-this-test-only-0123456789',
      SUPABASE_URL: 'https://legacy-project.supabase.co',
      SUPABASE_ANON_KEY: 'legacy-anon-key-value',
      SUPABASE_SERVICE_ROLE_KEY: 'legacy-service-role-key-value-at-least-32',
      APP_BASE_URL: 'http://127.0.0.1:5173',
    });
    delete process.env.DATABASE_MODE;
    [owner, agent, stranger, admin] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    for (const [id, name] of [[owner, 'Owner'], [agent, 'سارا'], [stranger, 'Stranger'], [admin, 'Platform admin']]) {
      await q(`INSERT INTO public.profiles (id, email, full_name) VALUES ($1, $2, $3)`, [id, `${id.slice(0, 8)}@test.local`, name]);
    }
    ws = randomUUID();
    await q(`INSERT INTO public.workspaces (id, name, slug, owner_id) VALUES ($1, 'Acme', $2, $3)`, [ws, `acme-${ws.slice(0, 8)}`, owner]);
    await q(`INSERT INTO public.workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'agent')
             ON CONFLICT DO NOTHING`, [ws, owner, agent]);
    who.userId = owner;

    const { loadConfig } = await import('../../../server/config.js');
    const config = loadConfig();
    const { knowledgeBaseRouter } = await import('../../../server/routes/knowledgeBase.js');
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => { (req as unknown as { serverConfig: unknown }).serverConfig = config; next(); });
    app.use('/api/knowledge-base', knowledgeBaseRouter);
  }, 600_000);

  afterAll(async () => {
    const { closeDataLayer } = await import('../../../server/db/index.js');
    await closeDataLayer().catch(() => undefined);
    await chain?.drop();
  });

  it('create without an author: its creator', async () => {
    const res = await create();
    expect(res.status).toBe(201);
    expect(res.body.article.author_user_id).toBe(owner);
    expect(await authorOf(res.body.article.id)).toBe(owner);
  });

  it('create with null: no author; with a member: that member (any spelling of the id)', async () => {
    const none = await create({ author_user_id: null });
    expect(none.status).toBe(201);
    expect(await authorOf(none.body.article.id)).toBeNull();
    const member = await create({ author_user_id: agent.toUpperCase() });
    expect(member.status).toBe(201);
    expect(await authorOf(member.body.article.id)).toBe(agent);
  });

  it('create naming someone who is not a member: 400 invalid_author, nothing written', async () => {
    const before = (await q(`SELECT count(*)::int AS c FROM public.knowledge_base_articles WHERE workspace_id = $1`, [ws]))[0].c;
    for (const id of [stranger, randomUUID()]) {
      const res = await create({ author_user_id: id });
      expect([res.status, res.body.error]).toEqual([400, 'invalid_author']);
    }
    expect((await create({ author_user_id: 'not-a-uuid' })).body.error).toBe('invalid_article');
    expect((await q(`SELECT count(*)::int AS c FROM public.knowledge_base_articles WHERE workspace_id = $1`, [ws]))[0].c).toBe(before);
  });

  it('a creator who is no member (a platform admin): no author', async () => {
    who.userId = admin;
    try {
      const res = await create();
      expect(res.status).toBe(201);
      expect(await authorOf(res.body.article.id)).toBeNull();
    } finally {
      who.userId = owner;
    }
  });

  it('update: absent keeps it, null clears it, a member sets it, anyone else is 400', async () => {
    const id = String((await create()).body.article.id);
    expect((await patch(id, { title: 'Renamed' })).status).toBe(200);
    expect(await authorOf(id)).toBe(owner);
    expect((await patch(id, { author_user_id: agent })).body.article.author_user_id).toBe(agent);
    const bad = await patch(id, { author_user_id: stranger, title: 'Not saved' });
    expect([bad.status, bad.body.error]).toEqual([400, 'invalid_author']);
    expect((await q(`SELECT title FROM public.knowledge_base_articles WHERE id = $1`, [id]))[0].title).toBe('Renamed');
    expect((await patch(id, { author_user_id: null })).status).toBe(200);
    expect(await authorOf(id)).toBeNull();
  });

  it('the editor\'s list carries author_user_id', async () => {
    const list = await request(app).get('/api/knowledge-base/articles').query({ workspaceId: ws });
    expect(list.status).toBe(200);
    expect((list.body.articles as Row[]).every((a) => 'author_user_id' in a)).toBe(true);
  });

  it('a profile that goes leaves the article without an author', async () => {
    const temp = randomUUID();
    await q(`INSERT INTO public.profiles (id, email, full_name) VALUES ($1, $2, 'Temp')`, [temp, `${temp.slice(0, 8)}@test.local`]);
    await q(`INSERT INTO public.workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'agent')`, [ws, temp]);
    const id = String((await create({ author_user_id: temp })).body.article.id);
    expect(await authorOf(id)).toBe(temp);
    await q(`DELETE FROM public.workspace_members WHERE user_id = $1`, [temp]);
    await q(`DELETE FROM public.profiles WHERE id = $1`, [temp]);
    expect(await authorOf(id)).toBeNull();
  });

  it('before migration 276 (no column): create and update work, without the author', async () => {
    await q(`ALTER TABLE public.knowledge_base_articles RENAME COLUMN author_user_id TO author_user_id_hidden`);
    try {
      const res = await create({ author_user_id: agent });
      expect(res.status).toBe(201);
      expect(res.body.article).not.toHaveProperty('author_user_id');
      const id = String(res.body.article.id);
      expect((await create()).status).toBe(201);
      const up = await patch(id, { title: 'Still saved', author_user_id: null });
      expect(up.status).toBe(200);
      expect(up.body.article.title).toBe('Still saved');
    } finally {
      await q(`ALTER TABLE public.knowledge_base_articles RENAME COLUMN author_user_id_hidden TO author_user_id`);
    }
  });

  it('the AI\'s article writers name no author', async () => {
    const root = resolve(process.cwd());
    const sources = [
      readFileSync(resolve(root, 'server/routes/aiKb.ts'), 'utf8'),
      readFileSync(resolve(root, 'server/routes/ai-agent/knowledge.ts'), 'utf8'),
      ...readdirSync(resolve(root, 'server/services/ai-kb')).filter((f) => f.endsWith('.ts'))
        .map((f) => readFileSync(resolve(root, 'server/services/ai-kb', f), 'utf8')),
    ];
    for (const src of sources) expect(src).not.toContain('author_user_id');
    // The generated-draft transaction (SQL) inserts without it: the column default, NULL.
    const fns = await q(`SELECT proname, prosrc FROM pg_proc WHERE proname IN ('_ai_kb_apply_generated', 'accept_ai_kb_generated_article', 'publish_ai_kb_generated_article')`);
    expect(fns.length).toBeGreaterThan(0);
    for (const fn of fns) expect(String(fn.prosrc)).not.toContain('author_user_id');
  });
});
