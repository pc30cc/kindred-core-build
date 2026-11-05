// @vitest-environment node
/**
 * Reads past DATABASE_MAX_ROWS, on a real database built by the whole chain,
 * with DATABASE_MAX_ROWS at 3 so every read the data layer would cut short
 * shows with a handful of rows (audit 2026-11-04, the server's remaining
 * sites):
 *
 *   · the AI index rebuild keeps every eligible article's chunks and retires
 *     every stale one (knowledgeIndex/sync.ts), and its status counts all;
 *   · a source's resync re-embeds nothing it already has and retires every
 *     orphan (knowledgeIndex/indexer.ts);
 *   · turning the AI off hands every AI-held conversation back
 *     (platformSettings.ts repairPlatformOffConversations);
 *   · a receipt resend plan reports `truncated` past MAX_ROWS
 *     (billing/account/receiptResend.ts);
 *   · the weekly summary counts every message (notificationEmail/producers.ts);
 *   · callback counts are exact (calls/callbacks.ts);
 *   · a call is created within max_concurrent_calls under the workspace's
 *     lock (migration 302, calls/concurrencyLimit.ts).
 *
 * Driven by TEST_DATABASE_URL; skipped without it. The index tests need
 * pgvector (ai_knowledge_chunks.embedding), as CI's integration job has.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createFullChainDatabase, type FullChainDatabase } from './fullChainDatabase';

const DSN = process.env.TEST_DATABASE_URL;
const suite = DSN ? describe : describe.skip;

type Row = Record<string, unknown>;

const embedCalls = vi.hoisted(() => ({ texts: 0 }));
vi.mock('../../../server/services/ai-agent/embeddings/index.js', async (orig) => {
  const real = await orig<typeof import('../../../server/services/ai-agent/embeddings/index.js')>();
  const vector = Array.from({ length: 1536 }, (_, i) => (i === 0 ? 1 : 0));
  return {
    ...real,
    resolveEmbeddingProvider: async () => ({
      name: 'fake',
      model: 'fake-1536',
      dimensions: 1536,
      embedTexts: async (texts: string[]) => {
        embedCalls.texts += texts.length;
        return texts.map(() => vector);
      },
    }),
  };
});
vi.mock('../../../server/services/realtime/publish.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/realtime/publish.js')>()),
  publishConversationEvent: async () => ({ ok: true }),
  publishOperatorEvent: async () => undefined,
}));

suite('server reads past DATABASE_MAX_ROWS (audit 2026-11-04)', () => {
  let chain: FullChainDatabase;
  let config: never;
  let hasVector = false;
  const q = async (sql: string, params: unknown[] = []): Promise<Row[]> => (await chain.db.query(sql, params)).rows as Row[];
  const one = async (sql: string, params: unknown[] = []): Promise<Row> => (await q(sql, params))[0];

  const owner = randomUUID();
  const ws = randomUUID();

  beforeAll(async () => {
    chain = await createFullChainDatabase(DSN!, `row_caps_${Date.now()}`);
    await q(`INSERT INTO public.profiles (id, email, full_name) VALUES ($1, $2, 'Owner')`, [owner, `o-${owner.slice(0, 8)}@test.local`]);
    await q(`INSERT INTO public.workspaces (id, name, slug, owner_id) VALUES ($1, 'Acme', $2, $3)`, [ws, `ws-${ws.slice(0, 8)}`, owner]);
    await q(`INSERT INTO public.workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')`, [ws, owner]);
    hasVector = Number((await one(
      `SELECT count(*)::int AS n FROM pg_attribute WHERE attrelid = 'public.ai_knowledge_chunks'::regclass AND attname = 'embedding' AND NOT attisdropped`,
    )).n) === 1;

    Object.assign(process.env, {
      DATABASE_URL: chain.url,
      DATABASE_MAX_ROWS: '3',
      PLATFORM_SIGNING_SECRET: 'signing-secret-for-this-test-only-0123456789',
      SUPABASE_URL: 'https://legacy-project.supabase.co',
      SUPABASE_ANON_KEY: 'legacy-anon-key-value',
      SUPABASE_SERVICE_ROLE_KEY: 'legacy-service-role-key-value-at-least-32',
      CORS_ORIGINS: 'http://127.0.0.1',
    });
    delete process.env.DATABASE_MODE;
    config = (await import('../../../server/config.js')).loadConfig() as never;
  }, 600_000);

  afterAll(async () => {
    delete process.env.DATABASE_MAX_ROWS;
    const { closeDataLayer } = await import('../../../server/db/index.js');
    await closeDataLayer().catch(() => undefined);
    await chain?.drop();
  });

  it('the index rebuild keeps every eligible article and retires every stale chunk; its status counts all', async (ctx) => {
    if (!hasVector) ctx.skip();
    const articles: string[] = [];
    for (let i = 0; i < 8; i++) {
      const id = randomUUID();
      articles.push(id);
      await q(`INSERT INTO public.knowledge_base_articles (id, workspace_id, slug, locale, title, content, status, used_by_ai)
               VALUES ($1, $2, $3, 'en', $4, 'Refunds, step by step.', 'published', true)`, [id, ws, `a-${i}`, `Article ${i}`]);
    }
    // Seven chunks of articles that no longer exist.
    const gone: string[] = [];
    for (let i = 0; i < 7; i++) {
      const sourceId = randomUUID();
      gone.push(sourceId);
      await q(`INSERT INTO public.ai_knowledge_chunks (workspace_id, source_type, source_id, title, content, content_hash, status)
               VALUES ($1, 'kb_article', $2, 'old', 'old text', $3, 'active')`, [ws, sourceId, randomUUID()]);
    }

    const { rebuildWorkspaceIndex, getKnowledgeIndexStatus } = await import('../../../server/services/ai-agent/knowledgeIndex/sync.js');
    const first = await rebuildWorkspaceIndex(config, ws);
    expect(first.reconciliationSkipped).toBeFalsy();
    expect(first.staleSourcesReconciled).toBe(7);
    // A second pass changes nothing: every article stays indexed.
    const second = await rebuildWorkspaceIndex(config, ws);
    expect(second.chunksDeleted).toBe(0);
    expect(second.staleSourcesReconciled).toBe(0);

    const live = await q(`SELECT source_id FROM public.ai_knowledge_chunks
                           WHERE workspace_id = $1 AND source_type = 'kb_article' AND status = 'active'`, [ws]);
    expect(new Set(live.map((r) => String(r.source_id)))).toEqual(new Set(articles));
    const stale = await q(`SELECT DISTINCT status FROM public.ai_knowledge_chunks WHERE workspace_id = $1 AND source_id = ANY($2::text[])`, [ws, gone]);
    expect(stale.map((r) => r.status)).toEqual(['deleted']);

    const status = await getKnowledgeIndexStatus(config, ws);
    expect(status.activeChunks).toBe(live.length);
    expect(status.deletedChunks).toBe(7);
    expect(status.embeddedChunks).toBe(live.length);
    expect(status.bySourceType.kb_article).toBe(live.length);
    expect(status.lastUpdated).not.toBeNull();
  });

  it('a resync embeds nothing it already has and retires every orphan', async (ctx) => {
    if (!hasVector) ctx.skip();
    const { indexSource, getEmbedderForWorkspace } = await import('../../../server/services/ai-agent/knowledgeIndex/indexer.js');
    const embedder = await getEmbedderForWorkspace(config, ws);
    const sourceId = randomUUID();
    const chunks = (n: number) => Array.from({ length: n }, (_, i) => ({ index: i, content: `chunk ${i} of the source` }));
    const input = { workspaceId: ws, sourceType: 'qna' as const, sourceId, title: 'Q', chunks: chunks(8) };

    const created = await indexSource(config, input, embedder);
    expect(created.chunksCreated).toBe(8);
    embedCalls.texts = 0;
    const again = await indexSource(config, input, embedder);
    expect(again.chunksSkipped).toBe(8);
    expect(embedCalls.texts).toBe(0);

    const shrunk = await indexSource(config, { ...input, chunks: chunks(2) }, embedder);
    expect(shrunk.chunksDeleted).toBe(6);
    const rows = await q(`SELECT status, count(*)::int AS n FROM public.ai_knowledge_chunks WHERE source_id = $1 GROUP BY status ORDER BY status`, [sourceId]);
    expect(rows).toEqual([{ status: 'active', n: 2 }, { status: 'deleted', n: 6 }]);
  });

  it('turning the AI off hands every open AI-held conversation back; closed ones are only counted', async () => {
    const held: string[] = [];
    for (let i = 0; i < 7; i++) {
      held.push(String((await one(`INSERT INTO public.conversations (workspace_id, status, metadata)
                                   VALUES ($1, 'open', '{"ai_state":"ai_managed"}') RETURNING id`, [ws])).id));
    }
    await q(`INSERT INTO public.conversations (workspace_id, status, metadata) VALUES ($1, 'closed', '{"ai_state":"ai_managed"}')`, [ws]);
    const { repairPlatformOffConversations } = await import('../../../server/services/ai-agent/platformSettings.js');
    const out = await repairPlatformOffConversations(config, 'platform_ai_disabled', { workspaceId: ws });
    expect(out).toEqual({ scanned: 7, repaired: 7, skipped_closed: 1, incomplete: false });
    const left = await one(`SELECT count(*)::int AS n FROM public.conversations WHERE id = ANY($1::uuid[]) AND ai_state = 'ai_managed'`, [held]);
    expect(left.n).toBe(0);
  });

  it('keyset pages: a row leaving the filter between two pages skips nothing (offset pages would)', async () => {
    const w = randomUUID();
    await q(`INSERT INTO public.workspaces (id, name, slug, owner_id) VALUES ($1, 'Keys', $2, $3)`, [w, `k-${w.slice(0, 8)}`, owner]);
    for (let i = 0; i < 9; i++) {
      await q(`INSERT INTO public.knowledge_base_articles (workspace_id, slug, locale, title, content, status, used_by_ai)
               VALUES ($1, $2, 'en', $3, 'x', 'published', true)`, [w, `k-${i}`, `K ${i}`]);
    }
    const all = (await q(`SELECT id FROM public.knowledge_base_articles WHERE workspace_id = $1 ORDER BY id`, [w])).map((r) => String(r.id));
    const { readRows, readRowsByKey, keyPage } = await import('../../../server/lib/pagedRows.js');
    const { getServiceClient } = await import('../../../server/supabase.js');
    const sb = getServiceClient(config);
    const published = () => sb.from('knowledge_base_articles').select('id').eq('workspace_id', w).eq('status', 'published');
    // After the first page (3 rows, DATABASE_MAX_ROWS), its first article is
    // unpublished, as an operator could at that moment.
    const unpublishAfterFirstPage = (pageNo: number) => (pageNo === 1
      ? q(`UPDATE public.knowledge_base_articles SET status = 'draft' WHERE id = $1`, [all[0]])
      : Promise.resolve([]));

    let pages = 0;
    const byOffset = await readRows<{ id: string }>(async (from, to) => {
      await unpublishAfterFirstPage(pages++);
      return published().order('id', { ascending: true }).range(from, to);
    });
    // The offset read lost the row that slid back across the boundary.
    expect(byOffset.data.map((r) => r.id)).not.toContain(all[3]);

    await q(`UPDATE public.knowledge_base_articles SET status = 'published' WHERE id = $1`, [all[0]]);
    pages = 0;
    const byKey = await readRowsByKey<{ id: string }>('id', async (after, size) => {
      await unpublishAfterFirstPage(pages++);
      return keyPage(published(), 'id', after, size);
    });
    expect(byKey.error).toBeNull();
    // Every article still published after the change, and the one read before it.
    expect(byKey.data.map((r) => r.id)).toEqual(all);
  });

  it('the weekly summary counts every message of every conversation touched', async () => {
    const other = randomUUID();
    await q(`INSERT INTO public.workspaces (id, name, slug, owner_id) VALUES ($1, 'Week', $2, $3)`, [other, `wk-${other.slice(0, 8)}`, owner]);
    for (let i = 0; i < 5; i++) {
      const cid = String((await one(`INSERT INTO public.conversations (workspace_id, status) VALUES ($1, 'open') RETURNING id`, [other])).id);
      for (let m = 0; m < 4; m++) {
        await q(`INSERT INTO public.conversation_messages (conversation_id, sender_type, body) VALUES ($1, 'contact', 'hi')`, [cid]);
      }
    }
    const { weekCounts } = await import('../../../server/services/notificationEmail/producers.js');
    const since = new Date(Date.now() - 3600_000);
    const counts = await weekCounts(config, other, since, new Date(Date.now() + 3600_000));
    expect(counts.conversations).toBe(5);
    expect(counts.messages).toBe(20);
  });

  it('callback counts are exact', async () => {
    for (let i = 0; i < 5; i++) {
      await q(`INSERT INTO public.callback_requests (workspace_id, status) VALUES ($1, 'requested')`, [ws]);
    }
    await q(`INSERT INTO public.callback_requests (workspace_id, status) VALUES ($1, 'completed')`, [ws]);
    const { getCallbackCounts } = await import('../../../server/services/calls/callbacks.js');
    expect(await getCallbackCounts(config, ws)).toMatchObject({ requested: 5, completed: 1, scheduled: 0 });
  });

  it('a receipt resend plan reports truncated past its bound', async () => {
    await q(`INSERT INTO public.email_logs (workspace_id, template_slug, status, recipient_email, metadata, created_at)
             SELECT $1, 'billing_receipt', 'failed', 'x@test.local', jsonb_build_object('receipt_number', 'R-' || g), now() - interval '1 hour'
               FROM generate_series(1, 2001) AS g`, [ws]);
    const { planReceiptResend } = await import('../../../server/services/billing/account/receiptResend.js');
    const plan = await planReceiptResend(config, { since: new Date(Date.now() - 2 * 3600_000), until: new Date() });
    expect(plan.truncated).toBe(true);
    expect(plan.items.length + Object.values(plan.otherFailures).reduce((a, b) => a + b, 0)).toBe(2000);
  }, 120_000);

  describe('call_session_create (migration 302)', () => {
    const row = (workspaceId: string) => ({
      workspace_id: workspaceId,
      provider: 'livekit',
      call_type: 'audio',
      context_type: 'internal',
      state: 'pending',
      initiated_by_type: 'operator',
      metadata: { test: true },
    });

    it('concurrent creations at the limit: exactly the limit is created, the rest are refused', async () => {
      const w = randomUUID();
      await q(`INSERT INTO public.workspaces (id, name, slug, owner_id) VALUES ($1, 'Calls', $2, $3)`, [w, `c-${w.slice(0, 8)}`, owner]);
      const pg = (await import('pg')).default;
      const clients = await Promise.all(Array.from({ length: 6 }, async () => {
        const c = new pg.Client({ connectionString: chain.url });
        await c.connect();
        return c;
      }));
      try {
        const verdicts = await Promise.all(clients.map(async (c) => (
          (await c.query(`SELECT public.call_session_create($1::jsonb, 2) AS r`, [JSON.stringify(row(w))])).rows[0].r as { verdict: string }
        ).verdict));
        expect(verdicts.filter((v) => v === 'created')).toHaveLength(2);
        expect(verdicts.filter((v) => v === 'limit_reached')).toHaveLength(4);
      } finally {
        await Promise.all(clients.map((c) => c.end()));
      }
      expect((await one(`SELECT count(*)::int AS n FROM public.call_sessions WHERE workspace_id = $1`, [w])).n).toBe(2);
    });

    it('through the data layer: the row with its defaults, the limit verdict, no limit, an unknown column refused', async () => {
      const w = randomUUID();
      await q(`INSERT INTO public.workspaces (id, name, slug, owner_id) VALUES ($1, 'Calls2', $2, $3)`, [w, `d-${w.slice(0, 8)}`, owner]);
      const { getServiceClient } = await import('../../../server/supabase.js');
      const { insertCallSessionWithinCeiling } = await import('../../../server/services/calls/concurrencyLimit.js');
      const sb = getServiceClient(config);

      const created = await insertCallSessionWithinCeiling(sb as never, row(w), 1);
      expect(created.verdict).toBe('created');
      const call = (created as { call: Row }).call;
      expect(call.id).toEqual(expect.any(String));
      expect(call.created_at).toBeTruthy();
      expect(call.metadata).toEqual({ test: true });

      expect(await insertCallSessionWithinCeiling(sb as never, row(w), 1)).toEqual({ verdict: 'limit_reached', used: 1, max: 1 });
      expect((await insertCallSessionWithinCeiling(sb as never, row(w), -1)).verdict).toBe('created');
      expect((await insertCallSessionWithinCeiling(sb as never, row(w), undefined)).verdict).toBe('created');
      const bad = await insertCallSessionWithinCeiling(sb as never, { ...row(w), not_a_column: 1 }, 5);
      expect(bad.verdict).toBe('error');
    });
  });
});
