// @vitest-environment node
/**
 * Simple billing phase 4 (design §3) — Knowledge Base articles over the
 * plan's max_kb_articles, against a database built by the whole chain
 * (migration 265 included), through the real data layer (postgres-only) and
 * the real routes:
 *
 *   - kill switch off: every reader sees every published article, as today;
 *   - switch on: the help center (widget JSON + SSR + sitemap + search, whose
 *     query carries a second or() filter), Telegram and the AI (hybrid and
 *     legacy retrieval, workspace links, source health, internal QA seeds)
 *     never see a locked article; its page answers 404;
 *   - the operator list marks it `locked`, PATCH answers 403
 *     kb_article_locked, DELETE stays open and unlocks the next article at
 *     once;
 *   - the index retires a locked article's chunks (per source and on a full
 *     rebuild);
 *   - the AI KB builder refuses to overwrite a locked article (route 403,
 *     publish-all skips it, the SQL guard's error is recognised);
 *   - converting a learned answer into an article honours the quota.
 *
 * Only authentication, the AI KB plan gate and the host → workspace lookup are
 * stubbed. Driven by TEST_DATABASE_URL; skipped without it.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { createFullChainDatabase, type FullChainDatabase } from './fullChainDatabase';

const DSN = process.env.TEST_DATABASE_URL;
const suite = DSN ? describe : describe.skip;

const who = vi.hoisted(() => ({ userId: '', workspaceId: '' }));

vi.mock('../../../server/lib/workspaceAuth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/lib/workspaceAuth.js')>()),
  requireUser: async () => who.userId,
  authorizeWorkspaceAccess: async () => ({ userId: who.userId, isAdmin: true, role: 'owner' }),
}));
vi.mock('../../../server/middleware/adminBypass.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/middleware/adminBypass.js')>()),
  isGlobalAdmin: async () => true,
}));
vi.mock('../../../server/services/ai-kb/access.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/services/ai-kb/access.js')>()),
  checkAiKbAccess: async () => ({ ok: true }),
}));
vi.mock('../../../server/routes/ai-agent/shared.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/routes/ai-agent/shared.js')>()),
  authorizeMember: async () => ({ userId: who.userId, isAdmin: true, role: 'owner' }),
}));
vi.mock('../../../server/services/widget/public.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/services/widget/public.js')>()),
  resolveWorkspaceIdFromOrigin: async () => who.workspaceId,
}));

type Row = Record<string, unknown>;

suite('KB, help center and AI: articles over max_kb_articles (phase 4)', () => {
  let chain: FullChainDatabase;
  let config: never;
  let app: express.Express;
  let state: typeof import('../../../server/services/billing/locks/state.js');
  let kbLocks: typeof import('../../../server/services/knowledge-base/locks.js');
  const q = async (sql: string, p: unknown[] = []) => (await chain.db.query(sql, p)).rows as Row[];
  const one = async (sql: string, p: unknown[] = []) => (await q(sql, p))[0];

  let ws = '';
  let owner = '';
  // Oldest first: the plan keeps two, the newer two are locked.
  const art = { alpha: randomUUID(), beta: randomUUID(), gamma: randomUUID(), delta: randomUUID() };

  async function switchTo(on: boolean) {
    await q(`INSERT INTO public.billing_settings (edition, locks_enabled) VALUES ('international', $1)
             ON CONFLICT (edition) DO UPDATE SET locks_enabled = EXCLUDED.locks_enabled`, [on]);
    state.clearLockStateCache();
  }

  async function chunk(sourceId: string, slug: string) {
    await q(`INSERT INTO public.ai_knowledge_chunks (workspace_id, source_type, source_id, title, content, content_hash, status, source_url, locale)
             VALUES ($1, 'kb_article', $2, $3, 'refund policy details', $4, 'active', $5, 'en')`,
      [ws, sourceId, `${slug} refund guide`, randomUUID(), `/help/${slug}`]);
  }

  const chunkStatuses = async (sourceId: string) =>
    (await q(`SELECT DISTINCT status FROM public.ai_knowledge_chunks WHERE workspace_id = $1 AND source_id = $2`, [ws, sourceId]))
      .map((r) => String(r.status)).sort();

  beforeAll(async () => {
    chain = await createFullChainDatabase(DSN!, `kb_locks_${Date.now()}`);
    Object.assign(process.env, {
      DATABASE_URL: chain.url,
      PLATFORM_SIGNING_SECRET: 'signing-secret-for-this-test-only-0123456789',
      SUPABASE_URL: 'https://legacy-project.supabase.co',
      SUPABASE_ANON_KEY: 'legacy-anon-key-value',
      SUPABASE_SERVICE_ROLE_KEY: 'legacy-service-role-key-value-at-least-32',
      APP_BASE_URL: 'http://127.0.0.1:5173',
    });
    delete process.env.DATABASE_MODE;
    await q(`UPDATE public.platform_settings SET region_mode = 'multi'`);
    const small = String((await one(
      `INSERT INTO public.billing_plans (name, slug, prices, limits, entitlements, is_active, is_free, is_hidden, sort_order)
       VALUES ('Small', 'small-kb', $1, $2, '{}', true, false, false, 10) RETURNING id`,
      [JSON.stringify({ USD: { monthly: 900, yearly: 9000 } }), JSON.stringify({ max_kb_articles: 2 })])).id);

    owner = randomUUID();
    await q(`INSERT INTO public.profiles (id, email, full_name) VALUES ($1, $2, 'Owner')`, [owner, `owner-${owner.slice(0, 6)}@test.local`]);
    ws = randomUUID();
    who.userId = owner;
    who.workspaceId = ws;
    await q(`INSERT INTO public.workspaces (id, name, slug, owner_id) VALUES ($1, 'Acme', $2, $3)`, [ws, `acme-${ws.slice(0, 8)}`, owner]);
    await q(`INSERT INTO public.workspace_subscriptions (workspace_id, plan_id, status, billing_interval, provider_name, current_period_start, current_period_end)
             VALUES ($1, $2, 'active', 'monthly', 'account', now() - interval '10 days', now() + interval '20 days')
             ON CONFLICT (workspace_id) DO UPDATE SET plan_id = EXCLUDED.plan_id, status = 'active'`, [ws, small]);
    const rows: Array<[string, string, string]> = [
      [art.alpha, 'alpha', '2026-01-01T00:00:00Z'],
      [art.beta, 'beta', '2026-01-02T00:00:00Z'],
      [art.gamma, 'gamma', '2026-01-03T00:00:00Z'],
      [art.delta, 'delta', '2026-01-04T00:00:00Z'],
    ];
    for (const [id, slug, at] of rows) {
      await q(`INSERT INTO public.knowledge_base_articles (id, workspace_id, slug, locale, title, content, excerpt, status, created_at)
               VALUES ($1, $2, $3, 'en', $4, 'Our refund policy, step by step.', 'refund help', 'published', $5)`,
        [id, ws, slug, `${slug} refund guide`, at]);
    }

    const { loadConfig } = await import('../../../server/config.js');
    config = loadConfig() as never;
    state = await import('../../../server/services/billing/locks/state.js');
    kbLocks = await import('../../../server/services/knowledge-base/locks.js');
    const { knowledgeBaseRouter } = await import('../../../server/routes/knowledgeBase.js');
    const { widgetKbRouter, publicKbRouter } = await import('../../../server/routes/kb.js');
    const { aiKbRouter } = await import('../../../server/routes/aiKb.js');
    const { knowledgeRouter } = await import('../../../server/routes/ai-agent/knowledge.js');
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => { (req as unknown as { serverConfig: unknown }).serverConfig = config; next(); });
    app.use('/api/knowledge-base', knowledgeBaseRouter);
    app.use('/api/widget/kb', widgetKbRouter);
    app.use('/api/ai-kb', aiKbRouter);
    app.use('/api/ai-agent', knowledgeRouter);
    app.use('/', publicKbRouter);
  }, 600_000);

  afterAll(async () => {
    const { closeDataLayer } = await import('../../../server/db/index.js');
    await closeDataLayer().catch(() => undefined);
    await chain?.drop();
  });

  const slugsOf = (rows: Row[] | undefined) => (rows ?? []).map((r) => String(r.slug)).sort();

  it('switch off: nothing is locked, every reader sees all four articles', async () => {
    await switchTo(false);
    const lock = await kbLocks.resolveKbLock(config, ws);
    expect(lock.active).toBe(false);
    const search = await request(app).get('/api/widget/kb/search').query({ workspace_id: ws, q: 'refund' });
    expect(slugsOf(search.body.results)).toEqual(['alpha', 'beta', 'delta', 'gamma']);
    expect((await request(app).get('/api/widget/kb/article').query({ workspace_id: ws, slug: 'gamma' })).status).toBe(200);
    const list = await request(app).get('/api/knowledge-base/articles').query({ workspaceId: ws });
    expect(list.status).toBe(200);
    expect((list.body.articles as Row[]).every((a) => a.locked === false)).toBe(true);
    const patch = await request(app).patch(`/api/knowledge-base/articles/${art.delta}`).query({ workspaceId: ws })
      .send({ workspaceId: ws, article: { excerpt: 'refund help' } });
    expect(patch.status).toBe(200);
  });

  it('switch on: the two newest articles are locked, exactly as billing_is_locked', async () => {
    await switchTo(true);
    const lock = await kbLocks.resolveKbLock(config, ws);
    expect(lock).toMatchObject({ active: true, limit: 2, locked: 2, complete: true });
    expect([...lock.ids].sort()).toEqual([art.gamma, art.delta].sort());
    for (const row of await q(`SELECT id, to_json(created_at)#>>'{}' AS created_at FROM public.knowledge_base_articles WHERE workspace_id = $1`, [ws])) {
      const sql = (await one(`SELECT public.billing_is_locked($1, 'kb_article', $2) AS l`, [ws, row.id])).l;
      expect(kbLocks.isKbArticleLocked(lock, row as never)).toBe(sql);
      expect(kbLocks.isKbArticleLocked(lock, { id: String(row.id) })).toBe(sql);
      expect(await kbLocks.isKbArticleIdLocked(config, ws, String(row.id))).toBe(sql);
    }
  });

  it('widget help: lists and search leave locked articles out, a locked article is not found', async () => {
    const cats = await request(app).get('/api/widget/kb/categories').query({ workspace_id: ws });
    expect(slugsOf(cats.body.articles)).toEqual(['alpha', 'beta']);
    // The search query already carries an or() (title/excerpt/content): both apply.
    const search = await request(app).get('/api/widget/kb/search').query({ workspace_id: ws, q: 'refund' });
    expect(search.status).toBe(200);
    expect(slugsOf(search.body.results)).toEqual(['alpha', 'beta']);
    const none = await request(app).get('/api/widget/kb/search').query({ workspace_id: ws, q: 'gamma' });
    expect(none.body.results).toEqual([]);
    expect((await request(app).get('/api/widget/kb/article').query({ workspace_id: ws, slug: 'gamma' })).status).toBe(404);
    expect((await request(app).get('/api/widget/kb/article').query({ workspace_id: ws, slug: 'alpha' })).status).toBe(200);
  });

  it('public help center (SSR): pages, search and sitemap leave locked articles out', async () => {
    expect((await request(app).get('/help/en/a/gamma')).status).toBe(404);
    expect((await request(app).get('/help/en/a/beta')).status).toBe(200);
    const index = await request(app).get('/help/en');
    expect(index.text).toContain('/help/en/a/alpha');
    expect(index.text).not.toContain('/help/en/a/gamma');
    const search = await request(app).get('/help/en/search').query({ q: 'refund' });
    expect(search.text).toContain('/help/en/a/beta');
    expect(search.text).not.toContain('/help/en/a/delta');
    const sitemap = await request(app).get('/help/sitemap.xml');
    expect(sitemap.text).toContain('/help/en/a/alpha');
    expect(sitemap.text).not.toContain('/help/en/a/gamma');
  });

  it('Telegram help articles leave locked articles out', async () => {
    const { listHelpArticles } = await import('../../../server/services/channels/telegram/menu.js');
    const list = await listHelpArticles(config, ws, 'en');
    expect(list.map((a) => a.slug).sort()).toEqual(['alpha', 'beta']);
  });

  it('operator list marks locked articles; PATCH of a locked one is 403 kb_article_locked', async () => {
    const list = await request(app).get('/api/knowledge-base/articles').query({ workspaceId: ws });
    const locked = Object.fromEntries((list.body.articles as Row[]).map((a) => [a.slug, a.locked]));
    expect(locked).toEqual({ alpha: false, beta: false, gamma: true, delta: true });
    const refused = await request(app).patch(`/api/knowledge-base/articles/${art.gamma}`).query({ workspaceId: ws })
      .send({ workspaceId: ws, article: { title: 'changed' } });
    expect(refused.status).toBe(403);
    expect(refused.body).toEqual({ error: 'kb_article_locked', upgrade_required: true });
    expect((await one(`SELECT title FROM public.knowledge_base_articles WHERE id = $1`, [art.gamma])).title).toBe('gamma refund guide');
    const allowed = await request(app).patch(`/api/knowledge-base/articles/${art.alpha}`).query({ workspaceId: ws })
      .send({ workspaceId: ws, article: { excerpt: 'refund help, updated' } });
    expect(allowed.status).toBe(200);
  });

  it('AI retrieval: hybrid (keyword phase and the parent re-check) and legacy never return a locked article', async () => {
    await chunk(art.gamma, 'gamma');
    await chunk(art.alpha, 'alpha');
    const { retrieveHybridSources } = await import('../../../server/services/ai-agent/retrievalHybrid.js');
    const r = await retrieveHybridSources(config, {
      workspaceId: ws,
      originalMessage: 'gamma refund guide',
      retrievalQuery: 'gamma refund guide',
      responseLanguage: 'en',
      limit: 10,
    });
    const ids = r.sources.filter((s) => s.source_type === 'kb_article').map((s) => s.source_id);
    expect(ids).toContain(art.alpha);
    expect(ids).not.toContain(art.gamma);
    expect(ids).not.toContain(art.delta);
    // The active chunk of the locked article reached the candidates and was dropped as locked.
    expect(r.excludedSummary?.locked_kb_excluded).toBeGreaterThanOrEqual(1);
    expect(r.excludedSummary?.draft_kb_excluded).toBe(0);

    const { retrieveSources } = await import('../../../server/services/ai-agent/retrieval.js');
    const legacy = await retrieveSources(config, ws, 'refund guide', 'en', 10);
    expect(legacy.map((s) => s.slug).sort()).toEqual(['alpha', 'beta']);
  });

  it('workspace links: a locked article\'s /help URL is never offered, even from an active chunk', async () => {
    const { loadWorkspaceContext } = await import('../../../server/services/ai-agent/workspaceContext.js');
    const ctx = await loadWorkspaceContext(config, ws);
    expect(ctx.knownPaths).toEqual(expect.arrayContaining(['/help/alpha', '/help/beta']));
    expect(ctx.knownPaths).not.toContain('/help/gamma');
    expect(ctx.knownPaths).not.toContain('/help/delta');
  });

  it('source health reports a locked article as kb_locked, not eligible', async () => {
    const { getSourceHealth } = await import('../../../server/services/ai-agent/sourceHealth.js');
    const health = await getSourceHealth(config, ws, { sourceType: 'kb_article' });
    const byId = Object.fromEntries(health.items.map((i) => [i.source_id, i]));
    expect(byId[art.gamma]).toMatchObject({ eligible: false, reason: 'kb_locked' });
    expect(byId[art.delta]?.reason).toBe('kb_locked');
    expect(byId[art.alpha]?.reason).not.toBe('kb_locked');
  });

  it('the index retires a locked article\'s chunks, per source and on a full rebuild', async () => {
    const { syncKnowledgeSource, rebuildWorkspaceIndex } = await import('../../../server/services/ai-agent/knowledgeIndex/sync.js');
    await syncKnowledgeSource(config, { workspaceId: ws, sourceType: 'kb_article', sourceId: art.gamma });
    expect(await chunkStatuses(art.gamma)).toEqual(['deleted']);
    await chunk(art.delta, 'delta');
    const summary = await rebuildWorkspaceIndex(config, ws);
    // Only the two active articles are indexed; the locked two are not eligible.
    expect(summary.sourcesProcessed).toBe(2);
    const hasVector = Boolean((await one(
      `SELECT 1 AS x FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ai_knowledge_chunks' AND column_name = 'embedding'`,
    ))?.x);
    if (hasVector) {
      // With pgvector the rebuild completes and its sweep retires the locked chunks.
      expect(summary.staleSourcesReconciled).toBeGreaterThanOrEqual(1);
      expect(await chunkStatuses(art.delta)).toEqual(['deleted']);
      expect(await chunkStatuses(art.alpha)).toContain('active');
    } else {
      // Without pgvector (no embedding column) the index cannot be read and the
      // destructive sweep is blocked, as designed; the per-source path above
      // already proved the retirement.
      expect(summary.reconciliationSkipped).toBe(true);
    }
  });

  it('AI KB builder: accept/publish of a draft linked to a locked article is 403; publish-all skips it', async () => {
    const job = String((await one(
      `INSERT INTO public.ai_kb_jobs (workspace_id, source_kind, source_domain) VALUES ($1, 'workspace_domain', 'acme.test') RETURNING id`, [ws])).id);
    const draft = async (articleId: string) => String((await one(
      `INSERT INTO public.ai_kb_generated_articles (workspace_id, job_id, title, slug, content_md, kb_article_id)
       VALUES ($1, $2, 'rewritten', $3, '<p>new</p>', $4) RETURNING id`, [ws, job, `d-${randomUUID().slice(0, 6)}`, articleId])).id);
    const onLocked = await draft(art.delta);
    for (const action of ['accept', 'publish']) {
      const res = await request(app).post(`/api/ai-kb/generated/${onLocked}/${action}`).send({});
      expect(res.status, action).toBe(403);
      expect(res.body).toEqual({ error: 'kb_article_locked', upgrade_required: true });
    }
    expect((await one(`SELECT title FROM public.knowledge_base_articles WHERE id = $1`, [art.delta])).title).toBe('delta refund guide');

    // The SQL guard (265) is the backstop: its error is recognised as the lock.
    const { getServiceClient } = await import('../../../server/supabase.js');
    const { error } = await getServiceClient(config).rpc('accept_ai_kb_generated_article', {
      _generated_id: onLocked, _workspace_id: ws, _reviewer: owner, _content: '<p>new</p>', _slug_seed: 'x',
    });
    expect(kbLocks.isKbArticleLockedError(error)).toBe(true);

    const onOpen = await draft(art.beta);
    const all = await request(app).post(`/api/ai-kb/jobs/${job}/publish-all`).send({});
    expect(all.status).toBe(200);
    expect(all.body.published).toEqual([{ generated_id: onOpen, kb_article_id: art.beta }]);
    expect(all.body.failed).toEqual([{ generated_id: onLocked, error: 'kb_article_locked' }]);
    expect(all.body).toMatchObject({ articles_locked: true, upgrade_required: true });
  });

  it('converting a learned answer into an article honours max_kb_articles', async () => {
    const cand = String((await one(
      `INSERT INTO public.ai_agent_learning_candidates (workspace_id, question_text, answer_text, normalized_question)
       VALUES ($1, 'How do refunds work?', 'Within 14 days.', 'how do refunds work') RETURNING id`, [ws])).id);
    const res = await request(app).post(`/api/ai-agent/learning-candidates/${cand}/convert-kb`).send({ title: 'Refunds', answer: 'Within 14 days.' });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ feature: 'max_kb_articles', upgrade_required: true });
    expect(Number((await one(`SELECT count(*)::int AS n FROM public.knowledge_base_articles WHERE workspace_id = $1`, [ws])).n)).toBe(4);
  });

  it('DELETE stays open and unlocks the next article at once', async () => {
    const del = await request(app).delete(`/api/knowledge-base/articles/${art.alpha}`).query({ workspaceId: ws });
    expect(del.status).toBe(200);
    const list = await request(app).get('/api/knowledge-base/articles').query({ workspaceId: ws });
    const locked = Object.fromEntries((list.body.articles as Row[]).map((a) => [a.slug, a.locked]));
    expect(locked).toEqual({ beta: false, gamma: false, delta: true });
    expect((await request(app).get('/api/widget/kb/article').query({ workspace_id: ws, slug: 'gamma' })).status).toBe(200);
  });

  it('switch off again: everything is visible and editable, as before', async () => {
    await switchTo(false);
    // (publish-all rewrote beta's text above; the category list shows every article.)
    const cats = await request(app).get('/api/widget/kb/categories').query({ workspace_id: ws });
    expect(slugsOf(cats.body.articles)).toEqual(['beta', 'delta', 'gamma']);
    const patch = await request(app).patch(`/api/knowledge-base/articles/${art.delta}`).query({ workspaceId: ws })
      .send({ workspaceId: ws, article: { excerpt: 'refund help' } });
    expect(patch.status).toBe(200);
  });
});
