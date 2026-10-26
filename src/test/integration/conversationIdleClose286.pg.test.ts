// @vitest-environment node
/**
 * 286 — a quiet conversation of every chat channel closes by itself (owner,
 * 2026-10-26), on a real database: the chain up to 285 and the real App
 * Review seed (249), then 286 applied to it as WebYar's is by hand.
 *
 *   Before 286 the channels and platform support read not_widget, and a
 *   media-only customer turn (metadata.attachments) is transparent. A dry run
 *   in BEGIN … ROLLBACK leaves no trace. After it: Telegram, Bale, WhatsApp,
 *   Instagram, X and a platform support thread of each kind (the chat, an old
 *   ticket; open and resolved) are due when quiet; what the team owes is not
 *   (a media-only customer turn included); the App Review account is exempt
 *   (its seeded threads, of any channel, its workspace, the support threads
 *   it opens, the ones opened from its workspace); spam, closed and missing
 *   read as before; idle_due lists the channel rows (none while switched
 *   off); the close of a Telegram conversation writes no line and queues no
 *   outbound job; the backlog script lists every channel and refuses the
 *   exempt; needsReply.ts and conversation_message_turn() agree on the
 *   generated fixtures plus the attachments ones. A second run changes
 *   nothing; the functions stay service_role's; without 285 the file stops.
 *
 * Driven by TEST_DATABASE_URL; skipped without it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { applyMigrationSql } from './pgMigrationChain';
import { BOT_PROVIDER_IDS } from '../../../shared/channels/botProviders';

const DSN = process.env.TEST_DATABASE_URL;
const suite = DSN ? describe : describe.skip;
const PSQL = spawnSync('psql', ['--version']).status === 0;

type Row = Record<string, unknown>;

const MIGRATION = resolve(process.cwd(), 'database/migrations/286_inactivity_close_every_channel.sql');
const MIGRATION_284 = resolve(process.cwd(), 'database/migrations/284_conversation_inactivity_close.sql');
const BACKLOG = resolve(process.cwd(), 'database/backfill/284_inactivity_backlog_close.sql');
/** The App Review reviewer's password hash (appReviewAccount.pg.test.ts's). */
const APP_REVIEW_HASH = '$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNo';
/** Every bot channel the platform speaks (Telegram, Bale, WhatsApp, Instagram, X). */
const CHANNELS = BOT_PROVIDER_IDS;
const FUNCTIONS = ['conversation_message_turn(text, text, jsonb)', 'conversation_idle_check(uuid)', 'conversation_idle_due(integer)'];
/** A Telegram voice note as inbound processing stores it: an empty body, the media in metadata.attachments. */
const VOICE = [{ kind: 'voice', fileId: 'tg-file-1', mimeType: 'audio/ogg' }];

