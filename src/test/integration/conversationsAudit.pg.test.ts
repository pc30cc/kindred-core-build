// @vitest-environment node
/**
 * The operator-side conversations API, on a real database built by the whole
 * chain, through the real routes, with DATABASE_MAX_ROWS at 5 so every read
 * the data layer cuts short shows with a handful of rows (audit 2026-11-04):
 *
 *   F2  `assigned_to_me` names the caller, or anyone for a supervisor only.
 *   F3  a contact's conversations are the Inbox's: staff without one get
 *       403 `inbox_not_allowed`; the last message and the count see every
 *       message.
 *   F4  "Delete all conversations" deletes all of them, their notes and
 *       timeline with them, and cancels the replies still waiting to be sent.
 *   F5  a thread's full read is its newest page; `older` pages back to the
 *       start, rows written in the same instant included.
 *   F6  the notes and the timeline keep the plan's retention lock.
 *   F7  a message never describes another workspace's file.
 *   +   the contacts list (and its "N contacts") sees every contact.
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
const state = vi.hoisted(() => ({
  /** Conversation ids the plan's retention locks. */
  locked: new Set<string>(),
}));

vi.mock('../../../server/services/realtime/publish.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/realtime/publish.js')>()),
  publishConversationEvent: async () => ({ ok: true }),
  publishOperatorEvent: async () => undefined,
}));
vi.mock('../../../server/services/push/index.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/push/index.js')>()),
  notifyInboundMessage: async () => undefined,
  notifyHandoff: async () => undefined,
  notifyAssignment: async () => undefined,
}));
vi.mock('../../../server/services/contactChatLocks.js', async (orig) => {
  const real = await orig<typeof import('../../../server/services/contactChatLocks.js')>();
  return {
    ...real,
    conversationLockedNow: async (...args: Parameters<typeof real.conversationLockedNow>) => (state.locked.has(String(args[2]?.id ?? ''))
      ? { locked: true, state: { enabled: true, kb: null, contact: null, member: null, conversation: { limit: 30 } } as never }
      : real.conversationLockedNow(...args)),
  };
});

