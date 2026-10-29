// @vitest-environment node
/**
 * 276 — the chat widget features' schema, against a database built by the
 * whole chain (and, for the email, through the real sendEmail on the real
 * data layer, postgres-only).
 *
 *   T1  conversation_ratings: 1–5, a comment of at most 1000 characters, one
 *       rating per closure; gone with its conversation;
 *   T2  conversation_transcript_emails: sent | failed; gone with its
 *       workspace;
 *   T3  only service_role reaches the four tables (RLS on, anon /
 *       authenticated denied, live), nobody but service_role runs
 *       chat_queue_status, no customer role runs the definer trigger
 *       function, every function pins its search_path;
 *   T4  conversation_message_reactions: actor and emoji checks, one per
 *       (message, actor, emoji) with the visitor's NULL actor, and adding or
 *       removing one moves the message's updated_at (216's sync cursor); a
 *       cascade touches nothing and fails nothing;
 *   T5  chat_queue_status: the place by queued_at (then id), what does not
 *       count, no row for a conversation not waiting, the wait only from 3
 *       samples on, never above 180 minutes, never from stale stats;
 *   T6  the claim trigger samples a claim of a queued row only (measured
 *       from its latest entry into the queue), averages and restarts after
 *       14 idle days, and never fails the assignment nor makes it wait for a
 *       lock;
 *   T6b a hand-back keeps the place (queued_at) and records when and at
 *       which place the conversation came back, in the same UPDATE; the next
 *       claim is measured from there; anything else is no hand-back;
 *   T7  knowledge_base_articles.author_user_id: a validated key to profiles,
 *       set to NULL when the profile goes;
 *   T8  visitor_conversation_transcript: both editions in fa/en/tr; a re-run
 *       never overwrites an edited row; sendEmail fills it with visitor text
 *       taken literally ($&, $', $1, {brand}); per-part data (htmlData)
 *       gives the HTML its escaped copy and the subject and text the raw one;
 *   T9  276 runs twice; every check, policy and trigger exists once; the
 *       re-run waits for no ordinary writer;
 *   T10 276 sets its own lock_timeout and resets it.
 *
 * Driven by TEST_DATABASE_URL; skipped without it.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { createFullChainDatabase, type FullChainDatabase } from './fullChainDatabase';
import { applyMigrationSql } from './pgMigrationChain';

const DSN = process.env.TEST_DATABASE_URL;
const suite = DSN ? describe : describe.skip;
const FILE = resolve(process.cwd(), 'database/migrations/276_widget_chat_features.sql');
const TABLES = ['conversation_ratings', 'conversation_transcript_emails', 'conversation_message_reactions', 'chat_queue_stats'];

const sent = vi.hoisted(() => [] as Array<{ to: string; subject: string; html: string; text: string }>);
vi.mock('../../../server/services/email/providers/resend.js', () => ({
  resendAdapter: {
    name: 'resend',
    send: async (_cfg: unknown, message: { to: string; subject: string; html: string; text: string }) => {
      sent.push({ to: message.to, subject: message.subject, html: message.html, text: message.text });
      return { success: true, provider: 'resend', id: `m-${sent.length}` };
    },
  },
}));

type Row = Record<string, unknown>;

suite('276 — chat widget features (real PostgreSQL)', () => {
  let chain: FullChainDatabase;
  const q = async (sql: string, params: unknown[] = []): Promise<Row[]> => (await chain.db.query(sql, params)).rows as Row[];
  const one = async (sql: string, params: unknown[] = []): Promise<Row> => (await q(sql, params))[0];
  const errorOf = async (p: Promise<unknown>): Promise<string> => {
    try {
      await p;
      return 'no error';
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  };
  /** Runs `sql` as `role` inside a transaction that is rolled back. */
  const asRole = async (role: string, sql: string): Promise<string> => errorOf((async () => {
    await q('BEGIN');
    try {
      await q(`SET LOCAL ROLE ${role}`);
      await q(sql);
    } finally {
      await q('ROLLBACK');
    }
  })());

  const owner = randomUUID();
  const op1 = randomUUID();
  const op2 = randomUUID();
  const ws = randomUUID();
  const ws2 = randomUUID();

  const profile = (id: string) => q(`INSERT INTO public.profiles (id, email, full_name) VALUES ($1, $2, 'Sara')`, [id, `p-${id.slice(0, 8)}@test.local`]);
  const workspace = (id: string) => q(`INSERT INTO public.workspaces (id, name, slug, owner_id) VALUES ($1, 'Acme', $2, $3)`, [id, `ws-${id.slice(0, 8)}`, owner]);
  const conversation = async (wsId: string, fields: Row = {}): Promise<string> => {
    const id = randomUUID();
    await q(
      `INSERT INTO public.conversations (id, workspace_id, status, assigned_to, is_spam, metadata)
       VALUES ($1, $2, $3::conversation_status, $4, $5, $6::jsonb)`,
      [id, wsId, fields.status ?? 'open', fields.assigned_to ?? null, fields.is_spam ?? false, JSON.stringify(fields.metadata ?? {})],
    );
    return id;
  };
  const message = async (cid: string, sender = 'agent'): Promise<string> => {
    const id = randomUUID();
    await q(`INSERT INTO public.conversation_messages (id, conversation_id, sender_type, body) VALUES ($1, $2, $3::sender_type, 'hi')`, [id, cid, sender]);
    return id;
  };
  /** A manually queued conversation, queued `secondsAgo` seconds ago. */
  const queued = async (wsId: string, secondsAgo: number, fields: Row = {}, extra: Row = {}) => {
    const at = (await one(`SELECT to_char((now() - make_interval(secs => $1)) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at`, [secondsAgo])).at;
    return conversation(wsId, { ...fields, metadata: { routing_outcome: 'manual_queue', queued_at: at, ...extra } });
  };
  const status = async (wsId: string, cid: string) =>
    (await q(`SELECT queue_position, wait_minutes FROM public.chat_queue_status($1, $2)`, [wsId, cid]))[0] ?? null;

  beforeAll(async () => {
    chain = await createFullChainDatabase(DSN!, `widgetchat276_${Date.now()}`);
    for (const id of [owner, op1, op2]) await profile(id);
    await workspace(ws);
    await workspace(ws2);
  }, 600_000);

  afterAll(async () => {
    const { closeDataLayer } = await import('../../../server/db/index.js');
    await closeDataLayer();
    await chain?.drop();
  });

  it('T1 conversation_ratings: 1–5, a bounded comment, one rating per closure, gone with the conversation', async () => {
    const cid = await conversation(ws);
    const closed = await message(cid, 'system');
    const insert = (score: unknown, comment: string | null = null, closedId = closed) => q(
      `INSERT INTO public.conversation_ratings (workspace_id, conversation_id, closed_message_id, operator_id, score, comment)
       VALUES ($1, $2, $3, $4, $5, $6)`, [ws, cid, closedId, op1, score, comment],
    );
    for (const bad of [0, 6]) expect(await errorOf(insert(bad))).toContain('conversation_ratings_score_check');
    expect(await errorOf(insert(5, 'x'.repeat(1001)))).toContain('conversation_ratings_comment_check');
    await insert(5, 'x'.repeat(1000));
    expect(await errorOf(insert(4))).toContain('conversation_ratings_closed_message_key');
    // Another closure of the same conversation is rated on its own.
    await insert(3, null, randomUUID());
    expect((await one(`SELECT count(*)::int AS n FROM public.conversation_ratings WHERE conversation_id = $1`, [cid])).n).toBe(2);
    await q(`DELETE FROM public.conversations WHERE id = $1`, [cid]);
    expect((await one(`SELECT count(*)::int AS n FROM public.conversation_ratings WHERE conversation_id = $1`, [cid])).n).toBe(0);
  });

  it('T2 conversation_transcript_emails: sent or failed, gone with the workspace', async () => {
    const wsGone = randomUUID();
    await workspace(wsGone);
    const cid = await conversation(wsGone);
    const insert = (s: string) => q(
      `INSERT INTO public.conversation_transcript_emails (workspace_id, conversation_id, status) VALUES ($1, $2, $3)`, [wsGone, cid, s],
    );
    await insert('sent');
    await insert('failed');
    expect(await errorOf(insert('queued'))).toContain('conversation_transcript_emails_status_check');
    await q(`DELETE FROM public.workspaces WHERE id = $1`, [wsGone]);
    expect((await one(`SELECT count(*)::int AS n FROM public.conversation_transcript_emails WHERE conversation_id = $1`, [cid])).n).toBe(0);
  });

  it('T3 only service_role reaches the tables and the queue function; every function pins its search_path', async () => {
    for (const t of TABLES) {
      expect((await one(`SELECT relrowsecurity AS r FROM pg_class WHERE oid = $1::regclass`, [`public.${t}`])).r, t).toBe(true);
      expect(await q(`SELECT policyname, roles::text AS roles FROM pg_policies WHERE schemaname = 'public' AND tablename = $1`, [t]))
        .toEqual([{ policyname: 'service_role_only', roles: '{service_role}' }]);
      for (const role of ['anon', 'authenticated']) {
        const priv = await one(
          `SELECT has_table_privilege($1, $2, 'SELECT') AS s, has_table_privilege($1, $2, 'INSERT') AS i,
                  has_table_privilege($1, $2, 'UPDATE') AS u, has_table_privilege($1, $2, 'DELETE') AS d`, [role, `public.${t}`],
        );
        expect(priv, `${role} on ${t}`).toEqual({ s: false, i: false, u: false, d: false });
        expect(await asRole(role, `SELECT * FROM public.${t}`), `${role} on ${t}`).toContain('permission denied');
      }
      expect((await one(`SELECT has_table_privilege('service_role', $1, 'INSERT') AS i`, [`public.${t}`])).i).toBe(true);
      expect(await asRole('service_role', `SELECT * FROM public.${t}`)).toBe('no error');
    }

    const fns = await q(
      `SELECT p.oid::regprocedure::text AS sig, p.prosecdef AS definer, p.proconfig AS config
         FROM pg_proc p
        WHERE p.pronamespace = 'public'::regnamespace
          AND p.proname IN ('chat_queue_status', 'chat_queue_record_claim', 'chat_queue_record_return', 'tg_conversation_message_reactions_touch_message')
        ORDER BY 1`,
    );
    expect(fns).toEqual([
      { sig: 'chat_queue_record_claim()', definer: true, config: ['search_path=public, pg_temp', 'lock_timeout=100ms'] },
      { sig: 'chat_queue_record_return()', definer: false, config: ['search_path=public, pg_temp'] },
      { sig: 'chat_queue_status(uuid,uuid)', definer: false, config: ['search_path=public, pg_temp'] },
      { sig: 'tg_conversation_message_reactions_touch_message()', definer: false, config: ['search_path=public, pg_temp'] },
    ]);
    for (const { sig } of fns) {
      for (const role of ['public', 'anon', 'authenticated']) {
        expect((await one(`SELECT has_function_privilege($1, $2, 'EXECUTE') AS x`, [role, `public.${sig}`])).x, `${role} ${sig}`).toBe(false);
      }
    }
    expect((await one(`SELECT has_function_privilege('service_role', 'public.chat_queue_status(uuid, uuid)', 'EXECUTE') AS x`)).x).toBe(true);
    expect(await asRole('authenticated', `SELECT * FROM public.chat_queue_status('${ws}', '${randomUUID()}')`)).toContain('permission denied');
    expect(await asRole('service_role', `SELECT * FROM public.chat_queue_status('${ws}', '${randomUUID()}')`)).toBe('no error');
  });

  it('T4 reactions: checks, one per (message, actor, emoji), and the message\'s sync cursor moves', async () => {
    const cid = await conversation(ws);
    const mid = await message(cid, 'agent');
    const react = (actorType: string, actorId: string | null, emoji = '❤️', messageId = mid) => q(
      `INSERT INTO public.conversation_message_reactions (workspace_id, conversation_id, message_id, actor_type, actor_id, emoji)
       VALUES ($1, $2, $3, $4, $5, $6)`, [ws, cid, messageId, actorType, actorId, emoji],
    );
    const unreact = (actorType: string, emoji = '❤️') => q(
      `DELETE FROM public.conversation_message_reactions WHERE message_id = $1 AND actor_type = $2 AND emoji = $3`, [mid, actorType, emoji],
    );
    const cursor = async () => String((await one(`SELECT updated_at::text AS u FROM public.conversation_messages WHERE id = $1`, [mid])).u);

    expect(await errorOf(react('visitor', op1))).toContain('conversation_message_reactions_actor_check');
    expect(await errorOf(react('operator', null))).toContain('conversation_message_reactions_actor_check');
    expect(await errorOf(react('bot', null))).toContain('conversation_message_reactions_actor_check');
    expect(await errorOf(react('visitor', null, ''))).toContain('conversation_message_reactions_emoji_check');
    expect(await errorOf(react('visitor', null, 'x'.repeat(17)))).toContain('conversation_message_reactions_emoji_check');

    const before = await cursor();
    await react('visitor', null);
    const afterAdd = await cursor();
    expect(afterAdd > before).toBe(true);
    // The visitor's NULL actor is one actor: a second heart is refused.
    expect(await errorOf(react('visitor', null))).toContain('conversation_message_reactions_one_per_actor');
    expect(await errorOf(react('operator', op1, '👍').then(() => react('operator', op1, '👍')))).toContain('conversation_message_reactions_one_per_actor');
    await react('operator', op2, '👍');
    await react('visitor', null, '👍');
    expect((await one(`SELECT count(*)::int AS n FROM public.conversation_message_reactions WHERE message_id = $1`, [mid])).n).toBe(4);

    const beforeRemove = await cursor();
    await unreact('visitor');
    expect(await cursor() > beforeRemove).toBe(true);

    // Only the reacted message moves; no conversation column is touched.
    const other = await message(cid, 'agent');
    const otherBefore = (await one(`SELECT updated_at::text AS u FROM public.conversation_messages WHERE id = $1`, [other])).u;
    const convBefore = (await one(`SELECT updated_at::text AS u FROM public.conversations WHERE id = $1`, [cid])).u;
    await react('visitor', null, '😂');
    expect((await one(`SELECT updated_at::text AS u FROM public.conversation_messages WHERE id = $1`, [other])).u).toBe(otherBefore);
    expect((await one(`SELECT updated_at::text AS u FROM public.conversations WHERE id = $1`, [cid])).u).toBe(convBefore);

    // Cascades: the message, then the conversation, take their reactions along.
    await react('visitor', null, '❤️', other);
    await q(`DELETE FROM public.conversation_messages WHERE id = $1`, [other]);
    expect((await one(`SELECT count(*)::int AS n FROM public.conversation_message_reactions WHERE message_id = $1`, [other])).n).toBe(0);
    await q(`DELETE FROM public.conversations WHERE id = $1`, [cid]);
    expect((await one(`SELECT count(*)::int AS n FROM public.conversation_message_reactions WHERE conversation_id = $1`, [cid])).n).toBe(0);
  });

  it('T5 chat_queue_status: the place by queued_at, what does not count, and the wait rule', async () => {
    const wq = randomUUID();
    await workspace(wq);
    const a = await queued(wq, 300);
    const b = await queued(wq, 200, {}, { queue_entry_position: 2 });
    const c = await queued(wq, 100, { status: 'pending' });
    // Ahead in time, but not waiting in this queue:
    await queued(wq, 400, { assigned_to: op1 });
    await queued(wq, 500, { status: 'resolved' });
    await queued(wq, 600, { status: 'closed' });
    await queued(wq, 700, { is_spam: true });
    await conversation(wq, { metadata: { routing_outcome: 'ai_answered', queued_at: '2000-01-01T00:00:00.000Z' } });
    await queued(ws2, 800);

    expect(await status(wq, a)).toEqual({ queue_position: 1, wait_minutes: null });
    expect(await status(wq, b)).toEqual({ queue_position: 2, wait_minutes: null });
    expect(await status(wq, c)).toEqual({ queue_position: 3, wait_minutes: null });

    // Not waiting: no row at all.
    expect(await status(wq, await conversation(wq))).toBeNull();
    expect(await status(wq, await queued(wq, 50, { assigned_to: op1 }))).toBeNull();
    expect(await status(wq, await queued(wq, 50, { status: 'resolved' }))).toBeNull();
    expect(await status(wq, await queued(wq, 50, { is_spam: true }))).toBeNull();
    expect(await status(ws2, a)).toBeNull();

    // Two queued at the same moment never share a place.
    const at = '2001-01-01T00:00:00.000Z';
    const wt = randomUUID();
    await workspace(wt);
    const [t1, t2] = [await conversation(wt, { metadata: { routing_outcome: 'manual_queue', queued_at: at } }),
      await conversation(wt, { metadata: { routing_outcome: 'manual_queue', queued_at: at } })];
    const places = [(await status(wt, t1))!.queue_position, (await status(wt, t2))!.queue_position].sort();
    expect(places).toEqual([1, 2]);
    expect((await status(wt, t1 < t2 ? t1 : t2))!.queue_position).toBe(1);

    // The wait: only from 3 samples on, ceil(seconds per place × place / 60).
    await q(`INSERT INTO public.chat_queue_stats (workspace_id, seconds_per_place, samples) VALUES ($1, 70, 2)`, [wq]);
    expect((await status(wq, c))!.wait_minutes).toBeNull();
    await q(`UPDATE public.chat_queue_stats SET samples = 3 WHERE workspace_id = $1`, [wq]);
    expect(await status(wq, a)).toEqual({ queue_position: 1, wait_minutes: 2 });
    expect(await status(wq, c)).toEqual({ queue_position: 3, wait_minutes: 4 });
    // At least a minute, never above 180.
    await q(`UPDATE public.chat_queue_stats SET seconds_per_place = 5 WHERE workspace_id = $1`, [wq]);
    expect((await status(wq, a))!.wait_minutes).toBe(1);
    await q(`UPDATE public.chat_queue_stats SET seconds_per_place = 3600 WHERE workspace_id = $1`, [wq]);
    expect((await status(wq, a))!.wait_minutes).toBe(60);
    expect((await status(wq, c))!.wait_minutes).toBe(180);
    await q(`UPDATE public.chat_queue_stats SET seconds_per_place = 3601 WHERE workspace_id = $1`, [wq]);
    expect(await status(wq, c)).toEqual({ queue_position: 3, wait_minutes: null });
    // Stats nobody refreshed for 14 days say nothing.
    await q(`UPDATE public.chat_queue_stats SET seconds_per_place = 70, updated_at = now() - interval '15 days' WHERE workspace_id = $1`, [wq]);
    expect(await status(wq, c)).toEqual({ queue_position: 3, wait_minutes: null });

    // The partial index serves the count.
    const def = await one(`SELECT pg_get_indexdef('public.conversations_manual_queue_idx'::regclass) AS d`);
    expect(String(def.d)).toContain(`(workspace_id, ((metadata ->> 'queued_at'::text)))`);
    expect(String(def.d)).toContain(`WHERE ((assigned_to IS NULL) AND ((metadata ->> 'routing_outcome'::text) = 'manual_queue'::text)`
      + ` AND (status = ANY (ARRAY['open'::conversation_status, 'pending'::conversation_status])) AND (is_spam = false))`);
    // The place's count (chat_queue_status's own predicate) is served by it
    // (seqscan off: the planner must find the index's predicate implied).
    await q('BEGIN');
    try {
      await q('SET LOCAL enable_seqscan = off');
      const pos = (await q(`EXPLAIN SELECT count(*) FROM public.conversations c
         WHERE c.workspace_id = $1 AND c.assigned_to IS NULL AND (c.metadata->>'routing_outcome') = 'manual_queue'
           AND (c.metadata->>'queued_at') <= '9999' AND c.status IN ('open', 'pending') AND c.is_spam = false`, [wq]))
        .map((r) => String(r['QUERY PLAN'])).join('\n');
      expect(pos).toContain('conversations_manual_queue_idx');
    } finally {
      await q('ROLLBACK');
    }
  });

  it('T6 the claim trigger samples the first assignment of a queued row only, and never fails it nor holds it up', async () => {
    const wc = randomUUID();
    await workspace(wc);
    const stats = async () => (await q(`SELECT seconds_per_place AS s, samples AS n FROM public.chat_queue_stats WHERE workspace_id = $1`, [wc]))[0] ?? null;
    const assign = (cid: string, to: string | null) => q(`UPDATE public.conversations SET assigned_to = $2 WHERE id = $1`, [cid, to]);

    // Not a queued row, or not its first assignment: nothing.
    const plain = await conversation(wc);
    await assign(plain, op1);
    const resolved = await queued(wc, 120, { status: 'resolved' });
    await assign(resolved, op1);
    const other = await queued(wc, 120);
    await q(`UPDATE public.conversations SET tags = ARRAY['vip'] WHERE id = $1`, [other]);
    await assign(other, null);
    expect(await stats()).toBeNull();

    // Waited 120 s, entered at place 2: 60 s per place.
    const first = await queued(wc, 120, {}, { queue_entry_position: 2 });
    await assign(first, op1);
    let s = await stats();
    expect(s!.n).toBe(1);
    expect(Number(s!.s)).toBeCloseTo(60, 0);
    // Reassigned to someone else: not a claim from the queue.
    await assign(first, op2);
    expect((await stats())!.n).toBe(1);

    // The next claim moves the average by 0.3: 60 × 0.7 + 30 × 0.3 = 51.
    await assign(await queued(wc, 30), op1);
    s = await stats();
    expect(s!.n).toBe(2);
    expect(Number(s!.s)).toBeCloseTo(51, 0);

    // A malformed queued_at, a wait over a day: the assignment goes through, no sample.
    const broken = await conversation(wc, { metadata: { routing_outcome: 'manual_queue', queued_at: 'yesterday-ish' } });
    await assign(broken, op1);
    expect((await one(`SELECT assigned_to FROM public.conversations WHERE id = $1`, [broken])).assigned_to).toBe(op1);
    await assign(await queued(wc, 90_000), op1);
    const badPlace = await queued(wc, 60, {}, { queue_entry_position: 'second' });
    await assign(badPlace, op1);
    expect((await one(`SELECT assigned_to FROM public.conversations WHERE id = $1`, [badPlace])).assigned_to).toBe(op1);
    expect((await stats())!.n).toBe(2);

    // A claim that rewrites the queue state in the same UPDATE is sampled
    // from the state it was claimed in.
    const rewritten = await queued(wc, 60);
    await q(`UPDATE public.conversations SET assigned_to = $2, metadata = metadata - 'queued_at' - 'routing_outcome' WHERE id = $1`, [rewritten, op1]);
    expect((await stats())!.n).toBe(3);

    // After 14 idle days the average starts again from the new sample.
    await q(`UPDATE public.chat_queue_stats SET updated_at = now() - interval '15 days' WHERE workspace_id = $1`, [wc]);
    await assign(await queued(wc, 200), op1);
    s = await stats();
    expect(s!.n).toBe(1);
    expect(Number(s!.s)).toBeCloseTo(200, 0);

    // The stats row is locked by another transaction (a claim that has not
    // committed yet): the next assignment neither waits for it nor fails; it
    // goes without its sample.
    const holder = new pg.Client({ connectionString: chain.url });
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`UPDATE public.chat_queue_stats SET samples = samples WHERE workspace_id = $1`, [wc]);
      const waiting = await queued(wc, 45);
      const started = Date.now();
      const outcome = await Promise.race([
        assign(waiting, op2).then(() => 'assigned', (e: Error) => e.message),
        new Promise<string>((done) => setTimeout(() => done('still waiting'), 5_000)),
      ]);
      expect(outcome).toBe('assigned');
      expect(Date.now() - started).toBeLessThan(2_000);
      expect((await one(`SELECT assigned_to FROM public.conversations WHERE id = $1`, [waiting])).assigned_to).toBe(op2);
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      await holder.end();
    }
    expect((await stats())!.n).toBe(1);

    const trg = await one(`SELECT pg_get_triggerdef(oid) AS d FROM pg_trigger WHERE tgname = 'trg_conversations_queue_claim'`);
    expect(String(trg.d)).toContain('AFTER UPDATE OF assigned_to ON public.conversations FOR EACH ROW WHEN');
  }, 30_000);

  it('T6b a hand-back keeps the place, records its return, and the next claim is measured from it', async () => {
    const wr = randomUUID();
    await workspace(wr);
    const stats = async () => (await q(`SELECT seconds_per_place AS s, samples AS n FROM public.chat_queue_stats WHERE workspace_id = $1`, [wr]))[0] ?? null;
    const meta = async (cid: string) => (await one(`SELECT metadata FROM public.conversations WHERE id = $1`, [cid])).metadata as Row;
    const assign = (cid: string, to: string | null) => q(`UPDATE public.conversations SET assigned_to = $2 WHERE id = $1`, [cid, to]);

    // Three in the queue; the oldest is claimed after waiting an hour.
    const oldest = await queued(wr, 3600);
    const second = await queued(wr, 1800);
    const third = await queued(wr, 900);
    await assign(oldest, op1);
    expect((await stats())!.n).toBe(1);
    expect(Number((await stats())!.s)).toBeCloseTo(3600, -1);
    // Held by op1 for "an hour" (its stamp moved back), then handed back.
    const queuedAt = (await one(`SELECT to_char((now() - interval '2 hours') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at`)).at;
    await q(`UPDATE public.conversations SET metadata = jsonb_set(metadata, '{queued_at}', to_jsonb($2::text)) WHERE id = $1`, [oldest, queuedAt]);
    await assign(oldest, null);
    const back = await meta(oldest);
    // Its place is kept (queued_at untouched: first), the return is recorded, at place 1.
    expect(back.queued_at).toBe(queuedAt);
    expect(typeof back.queue_reentered_at).toBe('string');
    expect(Math.abs(Date.parse(String(back.queue_reentered_at)) - Date.now())).toBeLessThan(60_000);
    expect(back.queue_entry_position).toBe(1);
    expect(await status(wr, oldest)).toMatchObject({ queue_position: 1 });
    expect(await status(wr, second)).toMatchObject({ queue_position: 2 });
    expect(await status(wr, third)).toMatchObject({ queue_position: 3 });
    // Claimed again 30 s after its return: sampled from the return (≈30 s), not from queued_at (2 h).
    await q(`UPDATE public.conversations SET metadata = jsonb_set(metadata, '{queue_reentered_at}', to_jsonb($2::text)) WHERE id = $1`,
      [oldest, (await one(`SELECT to_char((now() - interval '30 seconds') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at`)).at]);
    await assign(oldest, op2);
    const s = await stats();
    expect(s!.n).toBe(2);
    expect(Number(s!.s)).toBeCloseTo(3600 * 0.7 + 30 * 0.3, -1);

    // A later hand-back of the second one: the first is assigned now, so the
    // second comes back at place 1.
    await assign(second, op1);
    await assign(second, null);
    expect((await meta(second)).queue_entry_position).toBe(1);
    expect((await meta(third)).queue_reentered_at).toBeUndefined();

    // Not a hand-back: an unqueued conversation, a transfer, a resolved or
    // spam one, an UPDATE that takes it out of the queue at the same time.
    const plain = await conversation(wr, { assigned_to: op1 });
    await assign(plain, null);
    expect((await meta(plain)).queue_reentered_at).toBeUndefined();
    const transferred = await queued(wr, 60, { assigned_to: op1 });
    await assign(transferred, op2);
    expect((await meta(transferred)).queue_reentered_at).toBeUndefined();
    const resolved = await queued(wr, 60, { assigned_to: op1, status: 'resolved' });
    await assign(resolved, null);
    expect((await meta(resolved)).queue_reentered_at).toBeUndefined();
    const spam = await queued(wr, 60, { assigned_to: op1, is_spam: true });
    await assign(spam, null);
    expect((await meta(spam)).queue_reentered_at).toBeUndefined();
    const out = await queued(wr, 60, { assigned_to: op1 });
    await q(`UPDATE public.conversations SET assigned_to = NULL, metadata = metadata - 'routing_outcome' WHERE id = $1`, [out]);
    expect((await meta(out)).queue_reentered_at).toBeUndefined();

    // A malformed queued_at never fails the hand-back.
    const broken = await conversation(wr, { assigned_to: op1, metadata: { routing_outcome: 'manual_queue', queued_at: 'yesterday-ish' } });
    await assign(broken, null);
    expect((await one(`SELECT assigned_to FROM public.conversations WHERE id = $1`, [broken])).assigned_to).toBeNull();

    const trg = await one(`SELECT pg_get_triggerdef(oid) AS d FROM pg_trigger WHERE tgname = 'trg_conversations_queue_return'`);
    expect(String(trg.d)).toContain('BEFORE UPDATE OF assigned_to ON public.conversations FOR EACH ROW WHEN');
  }, 30_000);

  it('T7 knowledge_base_articles.author_user_id: a validated key to profiles, NULL when the profile goes', async () => {
    const col = await one(`SELECT data_type, is_nullable, column_default FROM information_schema.columns
                            WHERE table_schema = 'public' AND table_name = 'knowledge_base_articles' AND column_name = 'author_user_id'`);
    expect(col).toEqual({ data_type: 'uuid', is_nullable: 'YES', column_default: null });
    const fk = await one(`SELECT convalidated AS v, pg_get_constraintdef(oid) AS d FROM pg_constraint
                           WHERE conname = 'knowledge_base_articles_author_user_id_fkey'`);
    expect(fk).toEqual({ v: true, d: 'FOREIGN KEY (author_user_id) REFERENCES profiles(id) ON DELETE SET NULL' });
    const idx = await one(`SELECT pg_get_indexdef('public.idx_knowledge_base_articles_author'::regclass) AS d`);
    expect(String(idx.d)).toContain('WHERE (author_user_id IS NOT NULL)');

    const author = randomUUID();
    await profile(author);
    const article = randomUUID();
    await q(`INSERT INTO public.knowledge_base_articles (id, workspace_id, slug, title, author_user_id) VALUES ($1, $2, 'a', 'A', $3)`, [article, ws, author]);
    expect(await errorOf(q(`UPDATE public.knowledge_base_articles SET author_user_id = $2 WHERE id = $1`, [article, randomUUID()])))
      .toContain('knowledge_base_articles_author_user_id_fkey');
    await q(`DELETE FROM public.profiles WHERE id = $1`, [author]);
    expect((await one(`SELECT author_user_id FROM public.knowledge_base_articles WHERE id = $1`, [article])).author_user_id).toBeNull();
  });

  it('T8 the transcript email: both editions in fa/en/tr, an edited row kept, visitor text taken literally', async () => {
    const rows = await q(
      `SELECT edition, locale, subject, html_body, text_body FROM public.email_templates
        WHERE workspace_id IS NULL AND slug = 'visitor_conversation_transcript' ORDER BY 1, 2`,
    );
    expect(rows.map((r) => `${r.edition}/${r.locale}`)).toEqual([
      'international/en', 'international/fa', 'international/tr', 'iran/en', 'iran/fa', 'iran/tr',
    ]);
    for (const r of rows) {
      const html = String(r.html_body);
      const text = String(r.text_body);
      expect(String(r.subject), `${r.edition}/${r.locale}`).toContain('{workspace_name}');
      for (const v of ['{workspace}', '{date}', '{transcript}', '{year}', '{brand}']) expect(html, v).toContain(v);
      expect(html).toContain(r.locale === 'fa' ? 'dir="rtl"' : 'dir="ltr"');
      expect(text).toContain('{transcript_text}');
      expect(text).toContain('{workspace_name}');
      expect(text).not.toContain('{transcript}');
      expect(text).not.toContain('{workspace}');
    }
    expect(String(rows.find((r) => r.edition === 'iran' && r.locale === 'fa')!.subject)).toBe('متن گفتگوی شما با {workspace_name}');
    expect(String(rows.find((r) => r.locale === 'en')!.subject)).toBe('Your conversation with {workspace_name}');
    expect(String(rows.find((r) => r.locale === 'tr')!.subject)).toBe('{workspace_name} ile sohbetiniz');
    // The same text in both editions (the brand comes from {brand}).
    for (const locale of ['fa', 'en', 'tr']) {
      const pair = rows.filter((r) => r.locale === locale);
      expect(pair[0].html_body).toBe(pair[1].html_body);
    }

    await q(`UPDATE public.email_templates SET subject = 'EDITED {workspace_name}'
              WHERE workspace_id IS NULL AND edition = 'international' AND slug = 'visitor_conversation_transcript' AND locale = 'en'`);
    const count = async () => (await one(`SELECT count(*)::int AS n FROM public.email_templates`)).n;
    const before = await count();
    await applyMigrationSql(chain.db, readFileSync(FILE, 'utf8'));
    expect(await count()).toBe(before);
    expect((await one(`SELECT subject FROM public.email_templates WHERE workspace_id IS NULL AND edition = 'international'
                         AND slug = 'visitor_conversation_transcript' AND locale = 'en'`)).subject).toBe('EDITED {workspace_name}');

    // Through the real sendEmail: replacement patterns and placeholders in
    // the visitor's text arrive as typed.
    Object.assign(process.env, {
      DATABASE_URL: chain.url,
      PLATFORM_SIGNING_SECRET: 'signing-secret-for-this-test-only-0123456789',
      SUPABASE_URL: 'https://legacy-project.supabase.co',
      SUPABASE_ANON_KEY: 'legacy-anon-key-value',
      SUPABASE_SERVICE_ROLE_KEY: 'legacy-service-role-key-value-at-least-32',
      CORS_ORIGINS: 'http://127.0.0.1',
    });
    delete process.env.DATABASE_MODE;
    await q(
      `INSERT INTO public.app_runtime_config (key, value) VALUES ('default_email_provider', $1::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [JSON.stringify({ provider_name: 'resend', config: { api_key: 're_test', from_email: 'no-reply@example.test', from_name: 'Sender' } })],
    );
    await q(`UPDATE public.platform_settings SET region_mode = 'multi', active_locales = ARRAY['en', 'fa', 'tr']`);
    const { loadConfig } = await import('../../../server/config.js');
    const { sendEmail } = await import('../../../server/services/email/index.js');
    (await import('../../../server/services/platformRegion.js')).invalidatePlatformRegionCache();
    const visitorText = `Price: $& and $' and $\` and $1 and $$ and {brand} and {workspace}`;
    const res = await sendEmail(loadConfig(), {
      workspaceId: null,
      to: 'visitor@example.test',
      templateSlug: 'visitor_conversation_transcript',
      locale: 'tr',
      templateData: {
        workspace: 'Acme &amp; Co $1',
        workspace_name: 'Acme & Co $1',
        date: '18.10.2026',
        transcript: `<tr><td>${visitorText}</td></tr>`,
        transcript_text: visitorText,
      },
    });
    expect(res.success).toBe(true);
    const mail = sent[sent.length - 1];
    expect(mail.subject).toBe('Acme & Co $1 ile sohbetiniz');
    expect(mail.html).toContain(`<tr><td>${visitorText}</td></tr>`);
    expect(mail.html).toContain('<h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;">Acme &amp; Co $1</h1>');
    expect(mail.text).toContain(visitorText);

    // Per-part data (htmlData): the owners' offline-message mail takes the
    // escaped copy of the visitor's text in its HTML only, so it never runs
    // markup. Since 289d its seeded subject names no visitor field and its
    // seeded text part is made from that HTML, so the text shows what was
    // typed, with no entity.
    const name = '<b>Ali</b> & "co"';
    const body = '<img src=x onerror="alert(1)"> & 5 > 3';
    const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const offline = await sendEmail(loadConfig(), {
      workspaceId: null,
      to: 'owner@example.test',
      templateSlug: 'offline_message_received',
      locale: 'en',
      templateData: { contact_name: name, contact_email: 'ali@example.test', message_body: body, action_url: 'https://app.test/inbox?c=1' },
      htmlData: { contact_name: esc(name), contact_email: 'ali@example.test', message_body: esc(body), action_url: 'https://app.test/inbox?c=1' },
    });
    expect(offline.success).toBe(true);
    const owner = sent[sent.length - 1];
    expect(owner.subject).toBe('New offline message');
    expect(owner.text).toContain(name);
    expect(owner.text).toContain(body);
    expect(owner.text).not.toContain('&amp;');
    expect(owner.html).toContain(`<strong>${esc(name)}</strong>`);
    expect(owner.html).toContain(esc(body));
    expect(owner.html).not.toContain('<img src=x');
    expect(owner.html).not.toContain('<b>Ali</b>');

    // A value typed with line breaks: the subject stays one header line.
    const broken = await sendEmail(loadConfig(), {
      workspaceId: null,
      to: 'owner@example.test',
      templateSlug: 'visitor_conversation_transcript',
      locale: 'tr',
      templateData: { workspace: 'Acme', workspace_name: 'Acme\r\nBcc: x@evil.test\nX', date: '18.10.2026', transcript: '', transcript_text: '' },
    });
    expect(broken.success).toBe(true);
    expect(sent[sent.length - 1].subject).toBe('Acme Bcc: x@evil.test X ile sohbetiniz');
  });

  it('T9 276 runs twice: every check, policy and trigger once, and a re-run waits for no ordinary writer', async () => {
    const writer = new pg.Client({ connectionString: chain.url });
    const runner = new pg.Client({ connectionString: chain.url });
    await Promise.all([writer.connect(), runner.connect()]);
    try {
      // Ordinary writers hold ROW EXCLUSIVE; the first run's CREATE TRIGGER
      // and foreign keys would wait for them, a re-run takes none of those locks.
      await writer.query('BEGIN');
      for (const t of ['conversations', 'conversation_messages', 'workspaces', 'profiles', 'knowledge_base_articles', 'email_templates']) {
        await writer.query(`LOCK TABLE public.${t} IN ROW EXCLUSIVE MODE`);
      }
      const outcome = await Promise.race([
        applyMigrationSql(runner, readFileSync(FILE, 'utf8')).then(() => 'applied', (e: Error) => e.message),
        new Promise<string>((done) => setTimeout(() => done('still waiting'), 12_000)),
      ]);
      expect(outcome).toBe('applied');
    } finally {
      await writer.query('ROLLBACK').catch(() => undefined);
      await Promise.all([writer.end(), runner.end()]);
    }
    const constraints = await q(`SELECT conname FROM pg_constraint WHERE conname LIKE ANY (ARRAY[
        'conversation_ratings_%', 'conversation_transcript_emails_%', 'conversation_message_reactions_%',
        'chat_queue_stats_%', 'knowledge_base_articles_author_user_id_fkey']) ORDER BY 1`);
    expect(constraints.map((c) => c.conname)).toEqual([
      'chat_queue_stats_pkey',
      'chat_queue_stats_samples_check',
      'chat_queue_stats_seconds_per_place_check',
      'chat_queue_stats_workspace_id_fkey',
      'conversation_message_reactions_actor_check',
      'conversation_message_reactions_conversation_id_fkey',
      'conversation_message_reactions_emoji_check',
      'conversation_message_reactions_message_id_fkey',
      'conversation_message_reactions_one_per_actor',
      'conversation_message_reactions_pkey',
      'conversation_message_reactions_workspace_id_fkey',
      'conversation_ratings_closed_message_key',
      'conversation_ratings_comment_check',
      'conversation_ratings_conversation_id_fkey',
      'conversation_ratings_pkey',
      'conversation_ratings_score_check',
      // 284's (the full chain runs to the end): the rating's subject, 'human' or 'ai'.
      'conversation_ratings_subject_check',
      'conversation_ratings_workspace_id_fkey',
      'conversation_transcript_emails_conversation_id_fkey',
      'conversation_transcript_emails_pkey',
      'conversation_transcript_emails_status_check',
      'conversation_transcript_emails_workspace_id_fkey',
      'knowledge_base_articles_author_user_id_fkey',
    ]);
    expect((await q(`SELECT tgname FROM pg_trigger WHERE tgname IN ('trg_conversations_queue_claim', 'trg_conversations_queue_return', 'trg_conversation_message_reactions_touch_message') ORDER BY 1`))
      .map((r) => r.tgname)).toEqual(['trg_conversation_message_reactions_touch_message', 'trg_conversations_queue_claim', 'trg_conversations_queue_return']);
    expect((await one(`SELECT count(*)::int AS n FROM pg_policies WHERE tablename = ANY ($1)`, [TABLES])).n).toBe(4);
    expect((await one(`SELECT count(*)::int AS n FROM public.email_templates WHERE slug = 'visitor_conversation_transcript'`)).n).toBe(6);
  }, 30_000);

  it('T10 276 sets its own lock_timeout: with no PGOPTIONS it gives up instead of queueing chat writes, and resets it', async () => {
    // A database where the trigger is still to be made: CREATE TRIGGER needs
    // a lock every writer of conversations conflicts with.
    await q(`DROP TRIGGER trg_conversations_queue_claim ON public.conversations`);
    const locker = new pg.Client({ connectionString: chain.url });
    const runner = new pg.Client({ connectionString: chain.url });
    await Promise.all([locker.connect(), runner.connect()]);
    try {
      expect((await runner.query('SHOW lock_timeout')).rows[0].lock_timeout).toBe('0');
      await locker.query('BEGIN');
      await locker.query('LOCK TABLE public.conversations IN ROW EXCLUSIVE MODE');
      const started = Date.now();
      const outcome = await Promise.race([
        applyMigrationSql(runner, readFileSync(FILE, 'utf8')).then(() => 'applied', (e: Error) => e.message),
        new Promise<string>((done) => setTimeout(() => done('still waiting'), 12_000)),
      ]);
      expect(outcome).toContain('lock timeout');
      expect(Date.now() - started).toBeLessThan(12_000);
      await locker.query('COMMIT');
      // Simply run again: it completes, and leaves the session's setting as it found it.
      await applyMigrationSql(runner, readFileSync(FILE, 'utf8'));
      expect((await runner.query('SHOW lock_timeout')).rows[0].lock_timeout).toBe('0');
    } finally {
      await locker.query('ROLLBACK').catch(() => undefined);
      await Promise.all([locker.end(), runner.end()]);
    }
    expect((await q(`SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = 'trg_conversations_queue_claim'`))[0].n).toBe(1);
  }, 30_000);
});
