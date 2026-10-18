// @vitest-environment node
/**
 * Simple billing phase 4 (design §4) — contacts over the plan's max_contacts,
 * chats older than its data_retention_days, the full monthly chat quota and
 * the widget's KB reads, against a database built by the whole chain
 * (migration 265 included), through the real data layer (postgres-only) and
 * the real routes:
 *
 *   - kill switch off: every route behaves as before;
 *   - switch on: the contacts list redacts the contacts the plan does not
 *     keep (spam and anonymous visitors never count, D1), exactly as
 *     billing_is_locked; opening, editing, its chats and its IP answer 403
 *     contact_locked; deleting stays open and unlocks the next contact at
 *     once;
 *   - the inbox lists a chat past retention without its content and refuses
 *     to read, answer, change, claim or take it over (403
 *     conversation_locked); a locked contact inside an unlocked chat is
 *     joined redacted (D4); a message from the visitor reopens the chat (D2);
 *   - the widget: help articles over max_kb_articles are left out, feedback
 *     on one is 404; a full monthly quota is announced (`quota_full`) and the
 *     leave-a-message form is accepted, tagged over_quota (D10) — only while
 *     the switch is on.
 *
 * Only authentication and the widget token/origin checks are stubbed.
 * Driven by TEST_DATABASE_URL; skipped without it.
 */
import { afterAll, beforeAll, describe, expect, it, onTestFinished as onAfterTest, vi } from 'vitest';
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
vi.mock('../../../server/services/widget/security.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../server/services/widget/security.js')>();
  const pass = (req: { _widgetWorkspaceId?: string }, _res: unknown, next: () => void) => {
    req._widgetWorkspaceId = who.workspaceId;
    next();
  };
  return { ...real, enforceWidgetToken: pass, enforceOrigin: pass, widgetRateLimit: () => (_q: unknown, _s: unknown, n: () => void) => n() };
});

type Row = Record<string, unknown>;

