// @vitest-environment node
/**
 * 303 — every Inbox row's summary is its own conversation's (audit
 * 2026-11-06), on a real database built by the whole chain, through the real
 * GET /api/conversations.
 *
 * The list used to read ONE window of the 2000 newest messages of all the
 * listed conversations together and take every row's summary from it:
 *
 *   · A with 2000 messages newer than B's last one: B read last_message null,
 *     unread 0 (with 1999, B was still read: the boundary);
 *   · a closed conversation another operator answered, unassigned: with its
 *     messages outside the window, handled_by [] made it "shared", so it
 *     reached an operator who never wrote in it (and an operator's own could
 *     leave their list when only a colleague's newer reply was read);
 *   · a customer who wrote again after an answer read needs_reply false (the
 *     answer behind decided), and waiting_since drifted past the answer.
 *
 * conversation_list_summaries() reads every row from its own conversation;
 * the route uses it and falls back to the old window without it (PGRST202).
 * Its needs_reply / waiting_since agree with needsReply.ts on generated
 * fixtures; it is EXECUTE for service_role only; another workspace's ids
 * give nothing; a read past DATABASE_MAX_ROWS is paged.
 *
 * Driven by TEST_DATABASE_URL; skipped without it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { createFullChainDatabase, type FullChainDatabase } from './fullChainDatabase';
import { computeNeedsReply, computeWaitingSince, type NeedsReplyMessage } from '../../../server/services/needsReply';

const DSN = process.env.TEST_DATABASE_URL;
const suite = DSN ? describe : describe.skip;

type Row = Record<string, unknown>;

vi.mock('../../../server/services/realtime/publish.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/realtime/publish.js')>()),
  publishConversationEvent: async () => ({ ok: true }),
  publishOperatorEvent: async () => undefined,
}));

suite('303 — every Inbox row\'s summary is its own conversation\'s (real PostgreSQL, the whole chain)', () => {
  let chain: FullChainDatabase;
  const q = async (sql: string, params: unknown[] = []): Promise<Row[]> => (await chain.db.query(sql, params)).rows as Row[];
  const one = async (sql: string, params: unknown[] = []): Promise<Row> => (await q(sql, params))[0];

  const owner = randomUUID();
  const a = randomUUID(); // agent
  const b = randomUUID(); // agent
  const ws = randomUUID();
  const other = randomUUID();
  const otherOwner = randomUUID();

  let app: express.Express;
  const tokens: Record<string, string> = {};
  const as = (user: string) => ({ Authorization: `Bearer ${tokens[user]}` });

  const conversation = async (fields: { status?: string; assigned?: string | null; workspace?: string; updatedSecsAgo?: number } = {}) => {
    const id = randomUUID();
    await q(`INSERT INTO public.conversations (id, workspace_id, status, assigned_to, updated_at)
             VALUES ($1, $2, $3, $4, now() - make_interval(secs => $5))`,
    [id, fields.workspace ?? ws, fields.status ?? 'open', fields.assigned ?? null, fields.updatedSecsAgo ?? 0]);
    return id;
  };
  const message = async (cid: string, f: { sender?: string; senderId?: string | null; body?: string; secsAgo: number; seen?: boolean; metadata?: Row }) => {
    const id = randomUUID();
    await q(`INSERT INTO public.conversation_messages (id, conversation_id, sender_type, sender_id, body, created_at, seen_at, metadata)
             VALUES ($1, $2, $3, $4, $5, now() - make_interval(secs => $6), $7, $8)`,
    [id, cid, f.sender ?? 'contact', f.senderId ?? null, f.body ?? 'hi', f.secsAgo, f.seen ? new Date().toISOString() : null, f.metadata ?? {}]);
    return id;
  };
  /** `n` agent messages by `sender`, the newest `newestSecsAgo` back, one second apart. */
  const flood = async (cid: string, n: number, sender: string, newestSecsAgo = 1) => {
    await q(`INSERT INTO public.conversation_messages (conversation_id, sender_type, sender_id, body, created_at)
             SELECT $1, 'agent', $2, 'flood ' || g, now() - make_interval(secs => $4 + $3 - g)
               FROM generate_series(1, $3) g`, [cid, sender, n, newestSecsAgo]);
  };
  const list = async (user: string, query = '') => {
    const res = await request(app).get(`/api/conversations?workspace_id=${ws}${query}`).set(as(user));
    expect(res.status).toBe(200);
    return Object.fromEntries((res.body.conversations as Row[]).map((c) => [String(c.id), c]));
  };

  beforeAll(async () => {
    chain = await createFullChainDatabase(DSN!, `list_summaries_303_${Date.now()}`);
    for (const [id, name] of [[owner, 'Owner'], [a, 'Ali'], [b, 'Bahar'], [otherOwner, 'Other']]) {
      await q(`INSERT INTO public.profiles (id, email, full_name) VALUES ($1, $2, $3)`, [id, `p-${id.slice(0, 8)}@test.local`, name]);
    }
    await q(`INSERT INTO public.workspaces (id, name, slug, owner_id) VALUES ($1, 'Acme', $2, $3)`, [ws, `ws-${ws.slice(0, 8)}`, owner]);
    await q(`INSERT INTO public.workspaces (id, name, slug, owner_id) VALUES ($1, 'Other', $2, $3)`, [other, `ws-${other.slice(0, 8)}`, otherOwner]);
    await q(`INSERT INTO public.workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'agent'), ($1, $4, 'agent')`, [ws, owner, a, b]);
    await q(`INSERT INTO public.workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')`, [other, otherOwner]);

    Object.assign(process.env, {
      DATABASE_URL: chain.url,
      PLATFORM_SIGNING_SECRET: 'signing-secret-for-this-test-only-0123456789',
      SUPABASE_URL: 'https://legacy-project.supabase.co',
      SUPABASE_ANON_KEY: 'legacy-anon-key-value',
      SUPABASE_SERVICE_ROLE_KEY: 'legacy-service-role-key-value-at-least-32',
      CORS_ORIGINS: 'http://127.0.0.1',
    });
    delete process.env.DATABASE_MODE;
    delete process.env.DATABASE_MAX_ROWS;
    const config = { ...(await import('../../../server/config.js')).loadConfig(), selfHostBillingUnlimited: true };
    const { conversationsRouter } = await import('../../../server/routes/conversations.js');
    const { createSession } = await import('../../../server/services/auth/sessions.js');
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => { Object.assign(req, { serverConfig: config }); next(); });
    app.use('/api/conversations', conversationsRouter);
    for (const id of [owner, a, b, otherOwner]) {
      tokens[id] = (await createSession(config as never, { userId: id, email: `p-${id.slice(0, 8)}@test.local` })).token;
    }
  }, 600_000);

  afterAll(async () => {
    const { closeDataLayer } = await import('../../../server/db/index.js');
    await closeDataLayer().catch(() => undefined);
    await chain?.drop();
  });

  beforeEach(async () => {
    await q(`DELETE FROM public.conversations WHERE workspace_id IN ($1, $2)`, [ws, other]);
  });

  it('A with 2000 newer messages: B keeps its last message and its unread (and with 1999, the boundary, too)', async () => {
    for (const n of [2000, 1999]) {
      await q(`DELETE FROM public.conversations WHERE workspace_id = $1`, [ws]);
      const busy = await conversation();
      await flood(busy, n, owner);
      const quiet = await conversation({ updatedSecsAgo: 7200 });
      await message(quiet, { body: 'is anyone there?', secsAgo: 3 * 3600 });

      const rows = await list(owner, '&scope=all');
      expect(rows[quiet], `n=${n}`).toBeTruthy();
      expect((rows[quiet].last_message as Row | null)?.body, `n=${n}`).toBe('is anyone there?');
      expect(rows[quiet].unread_count, `n=${n}`).toBe(1);
      expect((rows[quiet].last_visitor_message as Row | null)?.body, `n=${n}`).toBe('is anyone there?');
      expect(rows[quiet].needs_reply, `n=${n}`).toBe(true);
      expect(rows[busy].handled_by, `n=${n}`).toEqual([owner]);
      expect((rows[busy].last_message as Row).body, `n=${n}`).toBe(`flood ${n}`);
    }
  });

  it('a closed conversation Ali answered, unassigned, stays Ali\'s: Bahar never lists it, also behind 2000 newer messages', async () => {
    const answered = await conversation({ status: 'closed', updatedSecsAgo: 7200 });
    await message(answered, { body: 'help', secsAgo: 3 * 3600 + 10, seen: true });
    await message(answered, { sender: 'agent', senderId: a, body: 'done', secsAgo: 3 * 3600 });
    const busy = await conversation({ assigned: owner });
    await flood(busy, 2000, owner);

    const forBahar = await list(b, '&status=resolved');
    expect(forBahar[answered]).toBeUndefined();
    const forAli = await list(a, '&status=resolved');
    expect(forAli[answered]).toBeTruthy();
    expect(forAli[answered].handled_by).toEqual([a]);
    // Bahar's own closed thread stays hers although only Ali's newer reply is near the top.
    const shared = await conversation({ status: 'closed', updatedSecsAgo: 7300 });
    await message(shared, { sender: 'agent', senderId: b, body: 'first', secsAgo: 4 * 3600 });
    await message(shared, { sender: 'agent', senderId: a, body: 'later', secsAgo: 3 * 3600 });
    expect((await list(b, '&status=resolved'))[shared]?.handled_by).toEqual([a, b].sort());
  });

  it('needs_reply and waiting_since: a customer who writes again after an answer is owed, from the new turn', async () => {
    const again = await conversation();
    await message(again, { body: 'C1', secsAgo: 600 });
    await message(again, { sender: 'agent', senderId: a, body: 'A1', secsAgo: 500 });
    await message(again, { body: 'C2', secsAgo: 400 });
    await message(again, { body: 'C3', secsAgo: 300 });
    const answered = await conversation();
    await message(answered, { body: 'C1', secsAgo: 600 });
    await message(answered, { sender: 'ai', body: 'AI', secsAgo: 500 });
    // Transparent rows never answer: a system notice, a bot menu, a menu tap, a failed delivery, a hand-over line.
    const transparent = await conversation();
    await message(transparent, { body: 'C1', secsAgo: 600 });
    await message(transparent, { sender: 'system', body: 'joined', secsAgo: 550, metadata: { kind: 'routing_agent_joined' } });
    await message(transparent, { sender: 'bot', body: 'menu', secsAgo: 540 });
    await message(transparent, { body: '/start', secsAgo: 530, metadata: { channel_menu_event: 'true' } });
    await message(transparent, { sender: 'agent', senderId: a, body: 'lost', secsAgo: 520, metadata: { channel_delivery: 'failed' } });
    await message(transparent, { sender: 'ai', body: 'a colleague will help', secsAgo: 510, metadata: { handoff: true } });
    // Only open can owe.
    const pending = await conversation({ status: 'pending' });
    await message(pending, { body: 'C1', secsAgo: 600 });

    const rows = await list(owner, '&scope=all&status=all');
    expect(rows[again].needs_reply).toBe(true);
    expect(Date.parse(String(rows[again].waiting_since))).toBeGreaterThan(Date.now() - 450_000);
    expect(Date.parse(String(rows[again].waiting_since))).toBeLessThan(Date.now() - 350_000);
    expect(rows[answered].needs_reply).toBe(false);
    expect(rows[answered].waiting_since).toBeNull();
    expect(rows[transparent].needs_reply).toBe(true);
    expect(Date.parse(String(rows[transparent].waiting_since))).toBeLessThan(Date.now() - 590_000);
    // The menu tap is not the preview, not unread.
    expect((rows[transparent].last_message as Row).sender_type).toBe('ai');
    expect(rows[transparent].unread_count).toBe(1);
    expect(rows[pending].needs_reply).toBe(false);
    expect(rows[pending].waiting_since).toBeNull();
  });

  it('agrees with needsReply.ts on generated fixtures', async () => {
    const kinds: Array<{ sender: string; body: string; metadata: Row }> = [
      { sender: 'contact', body: 'C', metadata: {} },
      { sender: 'contact', body: '', metadata: {} },
      { sender: 'contact', body: 'echo', metadata: { provider_echo: true } },
      { sender: 'contact', body: '', metadata: { attachments: [{ kind: 'voice' }] } },
      { sender: 'agent', body: 'A', metadata: {} },
      { sender: 'agent', body: 'A', metadata: { channel_delivery: 'failed' } },
      { sender: 'agent', body: 'A', metadata: { channel_delivery_skip: 'true' } },
      { sender: 'ai', body: 'AI', metadata: {} },
      { sender: 'ai', body: 'AI', metadata: { handoff: 'true' } },
      { sender: 'system', body: 'S', metadata: { kind: 'x' } },
      { sender: 'bot', body: 'B', metadata: {} },
    ];
    const cases: Array<{ id: string; status: string; msgs: NeedsReplyMessage[] }> = [];
    let seed = 7;
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    for (let i = 0; i < 40; i++) {
      const status = ['open', 'open', 'open', 'pending', 'resolved'][rnd(5)];
      const id = await conversation({ status });
      const msgs: NeedsReplyMessage[] = [];
      const count = 1 + rnd(6);
      for (let j = 0; j < count; j++) {
        const k = kinds[rnd(kinds.length)];
        const secsAgo = 1000 - j * 10;
        await message(id, { sender: k.sender, senderId: k.sender === 'agent' ? a : null, body: k.body, secsAgo, metadata: k.metadata });
        msgs.push({ sender_type: k.sender, body: k.body, metadata: k.metadata, created_at: new Date(Date.now() - secsAgo * 1000).toISOString() });
      }
      cases.push({ id, status, msgs });
    }
    const rows = await list(owner, '&scope=all&status=all');
    for (const c of cases) {
      const row = rows[c.id];
      expect(row, c.id).toBeTruthy();
      expect(row.needs_reply, JSON.stringify(c.msgs)).toBe(computeNeedsReply({ status: c.status, messages: c.msgs }));
      const want = computeWaitingSince({ status: c.status, messages: c.msgs });
      if (want === null) expect(row.waiting_since).toBeNull();
      else expect(Math.abs(Date.parse(String(row.waiting_since)) - Date.parse(want))).toBeLessThan(2000);
    }
  });

  it('another workspace\'s ids give nothing; EXECUTE is service_role\'s only; a second run of 303 changes nothing', async () => {
    const mine = await conversation();
    await message(mine, { body: 'mine', secsAgo: 10 });
    const theirs = await conversation({ workspace: other });
    await message(theirs, { body: 'theirs', secsAgo: 10 });
    const got = await q(`SELECT conversation_id, last_body FROM public.conversation_list_summaries($1, $2::uuid[])`, [ws, [mine, theirs]]);
    expect(got).toEqual([{ conversation_id: mine, last_body: 'mine' }]);

    const acl = await one(`SELECT has_function_privilege('service_role', 'public.conversation_list_summaries(uuid, uuid[])', 'EXECUTE') AS svc,
                                  has_function_privilege('anon', 'public.conversation_list_summaries(uuid, uuid[])', 'EXECUTE') AS anon,
                                  has_function_privilege('authenticated', 'public.conversation_list_summaries(uuid, uuid[])', 'EXECUTE') AS auth`);
    expect(acl).toEqual({ svc: true, anon: false, auth: false });

    const { readFileSync } = await import('node:fs');
    const { applyMigrationSql } = await import('./pgMigrationChain');
    await applyMigrationSql(chain.db, readFileSync('database/migrations/303_conversation_list_summaries.sql', 'utf8'));
    expect(await q(`SELECT conversation_id, last_body FROM public.conversation_list_summaries($1, $2::uuid[])`, [ws, [mine]]))
      .toEqual([{ conversation_id: mine, last_body: 'mine' }]);
  });

  it('a read past DATABASE_MAX_ROWS is paged: every listed id has its summary', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 8; i++) {
      const id = await conversation();
      await message(id, { body: `c${i}`, secsAgo: 100 - i });
      ids.push(id);
    }
    process.env.DATABASE_MAX_ROWS = '3';
    const { closeDataLayer } = await import('../../../server/db/index.js');
    await closeDataLayer();
    try {
      const config = (await import('../../../server/config.js')).loadConfig();
      const { getServiceClient } = await import('../../../server/supabase.js');
      const { readListSummaries } = await import('../../../server/services/conversationListSummaries.js');
      const s = await readListSummaries(getServiceClient(config), ws, ids, 'en' as never);
      expect(s.source).toBe('rpc');
      expect(ids.map((id) => s.lastByConv[id]?.body)).toEqual(ids.map((_, i) => `c${i}`));
    } finally {
      delete process.env.DATABASE_MAX_ROWS;
      await closeDataLayer();
    }
  });
});
