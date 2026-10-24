// @vitest-environment node
/**
 * The greeting the visitor saw before their first message (one current
 * conversation per visitor, 2026-10-24: POST /api/widget/message with
 * `ai_intro`), end to end on a real database built by the whole chain,
 * through the real route, the real ensure_active_conversation (072), the
 * real push dispatcher and the real routing:
 *
 *   I1  the conversation is born the AI's: p_metadata {channel_thread_key,
 *       ai_state 'ai_managed', source 'ai_agent_intro'} applied on INSERT
 *       (never managed_by_ai); the server's greeting is stored before the
 *       visitor's row (created_at order), echoed as intro_message, logged
 *       in ai_agent_intro_log; the team's phones are not told
 *       (push_dispatch_log: dispatch.ts reads ai_state) and routing gives it
 *       to nobody (the AI answers it: the engine is asked);
 *   I2  the same first message without ai_intro: no greeting, no AI state,
 *       and the owner's phone is told (the push path is live here, so I1's
 *       silence is the greeting's doing);
 *   I3  a retry of the greeted first message (same client id) matches the
 *       thread by its key: no second conversation, greeting or row, and its
 *       metadata is not touched again.
 *
 * The AI's platform gate, its provider check and its engine, and the push
 * transport (FCM), are stand-ins. Driven by TEST_DATABASE_URL; skipped
 * without it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { createFullChainDatabase, type FullChainDatabase } from './fullChainDatabase';

const DSN = process.env.TEST_DATABASE_URL;
const suite = DSN ? describe : describe.skip;

type Row = Record<string, unknown>;
type Next = () => void;
const state = vi.hoisted(() => ({
  visitor: 'visitor-1' as string,
  aiRuns: [] as Array<Record<string, unknown>>,
  sent: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../../server/services/widget/security.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/widget/security.js')>()),
  enforceWidgetToken: (req: { query?: Row; body?: Row; _widgetWorkspaceId?: string }, _res: unknown, next: Next) => {
    const named = req.query?.workspace_id ?? req.body?.workspace_id;
    if (typeof named === 'string') req._widgetWorkspaceId = named;
    next();
  },
  enforceOrigin: (_req: unknown, _res: unknown, next: Next) => next(),
}));
vi.mock('../../../server/services/widget/visitorIdentity.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/widget/visitorIdentity.js')>()),
  readVisitorCookie: () => ({ v: state.visitor }),
  resolveVisitorIdentity: () => ({ visitorId: state.visitor, isNew: false }),
}));
vi.mock('../../../server/services/widget/crossWidgetIdentity.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/widget/crossWidgetIdentity.js')>()),
  resolveSessionNetworkContext: async () => ({}),
  ensureVisitorSessionRow: async () => null,
  issueContinuityCookieForContact: async () => undefined,
}));
vi.mock('../../../server/services/realtime/publish.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/realtime/publish.js')>()),
  publishConversationEvent: async () => ({ ok: true }),
  publishOperatorEvent: async () => undefined,
}));
// The AI is on for visitors and has a provider; its turn is not this suite's.
vi.mock('../../../server/services/ai-agent/platformGuards.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/ai-agent/platformGuards.js')>()),
  isAutoAnswerAllowedForWorkspace: async () => ({ allowed: true }),
}));
vi.mock('../../../server/services/ai-agent/visitorAiSnapshot.js', () => ({
  resolveVisitorAiSnapshot: async () => ({ visitorFacing: true, providerReady: true, introCapable: true, reason: 'ok' }),
}));
vi.mock('../../../server/services/ai-agent/engine.js', () => ({
  maybeRunAiAssistantAfterVisitorMessage: async (_c: unknown, input: Record<string, unknown>) => {
    state.aiRuns.push(input);
    return { ran: false, action: 'skipped', reason: 'test', runId: 'stand-in' };
  },
}));
// The transport only: who is told, and the push_dispatch_log claim, are real.
vi.mock('../../../server/services/push/fcm.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/push/fcm.js')>()),
  isPushConfigured: () => true,
  sendFcmMessage: async (msg: Record<string, unknown>) => { state.sent.push(msg); return { ok: true }; },
}));
vi.mock('../../../server/services/push/apns.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/push/apns.js')>()),
  isApnsConfigured: () => false,
}));

// The admin's greeting per language; the one shown is the platform's
// language (intro.ts buildIntroBody clamps the visitor's to it).
const GREETINGS = { fa: 'سلام! من نیلو هستم، دستیار فروشگاه.', en: 'Hi! I am Nilo, the shop\'s assistant.', tr: 'Merhaba! Ben Nilo, mağazanın asistanıyım.' };

suite('the greeting before the first message, on a real database (one conversation per visitor)', () => {
  let chain: FullChainDatabase;
  const q = async (sql: string, params: unknown[] = []): Promise<Row[]> => (await chain.db.query(sql, params)).rows as Row[];
  const one = async (sql: string, params: unknown[] = []): Promise<Row> => (await q(sql, params))[0];

  const owner = randomUUID();
  const ws = randomUUID();

  let config: ReturnType<typeof import('../../../server/config.js')['loadConfig']>;
  let resetCaches: () => void;
  let resetRateLimits: () => void;
  let app: express.Express;

  /** Fire-and-forget after the widget's answer: waited for. */
  const until = async <T>(read: () => Promise<T>, done: (v: T) => boolean): Promise<T> => {
    let v = await read();
    for (let i = 0; i < 100 && !done(v); i++) {
      await new Promise((r) => setTimeout(r, 50));
      v = await read();
    }
    return v;
  };
  const firstMessage = async (body: Row) => {
    resetRateLimits();
    const sent = await request(app).post('/api/widget/message').send({ workspace_id: ws, message: 'قیمت ارسال چقدر است؟', ...body });
    expect(sent.status).toBe(200);
    return sent.body as Row;
  };
  const rows = (cid: unknown) => q(
    `SELECT id, sender_type, body, metadata, created_at FROM public.conversation_messages WHERE conversation_id = $1 ORDER BY created_at`, [cid],
  );
  const pushes = (cid: unknown) => q(`SELECT user_id, notification_type, status FROM public.push_dispatch_log WHERE conversation_id = $1`, [cid]);

  beforeAll(async () => {
    chain = await createFullChainDatabase(DSN!, `onecvintro_${Date.now()}`);
    await q(`INSERT INTO public.profiles (id, email, full_name) VALUES ($1, $2, 'Owner')`, [owner, `p-${owner.slice(0, 8)}@test.local`]);
    await q(`INSERT INTO public.workspaces (id, name, slug, owner_id) VALUES ($1, 'Acme', $2, $3)`, [ws, `ws-${ws.slice(0, 8)}`, owner]);
    await q(`INSERT INTO public.workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner') ON CONFLICT DO NOTHING`, [ws, owner]);
    await q(`INSERT INTO public.widget_settings (workspace_id, enabled, assignment_mode, first_response_timeout_minutes) VALUES ($1, true, 'auto', 0)`, [ws]);
    await q(`INSERT INTO public.widget_prechat_settings (workspace_id, ask_name, ask_email, ask_phone, require_name, require_email, prechat_timing)
             VALUES ($1, false, false, false, false, false, 'never')`, [ws]);
    await q(`INSERT INTO public.ai_agent_settings (workspace_id, enabled, mode, ai_intro_enabled, agent_name, intro_message_localized)
             VALUES ($1, true, 'auto_reply_always', true, 'نیلو', $2::jsonb)`,
    [ws, JSON.stringify(GREETINGS)]);
    // The owner's phone: every new message of the workspace is theirs to hear of.
    await q(`INSERT INTO public.mobile_push_devices (user_id, workspace_id, platform, push_token, device_id) VALUES ($1, $2, 'android', 'tok-owner', 'dev-owner')`, [owner, ws]);

    Object.assign(process.env, {
      DATABASE_URL: chain.url,
      PLATFORM_SIGNING_SECRET: 'signing-secret-for-this-test-only-0123456789',
      SUPABASE_URL: 'https://legacy-project.supabase.co',
      SUPABASE_ANON_KEY: 'legacy-anon-key-value',
      SUPABASE_SERVICE_ROLE_KEY: 'legacy-service-role-key-value-at-least-32',
      CORS_ORIGINS: 'http://127.0.0.1',
    });
    delete process.env.DATABASE_MODE;
    config = { ...(await import('../../../server/config.js')).loadConfig(), selfHostBillingUnlimited: true };
    const snapshot = await import('../../../server/services/widget/configSnapshot.js');
    const security = await import('../../../server/services/widget/security.js');
    resetCaches = () => snapshot.__resetWidgetConfigCachesForTests();
    resetRateLimits = () => security.__resetWidgetRateLimitsForTests();
    const { widgetRouter } = await import('../../../server/routes/widget.js');
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => { Object.assign(req, { serverConfig: config }); next(); });
    app.use('/api/widget', widgetRouter);
  }, 600_000);

  afterAll(async () => {
    const { closeDataLayer } = await import('../../../server/db/index.js');
    await closeDataLayer().catch(() => undefined);
    await chain?.drop();
  });

  beforeEach(async () => {
    state.aiRuns = [];
    state.sent = [];
    resetCaches?.();
  });

  it('I1 + I2 a greeted first message is born the AI\'s: the greeting first, no push, no routing; without the greeting the owner is told', async () => {
    state.visitor = `visitor-${randomUUID().slice(0, 8)}`;
    const greeted = await firstMessage({ client_message_id: 'cmid-greeted-0001', ai_intro: { locale: 'fa' } });
    const cid = String(greeted.conversation_id);

    const conversation = await one(`SELECT status, assigned_to, metadata FROM public.conversations WHERE id = $1`, [cid]);
    expect(conversation.metadata).toMatchObject({ channel_thread_key: 'widget_cmid:cmid-greeted-0001', ai_state: 'ai_managed', source: 'ai_agent_intro' });
    expect((conversation.metadata as Row).managed_by_ai).toBeUndefined();

    const [greeting, visitorRow, ...rest] = await rows(cid);
    expect(rest).toEqual([]);
    expect(greeting).toMatchObject({ sender_type: 'ai', metadata: expect.objectContaining({ source: 'ai_agent_intro', agent_name: 'نیلو' }) });
    expect(Object.values(GREETINGS)).toContain(greeting.body);
    expect(visitorRow).toMatchObject({ sender_type: 'contact', body: 'قیمت ارسال چقدر است؟' });
    const at = (r: Row) => new Date(r.created_at as Date | string).getTime();
    expect(at(greeting)).toBeLessThan(at(visitorRow));
    expect((greeted.intro_message as Row).id).toBe(greeting.id);
    expect((await one(`SELECT count(*)::int AS n FROM public.ai_agent_intro_log WHERE conversation_id = $1 AND message_id = $2`, [cid, greeting.id])).n).toBe(1);
    // The AI answers it: its engine is asked about the visitor's message.
    expect(await until(async () => state.aiRuns, (r) => r.length > 0)).toEqual([
      expect.objectContaining({ conversationId: cid, visitorMessageId: visitorRow.id }),
    ]);

    // The control: the same first message from another visitor, no greeting.
    state.visitor = `visitor-${randomUUID().slice(0, 8)}`;
    const plain = await firstMessage({ client_message_id: 'cmid-plain-0001' });
    const plainId = String(plain.conversation_id);
    expect(plain.intro_message).toBeUndefined();
    expect(((await one(`SELECT metadata FROM public.conversations WHERE id = $1`, [plainId])).metadata as Row).ai_state).toBeUndefined();
    expect((await rows(plainId)).map((r) => r.sender_type)).toEqual(['contact']);
    expect(await until(() => pushes(plainId), (p) => p.length > 0)).toEqual([
      expect.objectContaining({ user_id: owner, notification_type: 'new_message' }),
    ]);

    // By then the greeted one's push and routing ran too: nobody was told,
    // nobody was given it.
    expect(await pushes(cid)).toEqual([]);
    const after = await one(`SELECT assigned_to, metadata FROM public.conversations WHERE id = $1`, [cid]);
    expect(after.assigned_to).toBeNull();
    expect(after.metadata).toMatchObject({ ai_state: 'ai_managed' });
    expect((after.metadata as Row).routing_outcome).toBeUndefined();
    expect(await q(`SELECT 1 FROM public.conversation_events WHERE conversation_id = $1 AND event_type = 'assigned'`, [cid])).toEqual([]);
  });

  it('I3 a retry of the greeted first message finds its thread by the client key: nothing created, stored or changed again', async () => {
    state.visitor = `visitor-${randomUUID().slice(0, 8)}`;
    const first = await firstMessage({ client_message_id: 'cmid-retry-0001', ai_intro: { locale: 'fa' } });
    const cid = String(first.conversation_id);
    const before = await one(`SELECT metadata FROM public.conversations WHERE id = $1`, [cid]);
    const count = async () => Number((await one(`SELECT count(*)::int AS n FROM public.conversations WHERE workspace_id = $1`, [ws])).n);
    const conversations = await count();

    const again = await firstMessage({ client_message_id: 'cmid-retry-0001', ai_intro: { locale: 'fa' } });
    expect(again.conversation_id).toBe(cid);
    expect(again.intro_message).toBeUndefined();
    expect(await count()).toBe(conversations);
    expect((await rows(cid)).map((r) => r.sender_type)).toEqual(['ai', 'contact']);
    expect((await one(`SELECT metadata FROM public.conversations WHERE id = $1`, [cid])).metadata).toEqual(before.metadata);
  });
});