suite('286 — the inactivity close on every channel (real PostgreSQL: the chain to 285, the seed, then 286)', () => {
  let admin: pg.Client;
  let db: pg.Client;
  let url = '';
  const name = `idle_close_286_${Date.now()}`;
  const q = async (sql: string, p: unknown[] = []): Promise<Row[]> => (await db.query(sql, p)).rows as Row[];
  const one = async (sql: string, p: unknown[] = []): Promise<Row> => (await q(sql, p))[0];

  const owner = randomUUID();
  const requester = randomUUID();
  const ws = randomUUID();
  const support = randomUUID();
  let review = '';
  let apple = '';
  let integration = '';

  const channel: Record<string, string> = {};
  const f: Record<string, string> = {};

  /** A message `ago` (plus `earlier`) before now. */
  const message = async (cid: string, sender: string, ago: string, meta: Row = {}, body = 'سلام', earlier = '0 seconds') => {
    const id = randomUUID();
    await q(`INSERT INTO public.conversation_messages (id, conversation_id, sender_type, sender_id, body, metadata, created_at)
             VALUES ($1, $2, $3::sender_type, $4, $5, $6::jsonb, now() - $7::interval - $8::interval)`,
    [id, cid, sender, sender === 'agent' ? owner : null, body, JSON.stringify(meta), ago, earlier]);
    return id;
  };
  /**
   * A conversation last touched `quiet` ago (created two hours before that):
   * the customer asked an hour before the team's answer, unless `owed`
   * (then the customer's turn is the last).
   */
  const conversation = async (workspace: string, meta: Row, o: { status?: string; quiet?: string; spam?: boolean; owed?: boolean } = {}) => {
    const id = randomUUID();
    const quiet = o.quiet ?? '30 hours';
    await q(`INSERT INTO public.conversations (id, workspace_id, status, metadata, created_at, updated_at, is_spam)
             VALUES ($1, $2, $3::conversation_status, $4::jsonb, now() - $5::interval - interval '2 hours', now() - $5::interval, $6)`,
    [id, workspace, o.status ?? 'open', JSON.stringify(meta), quiet, o.spam ?? false]);
    await message(id, 'contact', quiet, {}, 'سلام', o.owed ? '0 seconds' : '1 hour');
    if (!o.owed) await message(id, 'agent', quiet, {}, 'بفرمایید');
    return id;
  };
  const channelMeta = (provider: string): Row => (provider === 'telegram'
    ? { channel: provider, channel_integration_id: integration, channel_chat_id: '1001' }
    : { channel: provider, channel_chat_id: `${provider}-chat` });
  /** A platform support thread in the support workspace: `kind` 'chat' (the live one) or an old 'ticket'. */
  const supportThread = async (o: { user: string; source: string | null; kind: 'chat' | 'ticket'; status?: string; owed?: boolean }) => {
    const meta: Row = o.kind === 'chat'
      ? { channel: 'platform_support', channel_thread_key: `platform_support:${o.user}:cmid-${randomUUID()}`, platform_user_id: o.user, platform_workspace_id: o.source }
      : { channel: 'platform_support', platform_support_kind: 'ticket', channel_thread_key: `platform_support:ticket:${randomUUID()}` };
    const cid = await conversation(support, meta, { status: o.status, owed: o.owed });
    await q(`INSERT INTO public.platform_support_threads (conversation_id, support_workspace_id, user_id, source_workspace_id) VALUES ($1, $2, $3, $4)`,
      [cid, support, o.user, o.source]);
    return cid;
  };

  const verdict = async (cid: string) => (await one(`SELECT verdict FROM public.conversation_idle_check($1)`, [cid])).verdict;
  const dueIds = async () => (await q(`SELECT due_conversation_id FROM public.conversation_idle_due(500)`)).map((r) => r.due_conversation_id as string).sort();
  const close = async (cid: string, source: string) => one(
    `SELECT * FROM public.conversation_close_if_idle($1, (SELECT updated_at FROM public.conversations WHERE id = $1), $2, NULL, NULL)`,
    [cid, source],
  );
  const status = async (cid: string) => (await one(`SELECT status::text AS status FROM public.conversations WHERE id = $1`, [cid])).status;
  const turn = async (sender: string, body: string, meta: Row) => (await one(`SELECT public.conversation_message_turn($1, $2, $3::jsonb) AS t`, [sender, body, JSON.stringify(meta)])).t;
  const seeded = async () => q(
    `SELECT c.id, c.status::text AS status, c.is_spam, c.metadata->>'channel' AS channel, chk.verdict
       FROM public.conversations c
       CROSS JOIN LATERAL public.conversation_idle_check(c.id) chk
      WHERE c.workspace_id = $1 AND c.metadata->>'app_review_seed' = 'true' ORDER BY c.id`, [review],
  );
  /** Every fixture's verdict, for "a second run changes nothing". */
  const allVerdicts = async () => q(
    `SELECT c.id, chk.verdict FROM public.conversations c CROSS JOIN LATERAL public.conversation_idle_check(c.id) chk ORDER BY c.id`,
  );

  beforeAll(async () => {
    const adminUrl = new URL(DSN!);
    adminUrl.pathname = '/postgres';
    admin = new pg.Client({ connectionString: adminUrl.toString() });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${name}`);
    await admin.query(`CREATE DATABASE ${name}`);
    const u = new URL(DSN!);
    u.pathname = `/${name}`;
    url = u.toString();
    db = new pg.Client({ connectionString: url });
    await db.connect();
    await db.query('SET client_min_messages = warning');
    const dir = resolve(process.cwd(), 'database/migrations');
    for (const file of readdirSync(dir).filter((x) => x.endsWith('.sql') && x < '286').sort()) {
      await applyMigrationSql(db, readFileSync(resolve(dir, file), 'utf8'));
    }

    for (const [id, full] of [[owner, 'Owner'], [requester, 'Requester']]) {
      await q(`INSERT INTO public.profiles (id, email, full_name) VALUES ($1, $2, $3)`, [id, `p-${id.slice(0, 8)}@test.local`, full]);
    }
    for (const [id, title] of [[ws, 'Acme'], [support, 'Platform support']]) {
      await q(`INSERT INTO public.workspaces (id, name, slug, owner_id) VALUES ($1, $2, $3, $4)`, [id, title, `ws-${id.slice(0, 8)}`, owner]);
      await q(`INSERT INTO public.workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner') ON CONFLICT DO NOTHING`, [id, owner]);
    }
    await q(`INSERT INTO public.widget_settings (workspace_id, enabled) VALUES ($1, true) ON CONFLICT (workspace_id) DO NOTHING`, [ws]);
    await q(`SELECT public.app_review_seed($1)`, [APP_REVIEW_HASH]);
    review = (await one(`SELECT id FROM public.workspaces WHERE slug = 'ws_appreview'`)).id as string;
    apple = (await one(`SELECT id FROM public.profiles WHERE email = 'apple@webyar.ai'`)).id as string;
    await q(`UPDATE public.widget_platform_settings SET inactivity_close_enabled = true, inactivity_close_default_hours = 24`);
    // A connected Telegram bot, so a team message there is queued to the channel (the outbound trigger).
    const installation = (await one(`INSERT INTO public.workspace_plugin_installations (workspace_id, plugin_id, status) VALUES ($1, 'telegram', 'installed') RETURNING id`, [ws])).id;
    integration = (await one(`INSERT INTO public.channel_integrations (workspace_id, installation_id, provider, public_integration_id, status)
                              VALUES ($1, $2, 'telegram', $3, 'connected') RETURNING id`, [ws, installation, `tg-${randomUUID().slice(0, 8)}`])).id as string;

    for (const provider of CHANNELS) channel[provider] = await conversation(ws, channelMeta(provider));
    f.widget = await conversation(ws, { visitor_id: 'visitor-286' });
    f.supportChat = await supportThread({ user: requester, source: ws, kind: 'chat' });
    f.supportResolved = await supportThread({ user: requester, source: ws, kind: 'chat', status: 'resolved' });
    f.supportTicket = await supportThread({ user: requester, source: ws, kind: 'ticket', status: 'resolved' });
    // The team owes: the customer wrote last (text, or media only).
    f.owedTelegram = await conversation(ws, channelMeta('telegram'), { owed: true });
    f.owedVoice = await conversation(ws, channelMeta('telegram'));
    await message(f.owedVoice, 'contact', '29 hours', { channel: 'telegram', channel_inbound: 'true', attachments: VOICE }, '');
    await q(`UPDATE public.conversations SET updated_at = now() - interval '29 hours' WHERE id = $1`, [f.owedVoice]);
    f.owedWidgetPhoto = await conversation(ws, { visitor_id: 'visitor-286-b' });
    await message(f.owedWidgetPhoto, 'contact', '29 hours', { attachments: [{ kind: 'photo', fileId: 'p1' }] }, '');
    await q(`UPDATE public.conversations SET updated_at = now() - interval '29 hours' WHERE id = $1`, [f.owedWidgetPhoto]);
    f.owedSupport = await supportThread({ user: requester, source: ws, kind: 'chat', owed: true });
    // The App Review account: its workspace (a conversation started there
    // after the seed, no mark), the support threads it opens (from anywhere),
    // and one opened from its workspace by somebody else.
    f.tried = await conversation(review, { channel: 'telegram', channel_chat_id: 'review-chat' });
    f.appleSupport = await supportThread({ user: apple, source: null, kind: 'chat' });
    f.fromReview = await supportThread({ user: requester, source: review, kind: 'chat' });
    // Neither spam nor a closed conversation, of any channel.
    f.spam = await conversation(ws, channelMeta('whatsapp'), { spam: true });
    f.closed = await conversation(ws, channelMeta('instagram'), { status: 'closed' });
  }, 600_000);

  afterAll(async () => {
    await db?.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end();
    }
  });

  it('before 286 (at 285): every channel and platform support reads not_widget, and a media-only customer turn is transparent', async () => {
    expect([...CHANNELS]).toEqual(['telegram', 'bale', 'whatsapp', 'instagram', 'x']);
    for (const provider of CHANNELS) expect(await verdict(channel[provider]), provider).toBe('not_widget');
    for (const k of ['supportChat', 'supportResolved', 'supportTicket', 'owedTelegram', 'owedVoice', 'owedSupport', 'appleSupport', 'fromReview', 'tried']) {
      expect(await verdict(f[k]), k).toBe('not_widget');
    }
    // The gap 286 closes: the visitor's photo held nothing back.
    expect(await verdict(f.owedWidgetPhoto)).toBe('due');
    expect(await turn('contact', '', { attachments: VOICE })).toBeNull();
    expect(await dueIds()).toEqual([f.widget, f.owedWidgetPhoto].sort());
  });

  it('a dry run of 286 in BEGIN … ROLLBACK leaves no trace', async () => {
    const before = await q(`SELECT p.proname, pg_get_functiondef(p.oid) AS def FROM pg_proc p
                             WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('conversation_message_turn', 'conversation_idle_check', 'conversation_idle_due')
                             ORDER BY p.proname`);
    await q('BEGIN');
    try {
      await applyMigrationSql(db, readFileSync(MIGRATION, 'utf8'));
      expect(await verdict(channel.telegram)).toBe('due');
    } finally {
      await q('ROLLBACK');
    }
    expect(await verdict(channel.telegram)).toBe('not_widget');
    expect(await q(`SELECT p.proname, pg_get_functiondef(p.oid) AS def FROM pg_proc p
                     WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('conversation_message_turn', 'conversation_idle_check', 'conversation_idle_due')
                     ORDER BY p.proname`)).toEqual(before);
  });

  it('after 286: Telegram, Bale, WhatsApp, Instagram, X, the widget and platform support (a chat and an old ticket, open and resolved) are due when quiet', async () => {
    await applyMigrationSql(db, readFileSync(MIGRATION, 'utf8'));
    for (const provider of CHANNELS) {
      expect(await one(`SELECT verdict, idle_hours, closed_outcome FROM public.conversation_idle_check($1)`, [channel[provider]]), provider)
        .toEqual({ verdict: 'due', idle_hours: 24, closed_outcome: 'human' });
    }
    for (const k of ['widget', 'supportChat', 'supportResolved', 'supportTicket']) expect(await verdict(f[k]), k).toBe('due');
    // The window is the conversation's workspace's: the support workspace's own for support.
    await q(`INSERT INTO public.widget_settings (workspace_id, enabled, inactivity_close_hours) VALUES ($1, true, 48)`, [support]);
    try {
      expect(await one(`SELECT verdict, idle_hours FROM public.conversation_idle_check($1)`, [f.supportChat])).toEqual({ verdict: 'recent', idle_hours: 48 });
      expect(await verdict(channel.telegram)).toBe('due');
    } finally {
      await q(`DELETE FROM public.widget_settings WHERE workspace_id = $1`, [support]);
    }
  });

  it('never while the team owes: the customer\'s last turn on a channel, in support, or media only (a voice note, a photo)', async () => {
    for (const k of ['owedTelegram', 'owedVoice', 'owedWidgetPhoto', 'owedSupport']) expect(await verdict(f[k]), k).toBe('needs_reply');
    expect(await turn('contact', '', { attachments: VOICE })).toBe('visitor');
    expect(await turn('agent', '', { attachments: VOICE })).toBe('team');
  });

  it('the App Review account is exempt: its seeded threads (any channel), its workspace, the support threads it opens or that are opened from its workspace', async () => {
    const demo = await seeded();
    expect(demo.filter((r) => r.channel === 'whatsapp' || r.channel === 'telegram').length).toBeGreaterThanOrEqual(2);
    for (const r of demo) {
      expect(r.verdict, String(r.channel)).toBe(!['open', 'pending', 'resolved'].includes(r.status as string) ? 'not_live' : r.is_spam ? 'spam' : 'exempt');
    }
    for (const k of ['tried', 'appleSupport', 'fromReview']) {
      expect(await verdict(f[k]), k).toBe('exempt');
      expect(await close(f[k], 'timer'), k).toMatchObject({ closed: false, outcome: 'exempt' });
      expect(await close(f[k], 'backlog'), k).toMatchObject({ closed: false, outcome: 'exempt' });
      expect(await status(f[k]), k).toBe('open');
    }
    // The same thread by another operator from another workspace is due.
    expect(await verdict(f.supportChat)).toBe('due');
  });

  it('spam, closed and missing read as before; no function returns not_widget any more', async () => {
    expect(await verdict(f.spam)).toBe('spam');
    expect(await verdict(f.closed)).toBe('not_live');
    expect(await verdict(randomUUID())).toBe('not_found');
    expect((await allVerdicts()).filter((r) => r.verdict === 'not_widget')).toEqual([]);
  });

  it('idle_due lists the channel and support rows, never the owed or the exempt; nothing while the switch is off', async () => {
    const due = [...CHANNELS.map((p) => channel[p]), f.widget, f.supportChat, f.supportResolved, f.supportTicket].sort();
    expect(await dueIds()).toEqual(due);
    const rows = await q(`SELECT * FROM public.conversation_idle_due(500) WHERE due_conversation_id = $1`, [f.supportResolved]);
    expect(rows[0]).toMatchObject({ due_workspace_id: support, due_status: 'resolved', due_has_visitor_turn: true, due_idle_hours: 24, due_closed_outcome: 'human' });
    await q(`UPDATE public.widget_platform_settings SET inactivity_close_enabled = false`);
    try {
      expect(await dueIds()).toEqual([]);
      expect(await close(channel.bale, 'timer')).toMatchObject({ closed: false, outcome: 'disabled' });
    } finally {
      await q(`UPDATE public.widget_platform_settings SET inactivity_close_enabled = true`);
    }
  });

  it('the close of a Telegram conversation writes no line and queues nothing for the channel; a resolved support thread closes from resolved', async () => {
    const cid = channel.telegram;
    // The trigger is live: the team's answer in the fixture was queued.
    expect((await one(`SELECT count(*)::int AS n FROM public.channel_jobs WHERE payload->>'conversation_id' = $1`, [cid])).n).toBe(1);
    const jobs = (await one(`SELECT count(*)::int AS n FROM public.channel_jobs`)).n;
    const messages = (await one(`SELECT count(*)::int AS n FROM public.conversation_messages WHERE conversation_id = $1`, [cid])).n;
    const before = await one(`SELECT updated_at FROM public.conversations WHERE id = $1`, [cid]);
    const r = await close(cid, 'timer');
    expect(r).toMatchObject({ closed: true, outcome: 'closed', from_status: 'open', line_id: null, event_type: 'resolved', closed_outcome: 'human' });
    const after = await one(`SELECT status::text AS status, updated_at, metadata FROM public.conversations WHERE id = $1`, [cid]);
    expect(after.status).toBe('closed');
    expect(new Date(after.updated_at as string).getTime()).toBe(new Date(before.updated_at as string).getTime());
    expect(after.metadata).toMatchObject({ channel: 'telegram', closed_reason: 'inactivity', closed_by: 'system', closed_from: 'open', closed_source: 'inactivity_timer', closed_line_id: null });
    expect((await one(`SELECT count(*)::int AS n FROM public.conversation_messages WHERE conversation_id = $1`, [cid])).n).toBe(messages);
    expect((await one(`SELECT count(*)::int AS n FROM public.channel_jobs`)).n).toBe(jobs);
    // A customer message that raced it brings it back (284's reopen, any channel; the server's grace is 600 s).
    expect((await one(`SELECT * FROM public.conversation_reopen_after_idle_close($1, $2, NULL, 600)`, [ws, cid])).restored_status).toBe('open');
    expect(await status(cid)).toBe('open');

    const resolved = await close(f.supportResolved, 'timer');
    expect(resolved).toMatchObject({ closed: true, from_status: 'resolved', event_type: 'status_changed', line_id: null });
    expect((await one(`SELECT metadata FROM public.conversations WHERE id = $1`, [f.supportResolved])).metadata).toMatchObject({ closed_from: 'resolved', closed_reason: 'inactivity' });
  });

  (PSQL ? describe : describe.skip)('the backlog script (psql), channel-neutral', () => {
    const run = (vars: Record<string, string>) => spawnSync('psql', [url, '-X', '-q', '-v', 'ON_ERROR_STOP=1',
      ...Object.entries(vars).flatMap(([k, v]) => ['-v', `${k}=${v}`]), '-f', BACKLOG], { encoding: 'utf8' });

    it('the dry run lists every channel\'s due rows, by channel, and leaves the App Review account out; nothing changes', async () => {
      const out = join(mkdtempSync(join(tmpdir(), 'backlog286-')), 'backlog.csv');
      const before = await q(`SELECT id, status, updated_at FROM public.conversations ORDER BY id`);
      const res = run({ out });
      expect(res.status, res.stderr).toBe(0);
      expect(res.stdout).toMatch(/Dry run: rolled back/);
      expect(res.stdout).toMatch(/By channel and verdict/);
      for (const label of ['bale', 'whatsapp', 'instagram', 'platform_support', 'widget', 'needs_reply']) expect(res.stdout, label).toContain(label);
      for (const k of ['tried', 'appleSupport', 'fromReview']) expect(res.stdout, k).not.toContain(f[k]);
      expect(res.stdout).not.toContain(review);
      expect(res.stdout).not.toMatch(/\bexempt\b/);
      expect(res.stdout).not.toMatch(/بفرمایید|سلام/); // no message text
      // Due now: every channel's (Telegram's too: its reopen moved updated_at,
      // not its last exchange, and the backlog has no updated_at bound), the
      // widget's, and the support threads still live.
      const ids = readFileSync(out, 'utf8').trim().split('\n').sort();
      expect(ids).toEqual([...CHANNELS.map((p) => channel[p]), f.widget, f.supportChat, f.supportTicket].sort());
      expect(await q(`SELECT id, status, updated_at FROM public.conversations ORDER BY id`)).toEqual(before);
    });

    it('a commit that names an exempt conversation skips it by name and closes the rest silently', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'backlog286-'));
      const csv = join(dir, 'reviewed.csv');
      writeFileSync(csv, `${f.appleSupport}\n${channel.x}\n`);
      const res = run({ commit: '1', ids: csv, enable: '0' });
      expect(res.status, res.stderr).toBe(0);
      expect(res.stdout).toMatch(/COMMITTED/);
      expect(res.stdout).toMatch(new RegExp(`${f.appleSupport}\\s*\\|\\s*exempt`));
      expect(await status(f.appleSupport)).toBe('open');
      expect(await status(channel.x)).toBe('closed');
      expect((await one(`SELECT metadata FROM public.conversations WHERE id = $1`, [channel.x])).metadata).toMatchObject({ closed_source: 'inactivity_backlog', closed_line_id: null });
      expect(await q(`SELECT id FROM public.conversation_messages WHERE conversation_id = $1 AND sender_type = 'system'`, [channel.x])).toEqual([]);
      expect((await one(`SELECT inactivity_close_enabled FROM public.widget_platform_settings LIMIT 1`)).inactivity_close_enabled).toBe(true);
    });
  });

  it('needsReply.ts and 286\'s conversation_message_turn() agree on the generated fixtures plus the attachments ones', async () => {
    const { isActionableCustomerTurn, isQualifiedCustomerFacingAnswer } = await import('../../../server/services/needsReply.js');
    const senders = ['contact', 'agent', 'ai', 'system', 'bot'];
    const bodies = ['hi', '', '   ', ' 　\t', '​', ' x '];
    const media = [{ kind: 'photo', fileId: 'f1' }];
    const metas: Row[] = [
      // 284's.
      {}, { attachment_id: 'a1' }, { attachment_id: '' }, { attachment_id: 0 }, { attachment_id: false },
      { provider_echo: true }, { provider_echo: 'true' }, { channel_menu_event: 'true' }, { channel_menu_event: true },
      { channel_menu_event: 'false' }, { channel_menu_command: 'start' }, { channel_menu_command: '' }, { channel_menu_command: 0 },
      { channel_menu_command: {} }, { channel_menu_command: [] }, { routing_notice: 'queued' }, { routing_notice: true },
      { channel_delivery_skip: 'true' }, { channel_delivery_skip: true }, { channel_delivery: 'failed' }, { channel_delivery: 'sent' },
      { handoff: true }, { handoff: 'true' }, { handoff: false }, { kind: 'conversation_closed' }, { internal: true },
      // A channel's media (286); missing is {} above.
      { attachments: [] }, { attachments: media }, { attachments: 'x' }, { attachments: {} }, { attachments: null }, { attachments: [null] },
      { attachments: media, attachment_id: '' }, { attachments: media, provider_echo: true }, { attachments: media, channel_menu_event: 'true' },
      { attachments: media, channel_delivery: 'failed' }, { attachments: media, channel_delivery_skip: 'true' }, { attachments: media, handoff: true },
      { attachments: media, routing_notice: 'queued' }, { attachments: [], attachment_id: 'a1' },
    ];
    const fixtures: Array<{ i: number; s: string; b: string; m: Row; ts: string }> = [];
    for (const s of senders) for (const b of bodies) for (const m of metas) {
      const msg = { sender_type: s, body: b, metadata: m };
      fixtures.push({ i: fixtures.length, s, b, m, ts: isActionableCustomerTurn(msg) ? 'visitor' : isQualifiedCustomerFacingAnswer(msg) ? 'team' : '' });
    }
    expect(fixtures).toHaveLength(senders.length * bodies.length * metas.length);
    const rows = await q(`SELECT x.i, coalesce(public.conversation_message_turn(x.s, x.b, x.m), '') AS turn
                            FROM jsonb_to_recordset($1::jsonb) AS x(i integer, s text, b text, m jsonb) ORDER BY x.i`, [JSON.stringify(fixtures)]);
    const disagree = rows.filter((r) => r.turn !== fixtures[Number(r.i)].ts).map((r) => ({ ...fixtures[Number(r.i)], sql: r.turn }));
    expect(disagree).toEqual([]);
    // The media fixtures do decide: a customer's empty-bodied photo is a turn, the team's an answer, an empty list nothing.
    const at = (s: string, b: string, m: Row) => fixtures.find((x) => x.s === s && x.b === b && JSON.stringify(x.m) === JSON.stringify(m))!.ts;
    expect([at('contact', '', { attachments: media }), at('agent', '', { attachments: media }), at('ai', ' 　\t', { attachments: media })]).toEqual(['visitor', 'team', 'team']);
    expect([at('contact', '', { attachments: [] }), at('contact', '', { attachments: 'x' }), at('contact', '', { attachments: media, provider_echo: true })]).toEqual(['', '', '']);
  });

  it('a second run changes nothing, and only service_role may execute the three functions', async () => {
    const defs = async () => q(`SELECT p.proname, pg_get_functiondef(p.oid) AS def, coalesce(array_to_string(p.proacl, ','), '') AS acl FROM pg_proc p
                                 WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('conversation_message_turn', 'conversation_idle_check', 'conversation_idle_due')
                                 ORDER BY p.proname`);
    const verdicts = await allVerdicts();
    const functions = await defs();
    const due = await dueIds();
    await applyMigrationSql(db, readFileSync(MIGRATION, 'utf8'));
    expect(await allVerdicts()).toEqual(verdicts);
    expect(await defs()).toEqual(functions);
    expect(await dueIds()).toEqual(due);
    for (const fn of FUNCTIONS) {
      const p = await one(`SELECT has_function_privilege('service_role', $1, 'EXECUTE') AS service,
                                  has_function_privilege('anon', $1, 'EXECUTE') AS anon,
                                  has_function_privilege('authenticated', $1, 'EXECUTE') AS authenticated,
                                  (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = $1::regprocedure) AS definer,
                                  (SELECT coalesce(array_to_string(p.proacl, ','), '') FROM pg_proc p WHERE p.oid = $1::regprocedure) AS acl`, [`public.${fn}`]);
      expect(p, fn).toMatchObject({ service: true, anon: false, authenticated: false, definer: false });
      expect(String(p.acl), fn).not.toMatch(/(^|,)=X/);
    }
  });

  it('without 285 (a database at 284, or no function at all) the file stops before it changes anything', async () => {
    const sql284 = readFileSync(MIGRATION_284, 'utf8');
    const start = sql284.indexOf('CREATE OR REPLACE FUNCTION public.conversation_idle_check(p_conversation_id uuid)');
    const check284 = sql284.slice(start, sql284.indexOf('$fn_idle_check$;', start) + '$fn_idle_check$;'.length);
    for (const setup of [check284, 'DROP FUNCTION public.conversation_idle_check(uuid)']) {
      await q('BEGIN');
      try {
        await q(setup);
        await expect(applyMigrationSql(db, readFileSync(MIGRATION, 'utf8'))).rejects.toThrow(/286 needs 285/);
      } finally {
        await q('ROLLBACK');
      }
    }
    expect(await verdict(f.appleSupport)).toBe('exempt');
    expect(await verdict(channel.bale)).toBe('due');
  });
});
