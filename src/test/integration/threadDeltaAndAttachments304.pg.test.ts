// @vitest-environment node
/**
 * The thread read past DATABASE_MAX_ROWS (2026-11-08), on a real database
 * built by the whole chain, through the real route, with DATABASE_MAX_ROWS
 * at 5 so the data layer's silent cap shows with a handful of rows.
 *
 *   · `?since=` delta: when more rows than one read takes changed inside one
 *     overlap window (a visitor's backlog marked seen in one statement), a
 *     capped delta returned the same rows on every poll and its cursor never
 *     passed them, so a new message never arrived by delta. Now the delta is
 *     read page by page in (updated_at, id) order: every changed row comes
 *     back, the cursor moves past them, and the next new message arrives.
 *   · a delta past SYNC_DELTA_MAX rows answers a full read instead.
 *   · attachments of a page: more attachment rows than one read takes (of
 *     any status) were cut without a word; now every shown file comes back,
 *     and uploads in progress or failed are still not shown.
 *   · an older page (`before`, with the plain created_at bound next to the
 *     keyset) still reads exactly the rows before, ties on created_at
 *     included, and keeps the microseconds the client sent.
 *
 * Driven by TEST_DATABASE_URL; skipped without it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { createFullChainDatabase, type FullChainDatabase } from './fullChainDatabase';

const DSN = process.env.TEST_DATABASE_URL;
const suite = DSN ? describe : describe.skip;

type Row = Record<string, unknown>;
type Thread = { messages: Row[]; sync: { mode: string; cursor: string | null }; older: { before: string; before_id: string } | null };

vi.mock('../../../server/services/realtime/publish.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/realtime/publish.js')>()),
  publishConversationEvent: async () => ({ ok: true }),
  publishOperatorEvent: async () => undefined,
}));

suite('thread delta and attachments past DATABASE_MAX_ROWS (2026-11-08)', () => {
  let chain: FullChainDatabase;
  const q = async (sql: string, params: unknown[] = []): Promise<Row[]> => (await chain.db.query(sql, params)).rows as Row[];

  const owner = randomUUID();
  const ws = randomUUID();
  let app: express.Express;
  let token = '';

  const conversation = async () => {
    const id = randomUUID();
    await q(`INSERT INTO public.conversations (id, workspace_id, status) VALUES ($1, $2, 'open')`, [id, ws]);
    return id;
  };
  /** `n` visitor messages one second apart, an hour back, oldest first; returns their ids. */
  const visitorMessages = async (cid: string, n: number) => {
    const rows = await q(
      `INSERT INTO public.conversation_messages (conversation_id, sender_type, body, created_at, updated_at)
       SELECT $1, 'contact', 'm' || g, now() - interval '1 hour' + make_interval(secs => g), now() - interval '1 hour' + make_interval(secs => g)
         FROM generate_series(1, $2::int) g
       RETURNING id, body`, [cid, n]);
    return rows.sort((a, b) => Number(String(a.body).slice(1)) - Number(String(b.body).slice(1))).map((r) => String(r.id));
  };
  const thread = async (path: string): Promise<Thread> => {
    const res = await request(app).get(path).set({ Authorization: `Bearer ${token}` });
    expect(res.status).toBe(200);
    return res.body as Thread;
  };
  const delta = (cid: string, cursor: string) => thread(`/api/conversations/${cid}/messages?since=${encodeURIComponent(cursor)}`);

  beforeAll(async () => {
    chain = await createFullChainDatabase(DSN!, `thread_delta_${Date.now()}`);
    await q(`INSERT INTO public.profiles (id, email, full_name) VALUES ($1, $2, 'Owner')`, [owner, `p-${owner.slice(0, 8)}@test.local`]);
    await q(`INSERT INTO public.workspaces (id, name, slug, owner_id) VALUES ($1, 'Acme', $2, $3)`, [ws, `ws-${ws.slice(0, 8)}`, owner]);
    await q(`INSERT INTO public.workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')`, [ws, owner]);

    Object.assign(process.env, {
      DATABASE_URL: chain.url,
      DATABASE_MAX_ROWS: '5',
      PLATFORM_SIGNING_SECRET: 'signing-secret-for-this-test-only-0123456789',
      SUPABASE_URL: 'https://legacy-project.supabase.co',
      SUPABASE_ANON_KEY: 'legacy-anon-key-value',
      SUPABASE_SERVICE_ROLE_KEY: 'legacy-service-role-key-value-at-least-32',
      CORS_ORIGINS: 'http://127.0.0.1',
    });
    delete process.env.DATABASE_MODE;
    const config = { ...(await import('../../../server/config.js')).loadConfig(), selfHostBillingUnlimited: true };
    const { conversationsRouter } = await import('../../../server/routes/conversations.js');
    const { createSession } = await import('../../../server/services/auth/sessions.js');
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => { Object.assign(req, { serverConfig: config }); next(); });
    app.use('/api/conversations', conversationsRouter);
    token = (await createSession(config as never, { userId: owner, email: `p-${owner.slice(0, 8)}@test.local` })).token;
  }, 600_000);

  afterAll(async () => {
    delete process.env.DATABASE_MAX_ROWS;
    const { closeDataLayer } = await import('../../../server/db/index.js');
    await closeDataLayer().catch(() => undefined);
    await chain?.drop();
  });

  beforeEach(async () => {
    await q(`DELETE FROM public.conversations WHERE workspace_id = $1`, [ws]);
  });

  it('a backlog marked seen in one statement does not stall the delta: every row comes back, then the new message', async () => {
    const cid = await conversation();
    const ids = await visitorMessages(cid, 12);
    const full = await thread(`/api/conversations/${cid}/messages`);
    const cursor0 = full.sync.cursor!;
    expect(cursor0).toBeTruthy();

    // The operator opens the thread: the 12 unseen visitor rows get seen_at
    // in one statement, so their updated_at fall inside one overlap window.
    const seen = await request(app).post(`/api/conversations/${cid}/seen`).set({ Authorization: `Bearer ${token}` });
    expect(seen.status).toBe(200);
    expect(seen.body.count).toBe(12);

    const first = await delta(cid, cursor0);
    expect(first.sync.mode).toBe('delta');
    expect(new Set(first.messages.map((m) => m.id))).toEqual(new Set(ids));
    for (const m of first.messages) expect(m.seen_at).toBeTruthy();

    // A new message after the stamp arrives by the next delta.
    const [fresh] = await q(
      `INSERT INTO public.conversation_messages (conversation_id, sender_type, body) VALUES ($1, 'contact', 'fresh') RETURNING id`, [cid]);
    const second = await delta(cid, first.sync.cursor!);
    expect(second.sync.mode).toBe('delta');
    expect(second.messages.map((m) => m.id)).toContain(fresh.id);
    expect(Date.parse(second.sync.cursor!)).toBeGreaterThan(Date.parse(first.sync.cursor!));
  });

  it('rows sharing one updated_at are all read, none twice', async () => {
    const cid = await conversation();
    const ids = await visitorMessages(cid, 13);
    const stamp = new Date(Date.now() - 60_000).toISOString();
    // Thirteen rows with the very same updated_at: a keyset on updated_at
    // alone would lose or repeat rows between pages.
    await q(`ALTER TABLE public.conversation_messages DISABLE TRIGGER USER`);
    try {
      await q(`UPDATE public.conversation_messages SET updated_at = $2 WHERE conversation_id = $1`, [cid, stamp]);
    } finally {
      await q(`ALTER TABLE public.conversation_messages ENABLE TRIGGER USER`);
    }
    const body = await delta(cid, new Date(Date.parse(stamp) - 1000).toISOString());
    expect(body.sync.mode).toBe('delta');
    const got = body.messages.map((m) => String(m.id));
    expect(got).toHaveLength(13);
    expect(new Set(got)).toEqual(new Set(ids));
    // Thread order, whatever order the pages came in.
    expect(got).toEqual(ids);
  });

  it('a delta past SYNC_DELTA_MAX rows answers a full read (the newest page) instead', async () => {
    const { SYNC_DELTA_MAX } = await import('../../../server/services/messageSync.js');
    const cid = await conversation();
    await visitorMessages(cid, SYNC_DELTA_MAX + 1);
    const body = await delta(cid, new Date(Date.now() - 3 * 3600_000).toISOString());
    expect(body.sync.mode).toBe('full');
    // A full read stops at DATABASE_MAX_ROWS (5 here): the newest rows.
    expect(body.messages.map((m) => m.body)).toEqual([1, 2, 3, 4, 5].map((i) => `m${SYNC_DELTA_MAX + 1 - 5 + i}`));
    expect(body.older).not.toBeNull();
    expect(body.sync.cursor).toBeTruthy();
  }, 120_000);

  it('every shown attachment of a page comes back past the cap; uploads in progress and failed ones stay hidden', async () => {
    const cid = await conversation();
    const [mid] = await visitorMessages(cid, 1);
    const insert = (status: string, name: string) => q(
      `INSERT INTO public.conversation_attachments (workspace_id, conversation_id, message_id, storage_provider, storage_path, file_name, mime_type, size_bytes, uploaded_by_type, status)
       VALUES ($1, $2, $3, 'local', $6, $4, 'image/png', 10, 'visitor', $5) RETURNING id`,
      [ws, cid, mid, name, status, `workspace/${ws}/attachments/${name}`]);
    // Eight rows that are not shown (more than one read takes) and seven that are.
    for (let i = 0; i < 4; i++) { await insert('uploading', `u${i}.png`); await insert('failed', `f${i}.png`); }
    const shown: string[] = [];
    for (let i = 0; i < 7; i++) shown.push(String((await insert(i % 2 ? 'attached' : 'uploaded', `a${i}.png`))[0].id));

    const body = await thread(`/api/conversations/${cid}/messages`);
    const msg = body.messages.find((m) => m.id === mid)!;
    const list = (msg.attachments as Row[]) || [];
    expect(new Set(list.map((a) => a.id))).toEqual(new Set(shown));
    expect(list.every((a) => String(a.file_name).startsWith('a'))).toBe(true);
  });

  it('an older page reads exactly the rows before, ties on created_at and microseconds included', async () => {
    const cid = await conversation();
    // Nine rows: three share one created_at (with microseconds), the rest a second apart.
    const at = '2026-11-08 10:00:00.123456+00';
    const tie = [randomUUID(), randomUUID(), randomUUID()].sort();
    for (const id of tie) {
      await q(`INSERT INTO public.conversation_messages (id, conversation_id, sender_type, body, created_at) VALUES ($1, $2, 'contact', 'tie', $3)`, [id, cid, at]);
    }
    for (let i = 1; i <= 3; i++) {
      await q(`INSERT INTO public.conversation_messages (conversation_id, sender_type, body, created_at) VALUES ($1, 'contact', $2, $3::timestamptz - make_interval(secs => $4))`, [cid, `old${i}`, at, 4 - i]);
      await q(`INSERT INTO public.conversation_messages (conversation_id, sender_type, body, created_at) VALUES ($1, 'contact', $2, $3::timestamptz + make_interval(secs => $4))`, [cid, `new${i}`, at, i]);
    }
    const all = (await q(`SELECT id::text FROM public.conversation_messages WHERE conversation_id = $1 ORDER BY created_at, id`, [cid])).map((r) => String(r.id));
    expect(all).toHaveLength(9);

    // Page back from the middle of the tie: the client holds the second tie row on.
    const page = await thread(`/api/conversations/${cid}/messages?limit=5&before=${encodeURIComponent('2026-11-08T10:00:00.123456+00:00')}&before_id=${tie[1]}`);
    const want = all.slice(0, all.indexOf(tie[1]));
    expect(page.messages.map((m) => m.id)).toEqual(want.slice(-5));
    // Older is the page's first row, as the database gave it.
    expect(page.older).toEqual(want.length > 5 ? { before: page.messages[0].created_at, before_id: page.messages[0].id } : null);
    // Walking back to the start reads every row once.
    const seen: string[] = [];
    let cursor: Thread['older'] = { before: '2026-11-08T10:00:03.123456+00:00', before_id: 'ffffffff-ffff-4fff-bfff-ffffffffffff' };
    for (let i = 0; cursor && i < 10; i++) {
      const p = await thread(`/api/conversations/${cid}/messages?limit=2&before=${encodeURIComponent(cursor.before)}&before_id=${cursor.before_id}`);
      seen.unshift(...p.messages.map((m) => String(m.id)));
      cursor = p.older;
    }
    expect(cursor).toBeNull();
    expect(seen).toEqual(all);
  });
});