suite('the operator conversations API, rows past DATABASE_MAX_ROWS (audit 2026-11-04)', () => {
  let chain: FullChainDatabase;
  const q = async (sql: string, params: unknown[] = []): Promise<Row[]> => (await chain.db.query(sql, params)).rows as Row[];
  const one = async (sql: string, params: unknown[] = []): Promise<Row> => (await q(sql, params))[0];

  const owner = randomUUID();
  const a = randomUUID(); // agent
  const b = randomUUID(); // agent
  const lead = randomUUID(); // team_lead
  const seo = randomUUID(); // seo_manager: no Inbox
  const ws = randomUUID();
  const other = randomUUID(); // another workspace
  const otherOwner = randomUUID();

  let app: express.Express;
  const tokens: Record<string, string> = {};
  const as = (user: string) => ({ Authorization: `Bearer ${tokens[user]}` });

  const conversation = async (fields: { assigned?: string | null; contact?: string | null; workspace?: string } = {}) => {
    const id = randomUUID();
    await q(`INSERT INTO public.conversations (id, workspace_id, status, assigned_to, contact_id)
             VALUES ($1, $2, 'open', $3, $4)`, [id, fields.workspace ?? ws, fields.assigned ?? null, fields.contact ?? null]);
    return id;
  };
  /** `n` messages, one second apart, the last one newest; returns their bodies in order. */
  const messages = async (cid: string, n: number, sender = 'contact') => {
    const bodies: string[] = [];
    for (let i = 0; i < n; i++) {
      const body = `m${String(i).padStart(3, '0')}`;
      bodies.push(body);
      await q(`INSERT INTO public.conversation_messages (conversation_id, sender_type, body, created_at)
               VALUES ($1, $2, $3, now() - make_interval(secs => $4))`, [cid, sender, body, n - i]);
    }
    return bodies;
  };

  beforeAll(async () => {
    chain = await createFullChainDatabase(DSN!, `conv_audit_${Date.now()}`);
    for (const [id, name] of [[owner, 'Owner'], [a, 'Ali'], [b, 'Bahar'], [lead, 'Leila'], [seo, 'Seo'], [otherOwner, 'Other']]) {
      await q(`INSERT INTO public.profiles (id, email, full_name) VALUES ($1, $2, $3)`, [id, `p-${id.slice(0, 8)}@test.local`, name]);
    }
    await q(`INSERT INTO public.workspaces (id, name, slug, owner_id) VALUES ($1, 'Acme', $2, $3)`, [ws, `ws-${ws.slice(0, 8)}`, owner]);
    await q(`INSERT INTO public.workspaces (id, name, slug, owner_id) VALUES ($1, 'Other', $2, $3)`, [other, `ws-${other.slice(0, 8)}`, otherOwner]);
    await q(`INSERT INTO public.workspace_members (workspace_id, user_id, role) VALUES
               ($1, $2, 'owner'), ($1, $3, 'agent'), ($1, $4, 'agent'), ($1, $5, 'team_lead'), ($1, $6, 'seo_manager')`,
    [ws, owner, a, b, lead, seo]);
    await q(`INSERT INTO public.workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')`, [other, otherOwner]);

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
    const { conversationNotesRouter } = await import('../../../server/routes/conversationNotes.js');
    const { contactsRouter } = await import('../../../server/routes/contacts.js');
    const { createSession } = await import('../../../server/services/auth/sessions.js');
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => { Object.assign(req, { serverConfig: config }); next(); });
    app.use('/api/conversations', conversationsRouter);
    app.use('/api/conversations', conversationNotesRouter);
    app.use('/api/contacts', contactsRouter);
    for (const id of [owner, a, b, lead, seo, otherOwner]) {
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
    state.locked.clear();
    await q(`DELETE FROM public.conversations WHERE workspace_id IN ($1, $2)`, [ws, other]);
    await q(`DELETE FROM public.conversation_notes WHERE workspace_id = $1`, [ws]);
    await q(`DELETE FROM public.conversation_events WHERE workspace_id = $1`, [ws]);
    await q(`DELETE FROM public.channel_jobs WHERE workspace_id = $1`, [ws]);
    await q(`DELETE FROM public.contacts WHERE workspace_id = $1`, [ws]);
  });

  it('F2 assigned_to_me: the caller\'s own id, or anyone\'s for a supervisor; an agent naming a colleague is refused', async () => {
    const bahars = await conversation({ assigned: b });
    const alis = await conversation({ assigned: a });
    const list = (user: string, id: string) => request(app).get(`/api/conversations?workspace_id=${ws}&assigned_to_me=${id}`).set(as(user));

    const peek = await list(a, b);
    expect(peek.status).toBe(403);
    expect(peek.body).toEqual({ error: 'assignment_scope_not_allowed' });

    const mine = await list(a, a);
    expect(mine.status).toBe(200);
    expect((mine.body.conversations as Row[]).map((r) => r.id)).toEqual([alis]);

    for (const sup of [lead, owner]) {
      const res = await list(sup, b);
      expect(res.status).toBe(200);
      expect((res.body.conversations as Row[]).map((r) => r.id)).toEqual([bahars]);
    }
  });

  it('F3 a contact\'s conversations: 403 inbox_not_allowed without the Inbox; the last message and count read every message', async () => {
    const contact = String((await one(`INSERT INTO public.contacts (workspace_id, name) VALUES ($1, 'Sara') RETURNING id`, [ws])).id);
    const cid = await conversation({ contact });
    const bodies = await messages(cid, 8);

    const refused = await request(app).get(`/api/contacts/${contact}/conversations`).set(as(seo));
    expect(refused.status).toBe(403);
    expect(refused.body).toEqual({ error: 'inbox_not_allowed' });

    const res = await request(app).get(`/api/contacts/${contact}/conversations`).set(as(a));
    expect(res.status).toBe(200);
    const [row] = res.body.conversations as Row[];
    expect(row.message_count).toBe(8);
    expect(row.last_message_body).toBe(bodies[7]);
    // The contact itself stays readable to every member.
    expect((await request(app).get(`/api/contacts/${contact}`).set(as(seo))).status).toBe(200);
  });

  it('the contacts list (and its total) sees every contact', async () => {
    for (let i = 0; i < 12; i++) await q(`INSERT INTO public.contacts (workspace_id, name) VALUES ($1, $2)`, [ws, `c${i}`]);
    const res = await request(app).get(`/api/contacts?workspace_id=${ws}`).set(as(a));
    expect(res.status).toBe(200);
    expect(res.body.contacts).toHaveLength(12);
    expect(new Set((res.body.contacts as Row[]).map((c) => c.id)).size).toBe(12);
  });

  it('F4 delete all: every conversation, with its notes and timeline; pending channel replies cancelled; another workspace untouched', async () => {
    const cids: string[] = [];
    for (let i = 0; i < 12; i++) {
      const cid = await conversation();
      cids.push(cid);
      await messages(cid, 2);
      await q(`INSERT INTO public.conversation_notes (workspace_id, conversation_id, author_id, body) VALUES ($1, $2, $3, 'note')`, [ws, cid, a]);
      await q(`INSERT INTO public.conversation_events (workspace_id, conversation_id, event_type, actor_type) VALUES ($1, $2, 'created', 'system')`, [ws, cid]);
    }
    const job = String((await one(`INSERT INTO public.channel_jobs (provider, job_type, workspace_id, payload)
      VALUES ('telegram', 'telegram_outbound_message', $1, jsonb_build_object('conversation_id', $2::text, 'message_id', gen_random_uuid()::text))
      RETURNING id`, [ws, cids[11]])).id);
    const kept = await conversation({ workspace: other });

    // Not for an agent.
    expect((await request(app).delete('/api/conversations').set(as(a)).send({ workspace_id: ws })).status).toBe(403);

    const res = await request(app).delete('/api/conversations').set(as(owner)).send({ workspace_id: ws });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: 12 });
    expect(await q(`SELECT 1 FROM public.conversations WHERE workspace_id = $1`, [ws])).toHaveLength(0);
    expect(await q(`SELECT 1 FROM public.conversation_messages WHERE conversation_id = ANY($1::uuid[])`, [cids])).toHaveLength(0);
    expect(await q(`SELECT 1 FROM public.conversation_notes WHERE workspace_id = $1`, [ws])).toHaveLength(0);
    expect(await q(`SELECT 1 FROM public.conversation_events WHERE workspace_id = $1`, [ws])).toHaveLength(0);
    expect(await one(`SELECT status, last_error FROM public.channel_jobs WHERE id = $1`, [job])).toEqual({ status: 'cancelled', last_error: 'conversation_deleted' });
    expect(await q(`SELECT 1 FROM public.conversations WHERE id = $1`, [kept])).toHaveLength(1);

    // Nothing left: 0, not an error.
    expect((await request(app).delete('/api/conversations').set(as(owner)).send({ workspace_id: ws })).body).toEqual({ deleted: 0 });
  });

  it('F5 a long thread\'s full read is its newest page, and `older` pages back to the start (rows of one instant included)', async () => {
    const cid = await conversation();
    const bodies = await messages(cid, 6);
    // Three rows written in the same instant, the newest of the thread.
    await q(`INSERT INTO public.conversation_messages (conversation_id, sender_type, body)
             SELECT $1, 'contact', 'same' || g FROM generate_series(1, 3) g`, [cid]);
    const all = [...bodies, 'same1', 'same2', 'same3'];

    const seen: string[] = [];
    let path = `/api/conversations/${cid}/messages`;
    for (let i = 0; i < 5; i++) {
      const res = await request(app).get(path).set(as(a));
      expect(res.status).toBe(200);
      const page = (res.body.messages as Row[]).map((m) => String(m.body));
      expect(page.length).toBeLessThanOrEqual(5);
      seen.unshift(...page);
      if (i === 0) {
        // The newest five, in thread order (the three of one instant in id order).
        expect(page.slice(0, 2)).toEqual([bodies[4], bodies[5]]);
        expect(new Set(page.slice(2))).toEqual(new Set(['same1', 'same2', 'same3']));
        expect(res.body.sync.mode).toBe('full');
      }
      const older = res.body.older as { before: string; before_id: string } | null;
      if (!older) break;
      path = `/api/conversations/${cid}/messages?before=${encodeURIComponent(older.before)}&before_id=${older.before_id}`;
    }
    expect(seen).toHaveLength(all.length);
    expect(new Set(seen)).toEqual(new Set(all));
    expect(seen.slice(0, 6)).toEqual(bodies);

    expect((await request(app).get(`/api/conversations/${cid}/messages?before=yesterday&before_id=x`).set(as(a))).status).toBe(400);
  });

  it('F6 the notes (list, add, edit) and the timeline of a chat the plan locked: 403 conversation_locked; deleting a note stays allowed', async () => {
    const cid = await conversation();
    const note = String((await one(`INSERT INTO public.conversation_notes (workspace_id, conversation_id, author_id, body) VALUES ($1, $2, $3, 'before') RETURNING id`, [ws, cid, a])).id);
    state.locked.add(cid);
    for (const res of [
      await request(app).get(`/api/conversations/${cid}/notes?workspace_id=${ws}`).set(as(a)),
      await request(app).post(`/api/conversations/${cid}/notes`).set(as(a)).send({ workspace_id: ws, body: 'new' }),
      await request(app).patch(`/api/conversations/${cid}/notes/${note}`).set(as(a)).send({ workspace_id: ws, body: 'edited' }),
      await request(app).get(`/api/conversations/${cid}/timeline?workspace_id=${ws}`).set(as(a)),
    ]) {
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('conversation_locked');
    }
    expect(await q(`SELECT body FROM public.conversation_notes WHERE conversation_id = $1`, [cid])).toEqual([{ body: 'before' }]);
    expect((await request(app).delete(`/api/conversations/${cid}/notes/${note}?workspace_id=${ws}`).set(as(a))).status).toBe(200);

    state.locked.clear();
    expect((await request(app).get(`/api/conversations/${cid}/notes?workspace_id=${ws}`).set(as(a))).status).toBe(200);
    expect((await request(app).get(`/api/conversations/${cid}/timeline?workspace_id=${ws}`).set(as(a))).status).toBe(200);
  });

  it('F7 another workspace\'s file: not kept on the message sent, never described by the thread or the list', async () => {
    const theirs = randomUUID();
    await q(`INSERT INTO public.conversation_attachments (id, workspace_id, storage_provider, storage_path, file_name, mime_type, size_bytes, uploaded_by_type, status)
             VALUES ($1, $2, 'local', $3, 'secret-contract.pdf', 'application/pdf', 4242, 'agent', 'uploaded')`,
    [theirs, other, `workspace/${other}/attachments/${theirs}`]);
    const cid = await conversation({ assigned: a });

    const sent = await request(app).post('/api/conversations/send-message').set(as(a))
      .send({ workspace_id: ws, conversation_id: cid, body: 'see file', attachment_id: theirs });
    expect(sent.status).toBe(200);
    const stored = await one(`SELECT metadata FROM public.conversation_messages WHERE conversation_id = $1 AND sender_type = 'agent'`, [cid]);
    expect((stored.metadata as Row).attachment_id).toBeUndefined();
    // Their file is still theirs, unbound.
    expect(await one(`SELECT status, message_id FROM public.conversation_attachments WHERE id = $1`, [theirs])).toEqual({ status: 'uploaded', message_id: null });

    // A row that names it anyway (written before this fix): nothing of it is read back.
    await q(`INSERT INTO public.conversation_messages (conversation_id, sender_type, sender_id, body, metadata)
             VALUES ($1, 'agent', $2, '', jsonb_build_object('attachment_id', $3::text))`, [cid, a, theirs]);
    const thread = await request(app).get(`/api/conversations/${cid}/messages`).set(as(a));
    expect(thread.status).toBe(200);
    expect(JSON.stringify(thread.body)).not.toContain('secret-contract.pdf');
    for (const m of thread.body.messages as Row[]) expect(m.attachments).toBeUndefined();
    const list = await request(app).get(`/api/conversations?workspace_id=${ws}`).set(as(a));
    const row = (list.body.conversations as Row[]).find((r) => r.id === cid)!;
    expect(JSON.stringify(row)).not.toContain('application/pdf');
  });
});