suite('contacts, chats and widget over the plan (phase 4)', () => {
  let chain: FullChainDatabase;
  let config: never;
  let app: express.Express;
  let state: typeof import('../../../server/services/billing/locks/state.js');
  let locks: typeof import('../../../server/services/contactChatLocks.js');
  const q = async (sql: string, p: unknown[] = []) => (await chain.db.query(sql, p)).rows as Row[];
  const one = async (sql: string, p: unknown[] = []) => (await q(sql, p))[0];

  let ws = '';
  let owner = '';
  // Oldest first. The plan keeps two contacts: c1 and c2. The anonymous
  // visitor and the spam contact never count; c3 and c4 are locked.
  const ct = { c1: randomUUID(), c2: randomUUID(), anon: randomUUID(), spam: randomUUID(), c3: randomUUID(), c4: randomUUID() };
  const conv = { old: randomUUID(), fresh: randomUUID() };
  const art = { a1: randomUUID(), a2: randomUUID() };

  async function switchTo(on: boolean) {
    await q(`INSERT INTO public.billing_settings (edition, locks_enabled) VALUES ('international', $1)
             ON CONFLICT (edition) DO UPDATE SET locks_enabled = EXCLUDED.locks_enabled`, [on]);
    state.clearLockStateCache();
  }

  const list = async () => (await request(app).get('/api/contacts').query({ workspace_id: ws })).body.contacts as Row[];
  const byId = (rows: Row[], id: string) => rows.find((r) => r.id === id)!;
  const inbox = async () =>
    (await request(app).get('/api/conversations').query({ workspace_id: ws, queue: 'main', status: 'all', scope: 'all' })).body.conversations as Row[];

  beforeAll(async () => {
    chain = await createFullChainDatabase(DSN!, `contact_chat_locks_${Date.now()}`);
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
       VALUES ('Small', 'small-cc', $1, $2, $3, true, false, false, 10) RETURNING id`,
      [
        JSON.stringify({ USD: { monthly: 900, yearly: 9000 } }),
        JSON.stringify({ max_contacts: 2, data_retention_days: 30, max_conversations: 1, max_kb_articles: 1 }),
        JSON.stringify({ contacts: true, contact_edit: true, chat_widget: true, knowledge_base: true, contact_ip_visibility: true }),
      ])).id);

    owner = randomUUID();
    await q(`INSERT INTO public.profiles (id, email, full_name) VALUES ($1, $2, 'Owner')`, [owner, `owner-${owner.slice(0, 6)}@test.local`]);
    ws = randomUUID();
    who.userId = owner;
    who.workspaceId = ws;
    await q(`INSERT INTO public.workspaces (id, name, slug, owner_id) VALUES ($1, 'Acme', $2, $3)`, [ws, `acme-${ws.slice(0, 8)}`, owner]);
    await q(`INSERT INTO public.workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner') ON CONFLICT DO NOTHING`, [ws, owner]);
    await q(`INSERT INTO public.workspace_subscriptions (workspace_id, plan_id, status, billing_interval, provider_name, current_period_start, current_period_end)
             VALUES ($1, $2, 'active', 'monthly', 'account', now() - interval '10 days', now() + interval '20 days')
             ON CONFLICT (workspace_id) DO UPDATE SET plan_id = EXCLUDED.plan_id, status = 'active'`, [ws, small]);

    const contacts: Array<[string, string | null, string | null, string, boolean, Row]> = [
      [ct.c1, 'Ada', 'ada@example.com', '2026-01-01T00:00:00Z', false, {}],
      [ct.c2, 'Ben', 'ben@example.com', '2026-01-02T00:00:00Z', false, {}],
      [ct.anon, null, null, '2026-01-03T00:00:00Z', false, { anonymous: true, source: 'widget' }],
      [ct.spam, 'Spammer', 'spam@example.com', '2026-01-04T00:00:00Z', true, {}],
      [ct.c3, 'Cleo', 'cleo@example.com', '2026-01-05T00:00:00Z', false, { company: 'Cleo Ltd' }],
      [ct.c4, 'Dan', 'dan@example.com', '2026-01-06T00:00:00Z', false, {}],
    ];
    for (const [i, [id, name, email, at, spam, meta]] of contacts.entries()) {
      await q(`INSERT INTO public.contacts (id, workspace_id, name, email, phone, notes, tags, metadata, is_spam, created_at)
               VALUES ($1, $2, $3, $4, $5, 'a note', ARRAY['vip'], $6, $7, $8)`,
        [id, ws, name, email, email ? `+1555000010${i}` : null, JSON.stringify(meta), spam, at]);
    }
    // One chat with no activity for 60 days (past the 30-day retention), and
    // one this month (the plan's monthly quota is 1), of a locked contact.
    await q(`INSERT INTO public.conversations (id, workspace_id, contact_id, status, subject, created_at, updated_at)
             VALUES ($1, $2, $3, 'open', 'Old question', now() - interval '60 days', now() - interval '60 days')`, [conv.old, ws, ct.c1]);
    await q(`INSERT INTO public.conversations (id, workspace_id, contact_id, status, subject)
             VALUES ($1, $2, $3, 'open', 'New question')`, [conv.fresh, ws, ct.c3]);
    await q(`INSERT INTO public.conversation_messages (conversation_id, sender_type, body, created_at)
             VALUES ($1, 'agent', 'old secret answer', now() - interval '60 days')`, [conv.old]);
    // Keep the chat's last activity 60 days back.
    await q(`UPDATE public.conversations SET updated_at = now() - interval '60 days' WHERE id = $1`, [conv.old]);
    await q(`INSERT INTO public.conversation_messages (conversation_id, sender_type, body) VALUES ($1, 'contact', 'hello there')`, [conv.fresh]);

    for (const [id, slug, at] of [[art.a1, 'alpha', '2026-01-01T00:00:00Z'], [art.a2, 'beta', '2026-01-02T00:00:00Z']]) {
      await q(`INSERT INTO public.knowledge_base_articles (id, workspace_id, slug, locale, title, content, excerpt, status, created_at)
               VALUES ($1, $2, $3, 'en', $4, 'Refund policy text.', 'refund help', 'published', $5)`, [id, ws, slug, `${slug} guide`, at]);
    }

    const { loadConfig } = await import('../../../server/config.js');
    config = loadConfig() as never;
    state = await import('../../../server/services/billing/locks/state.js');
    locks = await import('../../../server/services/contactChatLocks.js');
    const { contactsRouter } = await import('../../../server/routes/contacts.js');
    const { conversationsRouter } = await import('../../../server/routes/conversations.js');
    const { widgetRouter } = await import('../../../server/routes/widget.js');
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => { (req as unknown as { serverConfig: unknown }).serverConfig = config; next(); });
    app.use('/api/contacts', contactsRouter);
    app.use('/api/conversations', conversationsRouter);
    app.use('/api/widget', widgetRouter);
  }, 600_000);

  afterAll(async () => {
    const { closeDataLayer } = await import('../../../server/db/index.js');
    await closeDataLayer().catch(() => undefined);
    await chain?.drop();
  });

  it('switch off: no contact or chat is locked, every route answers as before', async () => {
    await switchTo(false);
    const rows = await list();
    expect(rows).toHaveLength(6);
    expect(rows.every((r) => r.locked === false)).toBe(true);
    expect(byId(rows, ct.c3).email).toBe('cleo@example.com');
    expect((await request(app).get(`/api/contacts/${ct.c3}`)).status).toBe(200);
    const convs = await inbox();
    expect(convs.find((c) => c.id === conv.old)?.locked_by_retention).toBe(false);
    expect((await request(app).get(`/api/conversations/${conv.old}/messages`)).status).toBe(200);
    const kb = await request(app).get('/api/widget/kb').query({ workspace_id: ws });
    expect((kb.body.articles as Row[]).map((a) => a.slug).sort()).toEqual(['alpha', 'beta']);
  });

  it('switch on: the contacts list redacts exactly the contacts billing_is_locked names (D1)', async () => {
    await switchTo(true);
    const rows = await list();
    expect(rows).toHaveLength(6);
    const lockedIds = rows.filter((r) => r.locked).map((r) => r.id).sort();
    expect(lockedIds).toEqual([ct.c3, ct.c4].sort());
    for (const id of Object.values(ct)) {
      const sql = (await one(`SELECT public.billing_is_locked($1, 'contact', $2) AS l`, [ws, id])).l;
      expect(byId(rows, id).locked).toBe(sql);
    }
    const c3 = byId(rows, ct.c3);
    expect(c3).toMatchObject({ id: ct.c3, workspace_id: ws, name: null, email: null, phone: null, notes: null, tags: [], metadata: {} });
    expect(c3.created_at).toBeTruthy();
    expect(byId(rows, ct.c1)).toMatchObject({ locked: false, name: 'Ada', email: 'ada@example.com' });
    expect(byId(rows, ct.anon).locked).toBe(false);
    expect(byId(rows, ct.spam).locked).toBe(false);
  });

  it('a locked contact cannot be opened, edited, looked up or have its chats read', async () => {
    const get = await request(app).get(`/api/contacts/${ct.c3}`);
    expect(get.status).toBe(403);
    expect(get.body).toMatchObject({ error: 'contact_locked', upgrade_required: true, limit: 2 });
    const patch = await request(app).patch(`/api/contacts/${ct.c3}`).send({ name: 'Changed' });
    expect(patch.status).toBe(403);
    expect(patch.body.error).toBe('contact_locked');
    expect((await one(`SELECT name FROM public.contacts WHERE id = $1`, [ct.c3])).name).toBe('Cleo');
    expect((await request(app).get(`/api/contacts/${ct.c3}/conversations`)).status).toBe(403);
    expect((await request(app).get(`/api/contacts/${ct.c3}/ip`)).body.error).toBe('contact_locked');
    // An unlocked contact still opens.
    const ok = await request(app).get(`/api/contacts/${ct.c1}`);
    expect(ok.status).toBe(200);
    expect(ok.body.contact).toMatchObject({ id: ct.c1, locked: false, name: 'Ada' });
  });

  it('the visitors panel shows a locked contact redacted, an unlocked one as before (and nothing changes with the switch off)', async () => {
    const { getVisitorIntelligence } = await import('../../../server/services/visitors/intelligence.js');
    const session = async (contactId: string) => String((await one(
      `INSERT INTO public.visitor_sessions (workspace_id, visitor_id, contact_id) VALUES ($1, $2, $3) RETURNING id`,
      [ws, randomUUID(), contactId])).id);
    const lockedSession = await session(ct.c3);
    const openSession = await session(ct.c1);
    const locked = await getVisitorIntelligence(config, ws, lockedSession, { viewerRole: 'owner' });
    expect(locked?.contact).toMatchObject({ id: ct.c3, name: null, email: null, metadata: {}, locked: true });
    expect(JSON.stringify(locked)).not.toContain('cleo@example.com');
    expect(JSON.stringify(locked)).not.toContain('Cleo Ltd');
    const open = await getVisitorIntelligence(config, ws, openSession, { viewerRole: 'owner' });
    expect(open?.contact).toMatchObject({ id: ct.c1, name: 'Ada', email: 'ada@example.com' });
    expect(open?.contact).not.toHaveProperty('locked');
    expect(open?.contact).not.toHaveProperty('created_at');
    await switchTo(false);
    try {
      const off = await getVisitorIntelligence(config, ws, lockedSession, { viewerRole: 'owner' });
      expect(off?.contact).toMatchObject({ id: ct.c3, name: 'Cleo', email: 'cleo@example.com' });
      expect(off?.contact).not.toHaveProperty('locked');
      expect(off?.contact).not.toHaveProperty('is_spam');
    } finally {
      await switchTo(true);
    }
  });

  it("an unlocked contact's chat past retention is listed without its content", async () => {
    const res = await request(app).get(`/api/contacts/${ct.c1}/conversations`);
    expect(res.status).toBe(200);
    const old = (res.body.conversations as Row[]).find((c) => c.id === conv.old)!;
    expect(old).toMatchObject({ locked_by_retention: true, subject: null, last_message_body: null, message_count: 0 });
    expect(JSON.stringify(res.body)).not.toContain('old secret answer');
  });

  it('inbox: a chat past retention is listed locked without content; a locked contact is joined redacted (D4)', async () => {
    const convs = await inbox();
    const old = convs.find((c) => c.id === conv.old)!;
    expect(old).toMatchObject({ locked_by_retention: true, retention_days: 30, last_message: null, last_visitor_message: null, subject: null });
    expect(JSON.stringify(old)).not.toContain('old secret answer');
    const fresh = convs.find((c) => c.id === conv.fresh)!;
    expect(fresh.locked_by_retention).toBe(false);
    expect((fresh.last_message as Row).body).toBe('hello there');
    const contact = fresh.contacts as Row;
    expect(contact).toMatchObject({ id: ct.c3, locked: true, name: null, email: null });
    // Only the columns the list always carried (plus `locked`).
    expect(contact).not.toHaveProperty('phone');
    expect(contact).not.toHaveProperty('is_spam');
    expect((old.contacts as Row)).toMatchObject({ id: ct.c1, locked: false, name: 'Ada' });
    // GET /:id has the same shape.
    const one_ = await request(app).get(`/api/conversations/${conv.old}`).query({ workspace_id: ws });
    expect(one_.body.conversation).toMatchObject({ id: conv.old, locked_by_retention: true, last_message: null });
  });

  it('a chat past retention cannot be read, answered, changed, claimed or taken over', async () => {
    const msgs = await request(app).get(`/api/conversations/${conv.old}/messages`);
    expect(msgs.status).toBe(403);
    expect(msgs.body).toMatchObject({ error: 'conversation_locked', upgrade_required: true, retention_days: 30 });
    const send = await request(app).post('/api/conversations/send-message')
      .send({ conversation_id: conv.old, workspace_id: ws, body: 'are you there?' });
    expect(send.status).toBe(403);
    const patch = await request(app).patch(`/api/conversations/${conv.old}`).send({ workspace_id: ws, status: 'resolved' });
    expect(patch.status).toBe(403);
    expect((await request(app).post(`/api/conversations/${conv.old}/claim`).send({ workspace_id: ws })).status).toBe(403);
    expect((await request(app).post(`/api/conversations/${conv.old}/take-over`).send({ workspaceId: ws })).status).toBe(403);
    const row = await one(`SELECT status, assigned_to, (updated_at < now() - interval '59 days') AS still_old FROM public.conversations WHERE id = $1`, [conv.old]);
    expect(row).toMatchObject({ status: 'open', assigned_to: null, still_old: true });
    expect((await one(`SELECT count(*)::int AS n FROM public.conversation_messages WHERE conversation_id = $1`, [conv.old])).n).toBe(1);
    // The active chat of a locked contact stays fully usable (D4).
    expect((await request(app).get(`/api/conversations/${conv.fresh}/messages`)).status).toBe(200);
  });

  it('widget: an article over max_kb_articles is left out, and feedback on it is 404', async () => {
    const kb = await request(app).get('/api/widget/kb').query({ workspace_id: ws });
    expect((kb.body.articles as Row[]).map((a) => a.slug)).toEqual(['alpha']);
    const help = await request(app).get('/api/widget/help-articles').query({ workspace_id: ws, search: 'guide' });
    expect((help.body.articles as Row[]).map((a) => a.slug)).toEqual(['alpha']);
    const vote = await request(app).post('/api/widget/kb/articles/beta/feedback').query({ workspace_id: ws }).send({ rating: 'up' });
    expect(vote.status).toBe(404);
    const ok = await request(app).post('/api/widget/kb/articles/alpha/feedback').query({ workspace_id: ws }).send({ rating: 'up' });
    expect(ok.status).not.toBe(404);
  });

  it('widget: a full monthly quota is announced and the leave-a-message form is still accepted (D10)', async () => {
    const used = await one(`SELECT conversations_count AS n FROM public.workspace_usage_counters
                            WHERE workspace_id = $1 AND period = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM')`, [ws]);
    expect(Number(used.n)).toBe(1);
    const avail = await (await import('../../../server/services/widget/availability.js')).resolveConversationQuotaFull(config, ws);
    expect(avail).toBe(true);
    const res = await request(app).post('/api/widget/offline-messages')
      .send({ workspace_id: ws, message: 'Please call me back', email: 'new@example.com', name: 'Nia' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, captured: true, over_quota: true, transitioning: false });
    const row = await one(`SELECT tags FROM public.conversations WHERE id = $1`, [res.body.conversation_id]);
    expect(row.tags).toEqual(['offline', 'over_quota']);
    // A first message over the quota is still refused (the form takes it).
    await q(`INSERT INTO public.widget_settings (workspace_id, enabled) VALUES ($1, true)
             ON CONFLICT (workspace_id) DO UPDATE SET enabled = true`, [ws]);
    // A direct SQL write publishes no widget invalidation (the settings API
    // does), and the inbox reads above already cached this workspace's widget
    // snapshot without a widget_settings row.
    (await import('../../../server/services/widget/configSnapshot.js')).__resetWidgetConfigCachesForTests();
    const cfg = await request(app).get('/api/widget/config').query({ workspace_id: ws });
    expect(cfg.status).toBe(200);
    expect(cfg.body.availability.quota_full).toBe(true);
    const first = await request(app).post('/api/widget/message').send({ workspace_id: ws, message: 'hi', visitor_id: 'v-quota' });
    expect(first.status).toBe(403);
    expect(first.body.feature).toBe('max_conversations');
  });

  it('switch off: the quota is not announced and the form is refused over the quota, as before', async () => {
    await switchTo(false);
    onAfterTest(() => switchTo(true));
    const avail = await (await import('../../../server/services/widget/availability.js')).resolveConversationQuotaFull(config, ws);
    expect(avail).toBeNull();
    const cfg = await request(app).get('/api/widget/config').query({ workspace_id: ws });
    expect(cfg.status).toBe(200);
    expect(cfg.body.availability).not.toHaveProperty('quota_full');
    const res = await request(app).post('/api/widget/offline-messages')
      .send({ workspace_id: ws, message: 'Another message', email: 'other@example.com' });
    expect(res.status).toBe(403);
    expect(res.body.feature).toBe('max_conversations');
  });

  it('a message from the visitor reopens a chat past retention (D2)', async () => {
    // The widget, channel and support writers touch updated_at as they store
    // the visitor's message (no trigger does it for them).
    await q(`INSERT INTO public.conversation_messages (conversation_id, sender_type, body) VALUES ($1, 'contact', 'I am back')`, [conv.old]);
    await q(`UPDATE public.conversations SET updated_at = now() WHERE id = $1`, [conv.old]);
    const msgs = await request(app).get(`/api/conversations/${conv.old}/messages`);
    expect(msgs.status).toBe(200);
    const convs = await inbox();
    expect(convs.find((c) => c.id === conv.old)?.locked_by_retention).toBe(false);
  });

  it('deleting stays open for a locked contact, and a delete unlocks the next contact at once', async () => {
    // c3, c4 and the two contacts the form captures above are over the limit.
    const lockedState = await locks.resolveContactChatLocks(config, ws);
    expect(lockedState.contact?.locked).toBe(4);
    expect((await request(app).get(`/api/contacts/${ct.c3}`)).status).toBe(403);
    expect((await request(app).delete(`/api/contacts/${ct.c4}`)).status).toBe(200);
    expect((await request(app).delete(`/api/contacts/${ct.c1}`)).status).toBe(200);
    // c3 was locked; with c1 gone it is within the plan's two, without waiting for the cache.
    const get = await request(app).get(`/api/contacts/${ct.c3}`);
    expect(get.status).toBe(200);
    expect(get.body.contact).toMatchObject({ id: ct.c3, name: 'Cleo', locked: false });
    const rows = await list();
    for (const r of rows) {
      const sql = (await one(`SELECT public.billing_is_locked($1, 'contact', $2) AS l`, [ws, r.id])).l;
      expect(r.locked).toBe(sql);
    }
    expect(rows.filter((r) => r.locked)).toHaveLength(2);
  });
});
