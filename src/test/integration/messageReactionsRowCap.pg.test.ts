// @vitest-environment node
/**
 * Message reactions past DATABASE_MAX_ROWS, on a real database built by the
 * whole chain, through the real routes, with DATABASE_MAX_ROWS at 5 so the
 * data layer's silent cap shows with a handful of rows (audit 2026-11-06).
 *
 * A thread read used to take the conversation's reactions oldest-first in
 * one read: past the cap (1000 in production), every newer reaction was cut,
 * so a fresh reaction on the newest message never came back. Now a read
 * takes every reaction of exactly the messages it answers with (the newest
 * page, an older page, a `?since` delta), page by page:
 *
 *   · a fresh reaction on the newest message comes back behind more older
 *     reactions than one read takes;
 *   · one message's count is exact past the cap (two operators, six emojis);
 *   · an older page carries its own messages' reactions;
 *   · adding and taking back show in the `?since` delta;
 *   · a row naming this thread's message under another conversation is not
 *     this thread's (the read keeps the conversation filter);
 *   · the widget's read (the thread's newest messages) sees them all too.
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
const HEART = '❤️';
const EMOJIS = ['❤️', '👍', '😂', '😮', '😢', '🙏'];

vi.mock('../../../server/services/realtime/publish.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/realtime/publish.js')>()),
  publishConversationEvent: async () => ({ ok: true }),
  publishOperatorEvent: async () => undefined,
}));

suite('message reactions past DATABASE_MAX_ROWS (audit 2026-11-06)', () => {
  let chain: FullChainDatabase;
  const q = async (sql: string, params: unknown[] = []): Promise<Row[]> => (await chain.db.query(sql, params)).rows as Row[];

  const owner = randomUUID();
  const ali = randomUUID();
  const ws = randomUUID();
  const other = randomUUID();

  let app: express.Express;
  const tokens: Record<string, string> = {};
  const as = (user: string) => ({ Authorization: `Bearer ${tokens[user]}` });

  const conversation = async (workspace = ws) => {
    const id = randomUUID();
    await q(`INSERT INTO public.conversations (id, workspace_id, status) VALUES ($1, $2, 'open')`, [id, workspace]);
    return id;
  };
  /** `n` messages one second apart, alternating visitor and agent, oldest first; returns their ids. */
  const messages = async (cid: string, n: number) => {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const id = randomUUID();
      await q(`INSERT INTO public.conversation_messages (id, conversation_id, sender_type, sender_id, body, created_at)
               VALUES ($1, $2, $3, $4, $5, now() - make_interval(secs => $6))`,
      [id, cid, i % 2 ? 'agent' : 'contact', i % 2 ? owner : null, `m${i}`, n - i]);
      ids.push(id);
    }
    return ids;
  };
  const react = async (cid: string, mid: string, actor: string | null, emoji: string, workspace = ws, at = 'now()') => {
    await q(`INSERT INTO public.conversation_message_reactions (workspace_id, conversation_id, message_id, actor_type, actor_id, emoji, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, ${at})`, [workspace, cid, mid, actor ? 'operator' : 'visitor', actor, emoji]);
  };
  const thread = async (path: string) => {
    const res = await request(app).get(path).set(as(owner));
    expect(res.status).toBe(200);
    return res.body as { messages: Row[]; sync: { mode: string; cursor: string | null }; older: { before: string; before_id: string } | null };
  };
  const reactionsOf = (body: { messages: Row[] }, mid: string) => body.messages.find((m) => m.id === mid)?.reactions;

  beforeAll(async () => {
    chain = await createFullChainDatabase(DSN!, `reactions_cap_${Date.now()}`);
    for (const [id, name] of [[owner, 'Owner'], [ali, 'Ali']]) {
      await q(`INSERT INTO public.profiles (id, email, full_name) VALUES ($1, $2, $3)`, [id, `p-${id.slice(0, 8)}@test.local`, name]);
    }
    await q(`INSERT INTO public.workspaces (id, name, slug, owner_id) VALUES ($1, 'Acme', $2, $3), ($4, 'Other', $5, $3)`,
      [ws, `ws-${ws.slice(0, 8)}`, owner, other, `ws-${other.slice(0, 8)}`]);
    await q(`INSERT INTO public.workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'agent'), ($4, $2, 'owner')`,
      [ws, owner, ali, other]);

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
    for (const id of [owner, ali]) {
      tokens[id] = (await createSession(config as never, { userId: id, email: `p-${id.slice(0, 8)}@test.local` })).token;
    }
  }, 600_000);

  afterAll(async () => {
    delete process.env.DATABASE_MAX_ROWS;
    const { closeDataLayer } = await import('../../../server/db/index.js');
    await closeDataLayer().catch(() => undefined);
    await chain?.drop();
  });

  beforeEach(async () => {
    await q(`DELETE FROM public.conversations WHERE workspace_id IN ($1, $2)`, [ws, other]);
  });

  it('a fresh reaction on the newest message comes back behind more older reactions than one read takes', async () => {
    const cid = await conversation();
    const ids = await messages(cid, 8);
    // Twelve older reactions (more than two reads' worth) on the older messages, an hour back.
    for (const mid of ids.slice(0, 3)) {
      for (const e of EMOJIS.slice(0, 4)) await react(cid, mid, owner, e, ws, `now() - interval '1 hour'`);
    }
    const newest = ids[ids.length - 1];
    await react(cid, newest, null, HEART);

    const body = await thread(`/api/conversations/${cid}/messages`);
    expect(body.messages.map((m) => m.id)).toContain(newest);
    expect(reactionsOf(body, newest)).toEqual([{ emoji: HEART, count: 1, visitor: true, mine: false }]);
  });

  it('one message\'s count is exact past the cap: two operators, every emoji', async () => {
    const cid = await conversation();
    const [mid] = await messages(cid, 1);
    for (const actor of [owner, ali]) for (const e of EMOJIS) await react(cid, mid, actor, e);
    await react(cid, mid, null, HEART);

    const list = reactionsOf(await thread(`/api/conversations/${cid}/messages`), mid) as Row[];
    expect(list).toHaveLength(EMOJIS.length);
    expect(list.find((r) => r.emoji === HEART)).toEqual({ emoji: HEART, count: 3, visitor: true, mine: true });
    for (const r of list.filter((x) => x.emoji !== HEART)) expect(r).toMatchObject({ count: 2, visitor: false, mine: true });
  });

  it('an older page carries its own messages\' reactions', async () => {
    const cid = await conversation();
    const ids = await messages(cid, 8);
    // The newest page (5 rows) reacts heavily; the oldest message has one.
    for (const mid of ids.slice(3)) for (const e of EMOJIS.slice(0, 3)) await react(cid, mid, owner, e);
    await react(cid, ids[0], ali, '🙏');

    const first = await thread(`/api/conversations/${cid}/messages`);
    expect(first.older).not.toBeNull();
    const back = await thread(`/api/conversations/${cid}/messages?before=${encodeURIComponent(first.older!.before)}&before_id=${first.older!.before_id}`);
    expect(back.messages.map((m) => m.id)).toContain(ids[0]);
    expect(reactionsOf(back, ids[0])).toEqual([{ emoji: '🙏', count: 1, visitor: false, mine: false }]);
    for (const mid of ids.slice(3)) expect((reactionsOf(first, mid) as Row[]).length).toBe(3);
  });

  it('adding and taking back show in the `?since` delta', async () => {
    const cid = await conversation();
    const ids = await messages(cid, 3);
    // 👍 and 😂 an hour back (not the heart the visitor adds below).
    for (const mid of ids) for (const e of EMOJIS.slice(1, 3)) await react(cid, mid, owner, e, ws, `now() - interval '1 hour'`);
    const full = await thread(`/api/conversations/${cid}/messages`);
    const cursor = full.sync.cursor;
    expect(cursor).toBeTruthy();

    await react(cid, ids[2], null, HEART);
    const added = await thread(`/api/conversations/${cid}/messages?since=${encodeURIComponent(cursor!)}`);
    expect(added.sync.mode).toBe('delta');
    expect((reactionsOf(added, ids[2]) as Row[]).find((r) => r.emoji === HEART)).toEqual({ emoji: HEART, count: 1, visitor: true, mine: false });

    await q(`DELETE FROM public.conversation_message_reactions WHERE message_id = $1 AND actor_type = 'visitor'`, [ids[2]]);
    const taken = await thread(`/api/conversations/${cid}/messages?since=${encodeURIComponent(cursor!)}`);
    const after = reactionsOf(taken, ids[2]) as Row[];
    expect(after.map((r) => r.emoji)).toEqual(EMOJIS.slice(1, 3));
  });

  it('a row naming this thread\'s message under another conversation is not this thread\'s', async () => {
    const cid = await conversation();
    const [mid] = await messages(cid, 1);
    const elsewhere = await conversation(other);
    await react(elsewhere, mid, owner, '😮', other);
    await react(cid, mid, owner, '👍');
    expect(reactionsOf(await thread(`/api/conversations/${cid}/messages`), mid)).toEqual([{ emoji: '👍', count: 1, visitor: false, mine: true }]);
  });

  it('the widget\'s read (the thread\'s newest messages) sees every reaction of them', async () => {
    const cid = await conversation();
    const ids = await messages(cid, 8);
    for (const mid of ids.slice(0, 3)) for (const e of EMOJIS.slice(0, 4)) await react(cid, mid, owner, e, ws, `now() - interval '1 hour'`);
    await react(cid, ids[7], null, HEART);
    const { readWidgetThreadReactions } = await import('../../../server/services/messageReactions.js');
    const { getServiceClient } = await import('../../../server/supabase.js');
    const config = (await import('../../../server/config.js')).loadConfig();
    const { byMessage, ready } = await readWidgetThreadReactions(getServiceClient(config), cid, { type: 'visitor' });
    expect(ready).toBe(true);
    expect(byMessage.get(ids[7])).toEqual([{ emoji: HEART, count: 1, visitor: true, mine: true }]);
    for (const mid of ids.slice(0, 3)) expect(byMessage.get(mid)).toHaveLength(4);
  });
});
