// @vitest-environment node
/**
 * The rating after a chat, the closed line and the transcript by email
 * (issue #340 g1) through the REAL services on the real data layer
 * (postgres-only), on a database built by the whole chain, 276 included:
 *
 *   A1  an operator's close of a t2 workspace's widget conversation writes one
 *       visitor-visible `conversation_closed` row (the effective template read
 *       from the real widget snapshot), and none again until somebody speaks;
 *       a workspace whose effective template is `default` gets it too (one
 *       conversation per visitor, 2026-10-24);
 *   A2  the rating: rateable only for the closure the thread ends with, once
 *       (the unique closure settles two tabs racing), with the timeline's
 *       `rated` event; Operator Activity counts it for the named operator;
 *   A3  the transcript: sent with the seeded `visitor_conversation_transcript`
 *       template in Persian (Iranian edition), escaped, to the contact's
 *       address; the ledger counts it; the 10-minute pause, the 3 per
 *       conversation and the 100 per workspace a day hold on real rows;
 *   A4  before 276 (the tables renamed away) every read answers "nothing to
 *       rate" / unavailable and a write 503: the engine's 42P01 is recognised;
 *   A5  three closes of one conversation at once write one line; a workspace
 *       with no widget settings row wears `default`, t2 the catalog default
 *       or not.
 *
 * Driven by TEST_DATABASE_URL; skipped without it.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createFullChainDatabase, type FullChainDatabase } from './fullChainDatabase';

const DSN = process.env.TEST_DATABASE_URL;
const suite = DSN ? describe : describe.skip;

const sent = vi.hoisted(() => [] as Array<{ to: string; subject: string; html: string; text: string }>);
const published = vi.hoisted(() => [] as Array<{ ws: string; cid: string; envelope: { type: string; payload: Record<string, unknown> } }>);
// The transcript by email is dormant while visitor email is off
// (shared/visitorEmail.ts, owner decision 2026-10-21; it then answers 403
// transcript_disabled): this suite tests the kept code with it on.
vi.mock('../../../shared/visitorEmail.js', () => ({ VISITOR_EMAIL_FEATURES_ENABLED: true, VISITOR_EMAIL_TEMPLATE_OPTIONS: ['transcriptEmail'] }));
vi.mock('../../../server/services/email/providers/resend.js', () => ({
  resendAdapter: {
    name: 'resend',
    send: async (_cfg: unknown, message: { to: string; subject: string; html: string; text: string }) => {
      sent.push({ to: message.to, subject: message.subject, html: message.html, text: message.text });
      return { success: true, provider: 'resend', id: `m-${sent.length}` };
    },
  },
}));
vi.mock('../../../server/services/realtime/publish.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/realtime/publish.js')>()),
  publishConversationEvent: async (_c: unknown, ws: string, cid: string, envelope: { type: string; payload: Record<string, unknown> }) => {
    published.push({ ws, cid, envelope });
    return { ok: true };
  },
  publishOperatorEvent: async () => undefined,
}));

type Row = Record<string, unknown>;

suite('after-chat features on a real database (276)', () => {
  let chain: FullChainDatabase;
  const q = async (sql: string, params: unknown[] = []): Promise<Row[]> => (await chain.db.query(sql, params)).rows as Row[];
  const one = async (sql: string, params: unknown[] = []): Promise<Row> => (await q(sql, params))[0];

  const owner = randomUUID();
  const sara = randomUUID();
  const ali = randomUUID();
  const ws = randomUUID();
  const wsDefault = randomUUID();

  // Loaded after the environment points at the chain's database.
  let config: ReturnType<typeof import('../../../server/config.js')['loadConfig']>;
  let closedNotice: typeof import('../../../server/services/conversationClosedNotice.js');
  let ratings: typeof import('../../../server/services/conversationRatings.js');
  let transcript: typeof import('../../../server/services/visitorTranscript.js');
  let activity: typeof import('../../../server/routes/operatorActivity.js');
  let resetCaches: () => void;

  let contacts = 0;
  /** A widget conversation assigned to Sara, with a contact (a fresh address each: one per workspace). */
  const conversation = async (wsId: string): Promise<{ cid: string; contactId: string }> => {
    contacts += 1;
    const email = `ali${contacts}@example.com`;
    const contactId = randomUUID();
    await q(`INSERT INTO public.contacts (id, workspace_id, name, email, metadata) VALUES ($1, $2, 'Ali', $3, '{"visitor_id":"v-1"}'::jsonb)`,
      [contactId, wsId, email]);
    const cid = randomUUID();
    await q(`INSERT INTO public.conversations (id, workspace_id, status, assigned_to, contact_id, metadata)
             VALUES ($1, $2, 'open'::conversation_status, $3, $4, '{"visitor_id":"v-1"}'::jsonb)`, [cid, wsId, sara, contactId]);
    return { cid, contactId };
  };
  /** A message stamped by the database, as every insert is (so the closed line comes after it). */
  const message = async (cid: string, sender: string, body = 'hi', senderId: string | null = null): Promise<string> => {
    const id = randomUUID();
    await q(`INSERT INTO public.conversation_messages (id, conversation_id, sender_type, sender_id, body)
             VALUES ($1, $2, $3::sender_type, $4, $5)`, [id, cid, sender, senderId, body]);
    return id;
  };
  const closedRows = (cid: string) => q(
    `SELECT id, body, metadata FROM public.conversation_messages WHERE conversation_id = $1 AND metadata->>'kind' = 'conversation_closed'`, [cid],
  );
  const close = (wsId: string, cid: string) =>
    closedNotice.recordConversationClosed(config, { workspaceId: wsId, conversationId: cid, actorId: ali, status: 'closed' });

  beforeAll(async () => {
    chain = await createFullChainDatabase(DSN!, `afterchat276_${Date.now()}`);
    for (const [id, name] of [[owner, 'Owner'], [sara, 'Sara'], [ali, 'Ali']]) {
      await q(`INSERT INTO public.profiles (id, email, full_name) VALUES ($1, $2, $3)`, [id, `p-${id.slice(0, 8)}@test.local`, name]);
    }
    for (const id of [ws, wsDefault]) {
      await q(`INSERT INTO public.workspaces (id, name, slug, owner_id) VALUES ($1, 'Acme & Co', $2, $3)`, [id, `ws-${id.slice(0, 8)}`, owner]);
      await q(`INSERT INTO public.workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'admin')
               ON CONFLICT DO NOTHING`, [id, sara, ali]);
    }
    // The Iranian edition, Persian only; t2 the catalog's default, so every
    // workspace that has not chosen (and any plan) wears it.
    await q(`UPDATE public.platform_settings SET region_mode = 'iran'`);
    await q(`INSERT INTO public.widget_edition_settings (edition, chat_templates) VALUES ('iran', $1::jsonb)
             ON CONFLICT (edition) DO UPDATE SET chat_templates = EXCLUDED.chat_templates`,
    [JSON.stringify({ default: 't2', items: { t2: { enabled: true } } })]);
    await q(`INSERT INTO public.widget_settings (workspace_id, enabled, brand_name) VALUES ($1, true, 'فروشگاه <آبی>')`, [ws]);
    await q(`INSERT INTO public.widget_settings (workspace_id, enabled) VALUES ($1, true)`, [wsDefault]);
    await q(
      `INSERT INTO public.app_runtime_config (key, value) VALUES ('default_email_provider', $1::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [JSON.stringify({ provider_name: 'resend', config: { api_key: 're_test', from_email: 'no-reply@example.test', from_name: 'Sender' } })],
    );

    Object.assign(process.env, {
      DATABASE_URL: chain.url,
      PLATFORM_SIGNING_SECRET: 'signing-secret-for-this-test-only-0123456789',
      SUPABASE_URL: 'https://legacy-project.supabase.co',
      SUPABASE_ANON_KEY: 'legacy-anon-key-value',
      SUPABASE_SERVICE_ROLE_KEY: 'legacy-service-role-key-value-at-least-32',
      CORS_ORIGINS: 'http://127.0.0.1',
    });
    delete process.env.DATABASE_MODE;
    config = (await import('../../../server/config.js')).loadConfig();
    closedNotice = await import('../../../server/services/conversationClosedNotice.js');
    ratings = await import('../../../server/services/conversationRatings.js');
    transcript = await import('../../../server/services/visitorTranscript.js');
    activity = await import('../../../server/routes/operatorActivity.js');
    const snapshot = await import('../../../server/services/widget/configSnapshot.js');
    const region = await import('../../../server/services/platformRegion.js');
    resetCaches = () => {
      snapshot.__resetWidgetConfigCachesForTests();
      region.invalidatePlatformRegionCache();
    };
    resetCaches();
  }, 600_000);

  afterAll(async () => {
    const { closeDataLayer } = await import('../../../server/db/index.js');
    await closeDataLayer();
    await chain?.drop();
  });

  it('A1 the closed line: written once for a t2 workspace\'s widget conversation, and for a default one too', async () => {
    const { workspaceChatTemplate } = await import('../../../server/services/widget/configSnapshot.js');
    expect((await workspaceChatTemplate(config, ws)).id).toBe('t2');

    const { cid } = await conversation(ws);
    await message(cid, 'contact', 'سلام');
    await message(cid, 'agent', 'سلام، بفرمایید', sara);
    const first = await close(ws, cid);
    expect(first).not.toBeNull();
    const rows = await closedRows(cid);
    expect(rows).toHaveLength(1);
    expect(rows[0].body).toBe('Ali closed the conversation');
    expect(rows[0].metadata).toEqual({
      kind: 'conversation_closed', by: 'agent', agent_id: ali, agent_name: 'Ali', operator_id: sara, operator_name: 'Sara', status: 'closed',
    });
    expect(published.filter((p) => p.cid === cid).map((p) => p.envelope.type)).toEqual(['message']);
    expect(await close(ws, cid)).toBeNull();
    expect(await closedRows(cid)).toHaveLength(1);
    await message(cid, 'contact', 'یک سؤال دیگر');
    expect(await close(ws, cid)).not.toBeNull();
    expect(await closedRows(cid)).toHaveLength(2);

    // The Super Admin turns t2 off: the default workspace wears `default`,
    // which draws the line too since one conversation per visitor (2026-10-24).
    await q(`UPDATE public.widget_edition_settings SET chat_templates = $1::jsonb WHERE edition = 'iran'`,
      [JSON.stringify({ default: 'default', items: { t2: { enabled: false } } })]);
    resetCaches();
    expect((await workspaceChatTemplate(config, wsDefault)).id).toBe('default');
    const { cid: plain } = await conversation(wsDefault);
    await message(plain, 'agent', 'hi', sara);
    expect(await close(wsDefault, plain)).not.toBeNull();
    expect(await closedRows(plain)).toHaveLength(1);
    await q(`UPDATE public.widget_edition_settings SET chat_templates = $1::jsonb WHERE edition = 'iran'`,
      [JSON.stringify({ default: 't2', items: { t2: { enabled: true } } })]);
    resetCaches();
  });

  it('A2 the rating: once per closure, two tabs racing get one row, the timeline and Operator Activity see it', async () => {
    const { cid } = await conversation(ws);
    // The visitor wrote and a person answered (migration 284: a conversation
    // the visitor never wrote in is not rated).
    await message(cid, 'contact', 'سلام');
    await message(cid, 'agent', 'hi', sara);
    await close(ws, cid);
    const state = await ratings.csatState(config, { workspaceId: ws, conversationId: cid, csatEnabled: true });
    expect(state).toMatchObject({ rateable: true, rating: null, operator: { name: 'Sara' } });
    const closedId = state.closed_id!;

    const race = await Promise.allSettled([
      ratings.rateClosedConversation(config, { workspaceId: ws, conversationId: cid, closedId, score: 5, comment: 'عالی' }),
      ratings.rateClosedConversation(config, { workspaceId: ws, conversationId: cid, closedId, score: 1, comment: null }),
    ]);
    const won = race.filter((r) => r.status === 'fulfilled');
    const lost = race.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0].reason).toMatchObject({ status: 409, code: 'already_rated' });
    const stored = await q(`SELECT score, comment, operator_id, closed_message_id FROM public.conversation_ratings WHERE conversation_id = $1`, [cid]);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ operator_id: sara, closed_message_id: closedId });
    expect((lost[0].reason as { rating: { score: number } }).rating.score).toBe(stored[0].score);

    await vi.waitFor(async () => {
      const ev = await q(`SELECT actor_type, payload FROM public.conversation_events WHERE conversation_id = $1 AND event_type = 'rated'`, [cid]);
      expect(ev).toHaveLength(1);
      expect(ev[0]).toMatchObject({ actor_type: 'visitor', payload: { score: stored[0].score, closed_id: closedId, operator_id: sara, source: 'widget' } });
    });
    expect(await ratings.csatState(config, { workspaceId: ws, conversationId: cid, csatEnabled: true }))
      .toMatchObject({ rateable: false, rating: { score: stored[0].score } });

    // A closure older than 7 days is no longer rateable.
    const { cid: old } = await conversation(ws);
    await message(old, 'agent', 'hi', sara);
    await close(ws, old);
    await q(`UPDATE public.conversation_messages SET created_at = now() - interval '8 days' WHERE conversation_id = $1`, [old]);
    const oldState = await ratings.csatState(config, { workspaceId: ws, conversationId: old, csatEnabled: true });
    expect(oldState.rateable).toBe(false);
    await expect(ratings.rateClosedConversation(config, { workspaceId: ws, conversationId: old, closedId: oldState.closed_id, score: 5, comment: null }))
      .rejects.toMatchObject({ status: 409, code: 'not_ratable' });

    const byOperator = await activity.ratingsByOperator((await import('../../../server/supabase.js')).getServiceClient(config), ws, new Date(Date.now() - 86_400_000).toISOString());
    expect(byOperator.get(sara)).toEqual({ sum: Number(stored[0].score), count: 1 });
  });

  it('A3 the transcript: the seeded Persian template, escaped, to the contact; the ledger\'s limits on real rows', async () => {
    const { cid, contactId } = await conversation(ws);
    await message(cid, 'contact', 'قیمت $& و {brand} <b>؟</b>');
    await message(cid, 'agent', 'سلام علی', sara);
    await close(ws, cid);
    const conv = { id: cid, contact_id: contactId };
    expect(await transcript.transcriptAvailability(config, { workspaceId: ws, conversation: conv }))
      .toEqual({ available: true, to: 'a•••@example.com' });

    const out = await transcript.emailVisitorTranscript(config, { workspaceId: ws, conversation: conv, locale: 'en', tz: 'Asia/Tehran' });
    expect(out).toEqual({ ok: true, to: 'a•••@example.com' });
    const mail = sent[sent.length - 1];
    expect(mail.to).toMatch(/^ali\d+@example\.com$/);
    // The Iranian edition sends Persian whatever the widget asked.
    expect(mail.subject).toBe('متن گفتگوی شما با فروشگاه <آبی>');
    expect(mail.html).toContain('<h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;">فروشگاه &lt;آبی&gt;</h1>');
    expect(mail.html).toContain('قیمت $&amp; و {brand} &lt;b&gt;؟&lt;/b&gt;');
    expect(mail.html).toContain('شما · ');
    expect(mail.html).toContain('Sara · ');
    expect(mail.html).not.toContain('closed the conversation');
    expect(mail.text).toContain('قیمت $& و {brand} <b>؟</b>');
    expect(await q(`SELECT status FROM public.conversation_transcript_emails WHERE conversation_id = $1`, [cid])).toEqual([{ status: 'sent' }]);

    expect(await transcript.emailVisitorTranscript(config, { workspaceId: ws, conversation: conv }))
      .toMatchObject({ ok: false, status: 429, error: 'rate_limited' });
    await q(`UPDATE public.conversation_transcript_emails SET created_at = now() - interval '1 hour' WHERE conversation_id = $1`, [cid]);
    await q(`INSERT INTO public.conversation_transcript_emails (workspace_id, conversation_id, status, created_at)
             VALUES ($1, $2, 'sent', now() - interval '2 hours'), ($1, $2, 'sent', now() - interval '3 hours')`, [ws, cid]);
    expect(await transcript.emailVisitorTranscript(config, { workspaceId: ws, conversation: conv }))
      .toMatchObject({ ok: false, status: 429, error: 'limit_reached' });
    expect((await transcript.transcriptAvailability(config, { workspaceId: ws, conversation: conv })).available).toBe(false);

    const { cid: other, contactId: otherContact } = await conversation(ws);
    await message(other, 'agent', 'hi', sara);
    await q(`INSERT INTO public.conversation_transcript_emails (workspace_id, conversation_id, status)
             SELECT $1, $2, 'failed' FROM generate_series(1, 100)`, [ws, other]);
    expect(await transcript.emailVisitorTranscript(config, { workspaceId: ws, conversation: { id: other, contact_id: otherContact } }))
      .toMatchObject({ ok: false, status: 429, error: 'workspace_limit' });

    await vi.waitFor(async () => {
      const ev = await one(`SELECT payload FROM public.conversation_events WHERE conversation_id = $1 AND event_type = 'transcript_emailed'`, [cid]);
      expect(ev.payload).toMatchObject({ status: 'sent', to: 'a•••@example.com', messages: 2 });
    });
  });

  it('A5 closes at once write one line; a workspace without widget settings is never taken for t2', async () => {
    const { cid } = await conversation(ws);
    await message(cid, 'agent', 'hi', sara);
    const outs = await Promise.all([close(ws, cid), close(ws, cid), close(ws, cid)]);
    expect(outs.filter(Boolean)).toHaveLength(1);
    expect(await closedRows(cid)).toHaveLength(1);

    // t2 is the catalog's default (A1 restored it), but this workspace has
    // no widget_settings row: it wears the edition's `default`, never t2
    // (whose line, since one conversation per visitor, default draws too).
    const bare = randomUUID();
    await q(`INSERT INTO public.workspaces (id, name, slug, owner_id) VALUES ($1, 'Bare', $2, $3)`, [bare, `ws-${bare.slice(0, 8)}`, owner]);
    resetCaches();
    const { workspaceChatTemplate } = await import('../../../server/services/widget/configSnapshot.js');
    expect((await workspaceChatTemplate(config, ws)).id).toBe('t2');
    expect(await workspaceChatTemplate(config, bare)).toMatchObject({ id: 'default', options: {} });
    const { cid: plain } = await conversation(bare);
    await message(plain, 'agent', 'hi', sara);
    expect(await close(bare, plain)).not.toBeNull();
    expect(await closedRows(plain)).toHaveLength(1);
  });

  it('A4 before 276: nothing to rate, no transcript, and a 503 — the engine\'s missing-table error is recognised', async () => {
    const { cid, contactId } = await conversation(ws);
    await message(cid, 'agent', 'hi', sara);
    await close(ws, cid);
    await q(`ALTER TABLE public.conversation_ratings RENAME TO conversation_ratings_away`);
    await q(`ALTER TABLE public.conversation_transcript_emails RENAME TO conversation_transcript_emails_away`);
    try {
      const state = await ratings.csatState(config, { workspaceId: ws, conversationId: cid, csatEnabled: true });
      expect(state).toMatchObject({ rateable: false, rating: null });
      await expect(ratings.rateClosedConversation(config, { workspaceId: ws, conversationId: cid, closedId: state.closed_id, score: 4, comment: null }))
        .rejects.toMatchObject({ status: 503, code: 'csat_unavailable' });
      const conv = { id: cid, contact_id: contactId };
      expect(await transcript.transcriptAvailability(config, { workspaceId: ws, conversation: conv })).toMatchObject({ available: false });
      expect(await transcript.emailVisitorTranscript(config, { workspaceId: ws, conversation: conv }))
        .toMatchObject({ ok: false, status: 503, error: 'email_unavailable' });
      const byOperator = await activity.ratingsByOperator((await import('../../../server/supabase.js')).getServiceClient(config), ws, new Date(0).toISOString());
      expect(byOperator.size).toBe(0);
    } finally {
      await q(`ALTER TABLE public.conversation_ratings_away RENAME TO conversation_ratings`);
      await q(`ALTER TABLE public.conversation_transcript_emails_away RENAME TO conversation_transcript_emails`);
    }
  });
});
