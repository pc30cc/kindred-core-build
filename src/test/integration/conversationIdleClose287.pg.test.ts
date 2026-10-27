// @vitest-environment node
/**
 * 287 — a pre-chat wait counts only while nobody holds the conversation
 * (owner, 2026-10-27), on a real database: the chain up to 286, then 287
 * applied to it as WebYar's is by hand.
 *
 *   Before 287 an answered, quiet widget conversation a person holds whose
 *   metadata still says routing_pending (they answered before routing ran,
 *   so nothing cleared it) reads 'routing' and is never closed. A dry run in
 *   BEGIN … ROLLBACK leaves no trace. After it: that conversation (open or
 *   resolved) is due, conversation_idle_due() lists it and the close takes
 *   it (writing no routing key); an unassigned one carrying the flag still
 *   reads 'routing'; a held one whose visitor waits reads needs_reply, as
 *   before; the other routing conditions (the manual queue, a routing wait,
 *   a pre-chat deadline, a first-response timeout) hold as they did; and no
 *   other fixture's verdict moves, but held, flagged ones that something
 *   else holds back (a callback, a live call, a guidance request), which the
 *   next guard now names; a recent one stays recent, a Bale one closes like
 *   the widget's, and one untouched for 30 days is due but the timer's list
 *   leaves it to the backlog script. The rollout's dry-run query counts all
 *   of that. A second run changes nothing; the function stays
 *   service_role's; without 286 the file stops.
 *
 * Driven by TEST_DATABASE_URL; skipped without it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { applyMigrationSql } from './pgMigrationChain';

const DSN = process.env.TEST_DATABASE_URL;
const suite = DSN ? describe : describe.skip;

type Row = Record<string, unknown>;

const MIGRATION = resolve(process.cwd(), 'database/migrations/287_inactivity_close_prechat_wait_assigned.sql');
const MIGRATION_285 = resolve(process.cwd(), 'database/migrations/285_inactivity_close_app_review_workspace.sql');

suite('287 — a pre-chat wait counts only while nobody holds the conversation (real PostgreSQL: the chain to 286, then 287)', () => {
  let admin: pg.Client;
  let db: pg.Client;
  const name = `idle_close_287_${Date.now()}`;
  const q = async (sql: string, p: unknown[] = []): Promise<Row[]> => (await db.query(sql, p)).rows as Row[];
  const one = async (sql: string, p: unknown[] = []): Promise<Row> => (await q(sql, p))[0];

  const owner = randomUUID();
  const ws = randomUUID();
  const review = randomUUID();
  const f: Record<string, string> = {};
  /** routing_pending as deferRoutingForPrechat writes it. */
  const PRECHAT = { routing_pending: true, routing_pending_at: '2026-10-27T08:00:00.000Z' };

  /** A message `ago` (plus `earlier`) before now. */
  const message = async (cid: string, sender: string, ago: string, body = 'سلام', earlier = '0 seconds') => {
    await q(`INSERT INTO public.conversation_messages (id, conversation_id, sender_type, sender_id, body, metadata, created_at)
             VALUES ($1, $2, $3::sender_type, $4, $5, '{}'::jsonb, now() - $6::interval - $7::interval)`,
    [randomUUID(), cid, sender, sender === 'agent' ? owner : null, body, ago, earlier]);
  };
  /**
   * A widget conversation last touched 30 hours ago (created two hours
   * before that): the visitor asked an hour before the team's answer, unless
   * `owed` (then the visitor's turn is the last).
   */
  const conversation = async (meta: Row, o: { assigned?: boolean; owed?: boolean; spam?: boolean; status?: string; workspace?: string } = {}) => {
    const id = randomUUID();
    await q(`INSERT INTO public.conversations (id, workspace_id, status, assigned_to, metadata, created_at, updated_at, is_spam)
             VALUES ($1, $2, $3::conversation_status, $4, $5::jsonb, now() - interval '32 hours', now() - interval '30 hours', $6)`,
    [id, o.workspace ?? ws, o.status ?? 'open', o.assigned ? owner : null, JSON.stringify({ visitor_id: `v-${id.slice(0, 8)}`, ...meta }), o.spam ?? false]);
    await message(id, 'contact', '30 hours', 'سلام', o.owed ? '0 seconds' : '1 hour');
    if (!o.owed) await message(id, 'agent', '30 hours', 'بفرمایید');
    return id;
  };
  /** A call on the conversation, not connected (so no exchange). */
  const liveCall = (cid: string) => q(
    `INSERT INTO public.call_sessions (workspace_id, provider, call_type, context_type, context_id, state, created_at)
     VALUES ($1, 'livekit', 'audio', 'conversation', $2, 'active', now() - interval '1 hour')`, [ws, cid],
  );
  const guidance = (cid: string) => q(
    `INSERT INTO public.ai_agent_guidance_requests (workspace_id, conversation_id, question, status) VALUES ($1, $2, 'چه بگویم؟', 'pending')`, [ws, cid],
  );
  const routingState = (cid: string, cols: Row) => q(
    `INSERT INTO public.chat_routing_state (conversation_id, workspace_id, ${Object.keys(cols).join(', ')})
     VALUES ($1, $2, ${Object.keys(cols).map((_, i) => `$${i + 3}::timestamptz`).join(', ')})`,
    [cid, ws, ...Object.values(cols)],
  );

  const verdict = async (cid: string) => (await one(`SELECT verdict FROM public.conversation_idle_check($1)`, [cid])).verdict;
  const dueIds = async () => (await q(`SELECT due_conversation_id FROM public.conversation_idle_due(500)`)).map((r) => r.due_conversation_id as string).sort();
  /** Every fixture's verdict, by id. */
  const allVerdicts = async () => Object.fromEntries((await q(
    `SELECT c.id, chk.verdict FROM public.conversations c CROSS JOIN LATERAL public.conversation_idle_check(c.id) chk ORDER BY c.id`,
  )).map((r) => [r.id as string, r.verdict as string]));
  const definition = async () => (await one(`SELECT pg_get_functiondef('public.conversation_idle_check(uuid)'::regprocedure) AS def`)).def as string;
  /**
   * CHAT_ROUTING.md "Rollout of 287"'s dry-run query: the live rows carrying
   * the flag, by holder, status, verdict and whether chat_routing_state
   * still records a wait for them; due rows untouched for 30 days apart.
   */
  const flaggedByVerdict = () => q(
    `SELECT (c.assigned_to IS NOT NULL) AS held, c.status::text AS status, chk.verdict,
            EXISTS (SELECT 1 FROM public.chat_routing_state s
                     WHERE s.conversation_id = c.id
                       AND (s.waiting_since IS NOT NULL OR s.prechat_deadline IS NOT NULL OR s.timeout_due_at IS NOT NULL)) AS routing_state,
            count(*)::int AS n,
            (count(*) FILTER (WHERE chk.verdict = 'due' AND c.updated_at < now() - interval '30 days'))::int AS untouched_30d
       FROM public.conversations c
       CROSS JOIN LATERAL public.conversation_idle_check(c.id) chk
      WHERE c.status IN ('open', 'pending', 'resolved')
        AND c.metadata->>'routing_pending' = 'true'
      GROUP BY 1, 2, 3, 4 ORDER BY 1, 2, 3, 4`,
  );
  let before287: Record<string, string> = {};

  beforeAll(async () => {
    const adminUrl = new URL(DSN!);
    adminUrl.pathname = '/postgres';
    admin = new pg.Client({ connectionString: adminUrl.toString() });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${name}`);
    await admin.query(`CREATE DATABASE ${name}`);
    const u = new URL(DSN!);
    u.pathname = `/${name}`;
    db = new pg.Client({ connectionString: u.toString() });
    await db.connect();
    await db.query('SET client_min_messages = warning');
    const dir = resolve(process.cwd(), 'database/migrations');
    for (const file of readdirSync(dir).filter((x) => x.endsWith('.sql') && x < '287').sort()) {
      await applyMigrationSql(db, readFileSync(resolve(dir, file), 'utf8'));
    }

    await q(`INSERT INTO public.profiles (id, email, full_name) VALUES ($1, $2, 'Owner')`, [owner, `p-${owner.slice(0, 8)}@test.local`]);
    for (const [id, title, slug] of [[ws, 'Acme', `ws-${ws.slice(0, 8)}`], [review, 'App Review', 'ws_appreview']]) {
      await q(`INSERT INTO public.workspaces (id, name, slug, owner_id) VALUES ($1, $2, $3, $4)`, [id, title, slug, owner]);
      await q(`INSERT INTO public.workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner') ON CONFLICT DO NOTHING`, [id, owner]);
    }
    await q(`INSERT INTO public.widget_settings (workspace_id, enabled) VALUES ($1, true) ON CONFLICT (workspace_id) DO NOTHING`, [ws]);
    await q(`UPDATE public.widget_platform_settings SET inactivity_close_enabled = true, inactivity_close_default_hours = 24`);

    // The defect: a person answered before routing ran, so the flag stayed.
    f.heldFlagged = await conversation(PRECHAT, { assigned: true });
    // Nobody holds it: routing is still owed.
    f.unassignedFlagged = await conversation(PRECHAT);
    // Held and flagged, the visitor waiting (WebYar's 2 rows on 2026-10-27).
    f.heldOwed = await conversation(PRECHAT, { assigned: true, owed: true });
    // Held and flagged, with a routing wait, a pre-chat deadline or a first-response timeout still recorded.
    f.heldWaiting = await conversation(PRECHAT, { assigned: true });
    await routingState(f.heldWaiting, { waiting_since: new Date(Date.now() - 60_000).toISOString() });
    f.heldDeadline = await conversation(PRECHAT, { assigned: true });
    await routingState(f.heldDeadline, { prechat_deadline: new Date(Date.now() + 60_000).toISOString() });
    f.heldTimeout = await conversation({}, { assigned: true });
    await routingState(f.heldTimeout, { timeout_due_at: new Date(Date.now() + 60_000).toISOString() });
    // The manual queue counts only while unassigned (286 already).
    const queued = { queued_at: new Date(Date.now() - 31 * 3600_000).toISOString(), routing_outcome: 'manual_queue' };
    f.unassignedQueued = await conversation(queued);
    f.heldQueued = await conversation(queued, { assigned: true });
    // Held and flagged, with something else the team owes: the next guard says so.
    f.heldHandoff = await conversation({ ...PRECHAT, ai_state: 'needs_human' }, { assigned: true });
    f.heldCallback = await conversation(PRECHAT, { assigned: true });
    await q(`INSERT INTO public.callback_requests (workspace_id, conversation_id, status) VALUES ($1, $2, 'scheduled')`, [ws, f.heldCallback]);
    f.heldCall = await conversation(PRECHAT, { assigned: true });
    await liveCall(f.heldCall);
    f.heldGuidance = await conversation(PRECHAT, { assigned: true });
    await guidance(f.heldGuidance);
    // Held and flagged, answered an hour ago: inside the window either way.
    f.heldRecent = await conversation(PRECHAT, { assigned: true });
    await message(f.heldRecent, 'agent', '1 hour', 'خواهش می‌کنم');
    // Held and flagged on a channel (Bale): the same rule (286 closes every channel).
    f.channelFlagged = await conversation({ ...PRECHAT, channel: 'bale', channel_chat_id: 'bale-chat-flagged' }, { assigned: true });
    // Held and flagged, untouched for 31 days: due, but the timer's list leaves it to the backlog script.
    f.heldOld = await conversation(PRECHAT, { assigned: true });
    await q(`UPDATE public.conversations SET created_at = created_at - interval '31 days', updated_at = updated_at - interval '31 days' WHERE id = $1`, [f.heldOld]);
    await q(`UPDATE public.conversation_messages SET created_at = created_at - interval '31 days' WHERE conversation_id = $1`, [f.heldOld]);
    // The same guards without the flag: unchanged by 287.
    f.call = await conversation({}, { assigned: true });
    await liveCall(f.call);
    f.guidance = await conversation({}, { assigned: true });
    await guidance(f.guidance);
    f.channel = await conversation({ channel: 'bale', channel_chat_id: 'bale-chat-plain' }, { assigned: true });
    // Unchanged by the flag either way.
    f.plain = await conversation({}, { assigned: true });
    f.exempt = await conversation(PRECHAT, { assigned: true, workspace: review });
    f.spam = await conversation(PRECHAT, { assigned: true, spam: true });
    f.closed = await conversation(PRECHAT, { assigned: true, status: 'closed' });
    f.resolved = await conversation(PRECHAT, { assigned: true, status: 'resolved' });
  }, 600_000);

  afterAll(async () => {
    await db?.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end();
    }
  });

  it('before 287 (at 286): a held conversation still carrying the flag reads routing, and nothing closes it', async () => {
    before287 = await allVerdicts();
    expect(await verdict(f.heldFlagged)).toBe('routing');
    expect(await verdict(f.heldCallback)).toBe('routing');
    expect(await verdict(f.resolved)).toBe('routing');
    expect(await verdict(f.unassignedFlagged)).toBe('routing');
    expect(await verdict(f.heldOwed)).toBe('needs_reply');
    for (const k of ['heldCall', 'heldGuidance', 'channelFlagged', 'heldOld']) expect(await verdict(f[k]), k).toBe('routing');
    expect(await verdict(f.heldRecent)).toBe('recent');
    expect([await verdict(f.call), await verdict(f.guidance), await verdict(f.channel)]).toEqual(['call', 'guidance', 'due']);
    expect(await verdict(f.plain)).toBe('due');
    expect(await verdict(f.heldQueued)).toBe('due');
    expect(await dueIds()).toEqual([f.plain, f.heldQueued, f.channel].sort());
    expect(await one(`SELECT * FROM public.conversation_close_if_idle($1, (SELECT updated_at FROM public.conversations WHERE id = $1), 'timer', NULL, NULL)`, [f.heldFlagged]))
      .toMatchObject({ closed: false, outcome: 'routing' });
  });

  it('a dry run of 287 in BEGIN … ROLLBACK leaves no trace', async () => {
    const def = await definition();
    await q('BEGIN');
    try {
      await applyMigrationSql(db, readFileSync(MIGRATION, 'utf8'));
      expect(await verdict(f.heldFlagged)).toBe('due');
    } finally {
      await q('ROLLBACK');
    }
    expect(await verdict(f.heldFlagged)).toBe('routing');
    expect(await definition()).toBe(def);
  });

  it('after 287: the held, answered, quiet conversations are due and listed; only held, flagged ones change verdict', async () => {
    const flaggedBefore = await flaggedByVerdict();
    await applyMigrationSql(db, readFileSync(MIGRATION, 'utf8'));
    expect(await one(`SELECT verdict, idle_hours, closed_outcome FROM public.conversation_idle_check($1)`, [f.heldFlagged]))
      .toEqual({ verdict: 'due', idle_hours: 24, closed_outcome: 'human' });
    // heldOld is due too, but untouched for 30 days: not the timer's.
    expect(await dueIds()).toEqual([f.plain, f.heldQueued, f.channel, f.heldFlagged, f.resolved, f.channelFlagged].sort());
    const after = await allVerdicts();
    const moved = Object.keys(after).filter((id) => after[id] !== before287[id]).sort();
    expect(moved).toEqual([f.heldFlagged, f.heldCallback, f.resolved, f.heldCall, f.heldGuidance, f.channelFlagged, f.heldOld].sort());
    expect([after[f.heldCallback], after[f.heldCall], after[f.heldGuidance], after[f.resolved], after[f.channelFlagged], after[f.heldOld]])
      .toEqual(['callback', 'call', 'guidance', 'due', 'due', 'due']);
    // The rollout's dry-run query, before and with 287.
    const flaggedAfter = await flaggedByVerdict();
    const row = (held: boolean, status: string, verdict: string, routingState: boolean, n: number, untouched = 0) => (
      { held, status, verdict, routing_state: routingState, n, untouched_30d: untouched });
    expect(flaggedBefore).toContainEqual(row(true, 'open', 'routing', false, 6));
    expect(flaggedBefore).toContainEqual(row(true, 'open', 'needs_reply', false, 1));
    expect(flaggedAfter).toContainEqual(row(true, 'open', 'needs_reply', false, 1));
    expect(flaggedAfter).toContainEqual(row(true, 'open', 'due', false, 3, 1));
    expect(flaggedAfter).toContainEqual(row(true, 'resolved', 'due', false, 1));
    expect(flaggedAfter).toContainEqual(row(true, 'open', 'recent', false, 1));
    expect(flaggedAfter).toContainEqual(row(false, 'open', 'routing', false, 1));
    // The check after the merge: a held row reads routing only while chat_routing_state records a wait for it.
    expect(flaggedAfter).toContainEqual(row(true, 'open', 'routing', true, 2));
    expect(flaggedAfter.filter((r) => r.held && r.verdict === 'routing' && !r.routing_state)).toEqual([]);
  });

  it('unassigned, the flag still reads routing; the other routing conditions, the visitor waiting and the earlier guards hold as before', async () => {
    expect(await verdict(f.unassignedFlagged)).toBe('routing');
    expect(await verdict(f.unassignedQueued)).toBe('routing');
    for (const k of ['heldWaiting', 'heldDeadline', 'heldTimeout']) expect(await verdict(f[k]), k).toBe('routing');
    expect(await verdict(f.heldOwed)).toBe('needs_reply');
    expect(await verdict(f.heldHandoff)).toBe('ai_handoff');
    expect([await verdict(f.heldRecent), await verdict(f.call), await verdict(f.guidance), await verdict(f.channel)])
      .toEqual(['recent', 'call', 'guidance', 'due']);
    expect(await verdict(f.exempt)).toBe('exempt');
    expect(await verdict(f.spam)).toBe('spam');
    expect(await verdict(f.closed)).toBe('not_live');
    expect(await verdict(randomUUID())).toBe('not_found');
    // A routing wait forgotten by the ticker (somebody has it) lets it close.
    await q(`UPDATE public.chat_routing_state SET waiting_since = NULL WHERE conversation_id = $1`, [f.heldWaiting]);
    try {
      expect(await verdict(f.heldWaiting)).toBe('due');
    } finally {
      await q(`UPDATE public.chat_routing_state SET waiting_since = now() - interval '1 minute' WHERE conversation_id = $1`, [f.heldWaiting]);
    }
  });

  it('the close takes it now, and writes no routing key (the flag is the server\'s to clear)', async () => {
    const r = await one(
      `SELECT * FROM public.conversation_close_if_idle($1, (SELECT updated_at FROM public.conversations WHERE id = $1), 'timer', NULL, NULL)`,
      [f.heldFlagged],
    );
    expect(r).toMatchObject({ closed: true, outcome: 'closed', from_status: 'open', closed_outcome: 'human' });
    const row = await one(`SELECT status::text AS status, assigned_to, metadata FROM public.conversations WHERE id = $1`, [f.heldFlagged]);
    expect(row).toMatchObject({ status: 'closed', assigned_to: owner });
    expect(row.metadata).toMatchObject({ ...PRECHAT, closed_reason: 'inactivity', closed_by: 'system', closed_source: 'inactivity_timer' });
    expect(await verdict(f.heldFlagged)).toBe('not_live');
    expect(await dueIds()).not.toContain(f.heldFlagged);
  });

  it('a second run changes nothing, and only service_role may execute the function', async () => {
    const verdicts = await allVerdicts();
    const def = await definition();
    const due = await dueIds();
    await applyMigrationSql(db, readFileSync(MIGRATION, 'utf8'));
    expect(await allVerdicts()).toEqual(verdicts);
    expect(await definition()).toBe(def);
    expect(await dueIds()).toEqual(due);
    const p = await one(`SELECT has_function_privilege('service_role', $1, 'EXECUTE') AS service,
                                has_function_privilege('anon', $1, 'EXECUTE') AS anon,
                                has_function_privilege('authenticated', $1, 'EXECUTE') AS authenticated,
                                (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = $1::regprocedure) AS definer,
                                (SELECT coalesce(array_to_string(p.proacl, ','), '') FROM pg_proc p WHERE p.oid = $1::regprocedure) AS acl`,
    ['public.conversation_idle_check(uuid)']);
    expect(p).toMatchObject({ service: true, anon: false, authenticated: false, definer: false });
    expect(String(p.acl)).not.toMatch(/(^|,)=X/);
    expect((await one(`SELECT obj_description('public.conversation_idle_check(uuid)'::regprocedure, 'pg_proc') AS c`)).c)
      .toMatch(/Migrations 284, 285, 286, 287\.$/);
  });

  it('without 286 (a database at 285, or no function at all) the file stops before it changes anything', async () => {
    const sql285 = readFileSync(MIGRATION_285, 'utf8');
    const start = sql285.indexOf('CREATE OR REPLACE FUNCTION public.conversation_idle_check(p_conversation_id uuid)');
    const check285 = sql285.slice(start, sql285.indexOf('$fn_idle_check$;', start) + '$fn_idle_check$;'.length);
    for (const setup of [check285, 'DROP FUNCTION public.conversation_idle_check(uuid)']) {
      await q('BEGIN');
      try {
        await q(setup);
        await expect(applyMigrationSql(db, readFileSync(MIGRATION, 'utf8'))).rejects.toThrow(/287 needs 286/);
      } finally {
        await q('ROLLBACK');
      }
    }
    expect(await verdict(f.unassignedFlagged)).toBe('routing');
    expect(await verdict(f.exempt)).toBe('exempt');
  });
});
