// @vitest-environment node
/**
 * 265 — computed billing locks over a plan's limits, against real PostgreSQL
 * built by the whole migration chain (docs/billing/SIMPLE_BILLING.md, "Over
 * the limit after a downgrade: lock, never delete").
 *
 *   - the plan in force and the limit that locks: Free when the subscription
 *     lapsed, a workspace override first, the KB aliases, and only explicit
 *     whole numbers (absent, -1 and fractions lock nothing);
 *   - the cutoff ranks by (created_at, id), a NULL created_at first, ties
 *     broken by id; limit 0 locks everything;
 *   - nothing is locked while the edition's switch is off, for a workspace
 *     that is not active, or on an install whose billing is unlimited; the
 *     report still computes;
 *   - spam and anonymous widget contacts are not counted; the owner and
 *     suspended members never rank;
 *   - chats lock by last activity (the server's touch of updated_at), and
 *     no trigger touches a chat on a message insert;
 *   - a locked agent's open chats go back to the queue;
 *   - the deletion clock, and a deletion only of rows locked when the 30-day
 *     notice went out, after both notices and the deadline;
 *   - the AI KB builder cannot rewrite a locked article;
 *   - seat capacity: an expired workspace has Free's seats, suspended
 *     members hold none;
 *   - only service_role reaches any of it, and the file runs twice.
 *
 * Its own database (CREATE DATABASE on the TEST_DATABASE_URL server).
 * Skipped without TEST_DATABASE_URL; REQUIRE_BILLING_DB=1 makes that a failure.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { applyMigrationSql } from './pgMigrationChain';

const DSN = process.env.TEST_DATABASE_URL;
if (process.env.REQUIRE_BILLING_DB === '1' && !DSN) {
  throw new Error('REQUIRE_BILLING_DB=1 but TEST_DATABASE_URL is not set — the billing lock tests are mandatory.');
}
const suite = DSN ? describe : describe.skip;

const DB = `billinglocks265_${Date.now()}`;
const DIR = resolve(process.cwd(), 'database/migrations');
const FILE = '265_billing_computed_locks.sql';

type Row = Record<string, unknown>;

let admin: pg.Client;
let db: pg.Client;
const q = async (sql: string, params: unknown[] = []): Promise<Row[]> => (await db.query(sql, params)).rows as Row[];
const one = async (sql: string, params: unknown[] = []): Promise<Row> => (await q(sql, params))[0];

let freeId = '';

async function makePlan(slug: string, limits: Row, extra: Row = {}): Promise<string> {
  const row = await one(
    `INSERT INTO public.billing_plans (name, slug, prices, limits, is_active, is_free, locked_data_retention_days)
     VALUES ($1, $1, '{}', $2, true, false, $3) RETURNING id`,
    [slug, JSON.stringify(limits), extra.locked_data_retention_days ?? null],
  );
  return String(row.id);
}

async function makeWorkspace(): Promise<{ ws: string; owner: string }> {
  const ws = randomUUID();
  const owner = randomUUID();
  await q(`INSERT INTO public.profiles (id, email) VALUES ($1, $2)`, [owner, `o-${owner.slice(0, 8)}@test.local`]);
  await q(`INSERT INTO public.workspaces (id, name, slug, owner_id) VALUES ($1, 'Acme', $2, $3)`, [ws, `ws-${ws.slice(0, 8)}`, owner]);
  await q(`INSERT INTO public.workspace_members (workspace_id, user_id, role, created_at) VALUES ($1, $2, 'owner', now() - interval '1 year')`, [ws, owner]);
  return { ws, owner };
}

const subscribe = (ws: string, plan: string, status = 'active') =>
  q(`INSERT INTO public.workspace_subscriptions (workspace_id, plan_id, status, current_period_start, current_period_end)
     VALUES ($1, $2, $3, now() - interval '1 day', now() + interval '29 days')
     ON CONFLICT (workspace_id) DO UPDATE SET plan_id = EXCLUDED.plan_id, status = EXCLUDED.status`, [ws, plan, status]);

const setLocks = (on: boolean) =>
  q(`INSERT INTO public.billing_settings (edition, locks_enabled) VALUES (public.platform_edition(), $1)
     ON CONFLICT (edition) DO UPDATE SET locks_enabled = EXCLUDED.locks_enabled`, [on]);

/** Articles created `ages` days ago (null: no created_at), oldest first as given. */
async function articles(ws: string, ages: Array<number | null>): Promise<string[]> {
  const ids: string[] = [];
  for (const age of ages) {
    const r = await one(
      `INSERT INTO public.knowledge_base_articles (workspace_id, slug, title, status, created_at)
       VALUES ($1, $2, $3, 'published', CASE WHEN $4::int IS NULL THEN NULL ELSE now() - make_interval(days => $4::int) END)
       RETURNING id`,
      [ws, `a-${randomUUID().slice(0, 8)}`, `Article ${ids.length + 1}`, age],
    );
    ids.push(String(r.id));
  }
  return ids;
}

async function contact(ws: string, fields: Row = {}, age = 1): Promise<string> {
  const r = await one(
    `INSERT INTO public.contacts (workspace_id, name, email, phone, metadata, is_spam, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, now() - make_interval(days => $7::int)) RETURNING id`,
    [ws, 'name' in fields ? fields.name : `C ${randomUUID().slice(0, 6)}`, fields.email ?? null, fields.phone ?? null,
      JSON.stringify(fields.metadata ?? {}), fields.is_spam ?? false, age],
  );
  return String(r.id);
}

async function member(ws: string, age: number, extra: Row = {}): Promise<string> {
  const user = randomUUID();
  await q(`INSERT INTO public.profiles (id, email, full_name) VALUES ($1, $2, $3)`, [user, `m-${user.slice(0, 8)}@test.local`, `Agent ${user.slice(0, 4)}`]);
  await q(
    `INSERT INTO public.workspace_members (workspace_id, user_id, role, created_at, suspended_at)
     VALUES ($1, $2, 'agent', now() - make_interval(days => $3::int), $4)`,
    [ws, user, age, extra.suspended ? new Date().toISOString() : null],
  );
  return user;
}

async function conversation(ws: string, activityDaysAgo: number, extra: Row = {}): Promise<string> {
  const r = await one(
    `INSERT INTO public.conversations (workspace_id, status, assigned_to, created_at, updated_at)
     VALUES ($1, $2, $3, now() - make_interval(days => $4::int), now() - make_interval(days => $4::int)) RETURNING id`,
    [ws, extra.status ?? 'open', extra.assigned_to ?? null, activityDaysAgo],
  );
  return String(r.id);
}

const cutoff = (ws: string, kind: string, plan: string | null = null) =>
  one(`SELECT lim::int, total::int, locked::int, cut_ts, cut_id FROM public.billing_lock_cutoff($1, $2, $3)`, [ws, kind, plan]);
const lockedIds = async (ws: string, kind: string): Promise<string[]> =>
  (await q(`SELECT x::text AS id FROM public.billing_locked_ids($1, $2) x`, [ws, kind])).map((r) => String(r.id));
const isLocked = async (ws: string, kind: string, id: string): Promise<boolean> =>
  (await one(`SELECT public.billing_is_locked($1, $2, $3) AS r`, [ws, kind, id])).r as boolean;
const limit = async (ws: string, key: string, plan: string | null = null): Promise<number | null> => {
  const v = (await one(`SELECT public.billing_effective_limit($1, $2, $3) AS r`, [ws, key, plan])).r;
  return v === null ? null : Number(v);
};
const report = async (ws: string, plan: string | null = null): Promise<Row> =>
  (await one(`SELECT public.billing_lock_report($1, $2) AS r`, [ws, plan])).r as Row;

suite('265 — computed billing locks (real PostgreSQL, whole chain)', () => {
  beforeAll(async () => {
    const adminUrl = new URL(DSN!);
    adminUrl.pathname = '/postgres';
    admin = new pg.Client({ connectionString: adminUrl.toString() });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
    await admin.query(`CREATE DATABASE ${DB}`);
    const url = new URL(DSN!);
    url.pathname = `/${DB}`;
    db = new pg.Client({ connectionString: url.toString() });
    await db.connect();
    await db.query('SET client_min_messages = warning');

    const files = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files.filter((f) => f <= FILE)) {
      await applyMigrationSql(db, readFileSync(resolve(DIR, file), 'utf8'));
    }
    await db.query(`UPDATE public.platform_settings SET region_mode = 'multi'`);
    freeId = String((await one(`SELECT id FROM public.billing_plans WHERE slug = 'free'`)).id);
  }, 600_000);

  afterAll(async () => {
    await db?.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
      await admin.end();
    }
  });

  it('runs twice, and defines without destroying', async () => {
    await applyMigrationSql(db, readFileSync(resolve(DIR, FILE), 'utf8'));
    expect(await one(`SELECT column_default, is_nullable FROM information_schema.columns
                       WHERE table_name = 'billing_settings' AND column_name = 'locks_enabled'`))
      .toEqual({ column_default: 'false', is_nullable: 'NO' });
    // The switch is off on a fresh install: no edition row says otherwise.
    expect((await one(`SELECT public.billing_locks_enabled() AS r`)).r).toBe(false);
    const templates = await q(
      `SELECT edition, locale FROM public.email_templates
        WHERE workspace_id IS NULL AND slug = 'billing_locked_data_deletion' ORDER BY 1, 2`);
    expect(templates).toEqual([
      { edition: 'international', locale: 'en' }, { edition: 'international', locale: 'fa' }, { edition: 'international', locale: 'tr' },
      { edition: 'iran', locale: 'en' }, { edition: 'iran', locale: 'fa' }, { edition: 'iran', locale: 'tr' },
    ]);
    const fa = await one(`SELECT subject, html_body, text_body FROM public.email_templates
                           WHERE workspace_id IS NULL AND slug = 'billing_locked_data_deletion' AND locale = 'fa' AND edition = 'iran'`);
    for (const v of ['{workspace}', '{plan_name}', '{deletion_date}', '{days_left}', '{locked_summary}', '{export_url}', '{billing_url}']) {
      expect(String(fa.html_body)).toContain(v);
    }
    // Persian text uses ی and ک only.
    expect(`${fa.subject}${fa.html_body}${fa.text_body}`).not.toMatch(/[يك]/);
  });

  it('the plan in force: assigned while it applies, else Free', async () => {
    const pro = await makePlan('l-pro', { max_contacts: 10 });
    const { ws } = await makeWorkspace();
    const plan = async () => (await one(`SELECT public.billing_effective_plan_id($1)::text AS r`, [ws])).r;
    expect(await plan()).toBe(freeId); // no subscription
    await subscribe(ws, pro);
    expect(await plan()).toBe(pro);
    await q(`UPDATE public.workspace_subscriptions SET status = 'expired' WHERE workspace_id = $1`, [ws]);
    expect(await plan()).toBe(freeId);
    await q(`UPDATE public.workspace_subscriptions SET status = 'trialing', trial_end = now() + interval '2 days' WHERE workspace_id = $1`, [ws]);
    expect(await plan()).toBe(pro);
    await q(`UPDATE public.workspace_subscriptions SET trial_end = now() - interval '1 minute' WHERE workspace_id = $1`, [ws]);
    expect(await plan()).toBe(freeId);
    await q(`UPDATE public.workspace_subscriptions SET status = 'past_due', free_fallback_at = NULL WHERE workspace_id = $1`, [ws]);
    expect(await plan()).toBe(pro);
    await q(`UPDATE public.workspace_subscriptions SET free_fallback_at = now() WHERE workspace_id = $1`, [ws]);
    expect(await plan()).toBe(freeId);
    await q(`UPDATE public.workspace_subscriptions SET status = 'canceled', cancel_at_period_end = true,
               current_period_end = now() + interval '3 days' WHERE workspace_id = $1`, [ws]);
    expect(await plan()).toBe(pro);
  });

  it('the limit that locks: override first, KB aliases, only explicit whole numbers', async () => {
    const plan = await makePlan('l-limits', {
      max_contacts: 25, max_agents: -1, kb_articles: 7, storage_gb: 2.5, data_retention_days: 'abc', max_conversations: '40',
    });
    const { ws } = await makeWorkspace();
    await subscribe(ws, plan);
    expect(await limit(ws, 'max_contacts')).toBe(25);
    expect(await limit(ws, 'max_agents')).toBeNull(); // -1 = unlimited
    expect(await limit(ws, 'max_kb_articles')).toBe(7); // legacy alias
    expect(await limit(ws, 'storage_gb')).toBeNull(); // not a whole number
    expect(await limit(ws, 'data_retention_days')).toBeNull(); // not a number
    expect(await limit(ws, 'max_conversations')).toBe(40); // numeric string
    expect(await limit(ws, 'max_visitors')).toBeNull(); // absent: no registry default
    // An explicit plan argument reads that plan (the downgrade report).
    expect(await limit(ws, 'max_contacts', freeId)).toBe(100);
    await q(`INSERT INTO public.workspace_limit_overrides (workspace_id, limit_key, limit_value) VALUES ($1, 'max_contacts', 3)`, [ws]);
    expect(await limit(ws, 'max_contacts')).toBe(3);
    expect(await limit(ws, 'max_contacts', freeId)).toBe(3); // an override follows the workspace
    await q(`INSERT INTO public.workspace_limit_overrides (workspace_id, limit_key, limit_value) VALUES ($1, 'max_kb_articles', -1)`, [ws]);
    expect(await limit(ws, 'max_kb_articles')).toBeNull();
    // The Trial plan names only max_contacts: nothing else of it locks.
    const trial = String((await one(`SELECT id FROM public.billing_plans WHERE slug = 'trial'`)).id);
    expect(await limit(ws, 'max_agents', trial)).toBeNull();
    expect(await limit(ws, 'data_retention_days', freeId)).toBeNull();
  });

  it('with the switch off nothing is locked; the report still computes', async () => {
    const plan = await makePlan('l-off', { max_kb_articles: 1 });
    const { ws } = await makeWorkspace();
    await subscribe(ws, plan);
    const ids = await articles(ws, [3, 2, 1]);
    expect(await cutoff(ws, 'kb_article')).toEqual({ lim: 1, total: null, locked: 0, cut_ts: null, cut_id: null });
    expect(await lockedIds(ws, 'kb_article')).toEqual([]);
    expect(await isLocked(ws, 'kb_article', ids[2])).toBe(false);
    const r = await report(ws);
    expect(r.locks_enabled).toBe(false);
    expect(r.has_locks).toBe(true);
    expect(r.kb_article).toMatchObject({ limit: 1, total: 3, locked: 2 });

    await setLocks(true);
    expect(await cutoff(ws, 'kb_article')).toMatchObject({ lim: 1, total: 3, locked: 2, cut_id: ids[0] });
    expect(await lockedIds(ws, 'kb_article')).toEqual([ids[1], ids[2]]);
    expect((await report(ws)).locks_enabled).toBe(true);
  });

  it('the cutoff ranks by (created_at, id): NULL first, ties by id, newest locked', async () => {
    const plan = await makePlan('l-rank', { max_kb_articles: 3 });
    const { ws } = await makeWorkspace();
    await subscribe(ws, plan);
    const [nullOne, old] = await articles(ws, [null, 10]);
    // Three articles with the same created_at: the lower ids rank first.
    const same = new Date(Date.now() - 5 * 86_400_000).toISOString();
    const tied = [randomUUID(), randomUUID(), randomUUID()].sort();
    for (const id of [...tied].reverse()) {
      await q(`INSERT INTO public.knowledge_base_articles (id, workspace_id, slug, title, created_at) VALUES ($1, $2, $3, 't', $4)`,
        [id, ws, `t-${id.slice(0, 8)}`, same]);
    }
    const c = await cutoff(ws, 'kb_article');
    expect(c).toMatchObject({ lim: 3, total: 5, locked: 2, cut_id: tied[0] });
    expect(new Date(c.cut_ts as string).toISOString()).toBe(same);
    expect(await lockedIds(ws, 'kb_article')).toEqual([tied[1], tied[2]]);
    for (const id of [nullOne, old, tied[0]]) expect(await isLocked(ws, 'kb_article', id)).toBe(false);
    for (const id of [tied[1], tied[2]]) expect(await isLocked(ws, 'kb_article', id)).toBe(true);

    // Limit 0 locks every article, the NULL one too.
    await q(`INSERT INTO public.workspace_limit_overrides (workspace_id, limit_key, limit_value) VALUES ($1, 'max_kb_articles', 0)`, [ws]);
    expect(await cutoff(ws, 'kb_article')).toMatchObject({ lim: 0, total: 5, locked: 5, cut_id: '00000000-0000-0000-0000-000000000000' });
    expect((await lockedIds(ws, 'kb_article'))[0]).toBe(nullOne);
    expect(await isLocked(ws, 'kb_article', nullOne)).toBe(true);
    // An upgrade (here: the override raised) unlocks everything at once.
    await q(`UPDATE public.workspace_limit_overrides SET limit_value = 10 WHERE workspace_id = $1`, [ws]);
    expect(await cutoff(ws, 'kb_article')).toMatchObject({ locked: 0, cut_ts: null });
    // Deleting older articles frees their slots for the newest.
    await q(`DELETE FROM public.workspace_limit_overrides WHERE workspace_id = $1`, [ws]);
    await q(`DELETE FROM public.knowledge_base_articles WHERE id = ANY($1)`, [[nullOne, old]]);
    expect(await cutoff(ws, 'kb_article')).toMatchObject({ total: 3, locked: 0 });
  });

  it('a workspace that is not active, and an unlimited install, never lock', async () => {
    const plan = await makePlan('l-inactive', { max_kb_articles: 0 });
    const { ws } = await makeWorkspace();
    await subscribe(ws, plan);
    const [id] = await articles(ws, [1]);
    expect(await isLocked(ws, 'kb_article', id)).toBe(true);
    await q(`UPDATE public.workspaces SET status = 'deleting' WHERE id = $1`, [ws]);
    expect(await isLocked(ws, 'kb_article', id)).toBe(false);
    await q(`UPDATE public.workspaces SET status = 'active' WHERE id = $1`, [ws]);
    await q(`UPDATE public.workspace_seat_entitlement_mode SET mode = 'self_host_unlimited' WHERE id`);
    try {
      expect(await isLocked(ws, 'kb_article', id)).toBe(false);
      expect((await report(ws)).has_locks).toBe(false);
    } finally {
      await q(`UPDATE public.workspace_seat_entitlement_mode SET mode = 'plan_authoritative' WHERE id`);
    }
  });

  it('contacts: spam and anonymous widget visitors are not counted (D1)', async () => {
    const plan = await makePlan('l-contacts', { max_contacts: 2 });
    const { ws } = await makeWorkspace();
    await subscribe(ws, plan);
    const a = await contact(ws, {}, 10);
    const spam = await contact(ws, { is_spam: true }, 9);
    const anon = await contact(ws, { name: null, metadata: { anonymous: true } }, 8);
    const legacyAnon = await contact(ws, { name: 'Visitor', metadata: { anonymous: true } }, 7);
    const b = await contact(ws, {}, 6);
    const identified = await contact(ws, { name: null, email: 'x@example.test', metadata: { anonymous: true } }, 5);
    const c = await contact(ws, {}, 4);
    expect(Number((await one(`SELECT public.billing_countable_count($1, 'contact') AS n`, [ws])).n)).toBe(4);
    expect(await cutoff(ws, 'contact')).toMatchObject({ lim: 2, total: 4, locked: 2, cut_id: b });
    expect(await lockedIds(ws, 'contact')).toEqual([identified, c]);
    for (const id of [a, spam, anon, legacyAnon, b]) expect(await isLocked(ws, 'contact', id)).toBe(false);
  });

  it('members: the owner holds a seat and never locks; suspended members hold none (D3)', async () => {
    const plan = await makePlan('l-members', { max_agents: 3 });
    const { ws, owner } = await makeWorkspace();
    await subscribe(ws, plan);
    // A plan that does not name max_agents locks no member (not "0 seats").
    const unlimited = await makePlan('l-members-unlimited', { max_contacts: 5 });
    expect(await cutoff(ws, 'member', unlimited)).toMatchObject({ lim: null, locked: 0 });
    const m1 = await member(ws, 30);
    await member(ws, 20, { suspended: true });
    const m2 = await member(ws, 10);
    const m3 = await member(ws, 5);
    expect(await cutoff(ws, 'member')).toMatchObject({ lim: 2, total: 3, locked: 1, cut_id: m2 });
    expect(await lockedIds(ws, 'member')).toEqual([m3]);
    expect(await isLocked(ws, 'member', owner)).toBe(false);
    expect(await isLocked(ws, 'member', m1)).toBe(false);

    // max_agents 1: only the owner keeps a seat.
    await q(`INSERT INTO public.workspace_limit_overrides (workspace_id, limit_key, limit_value) VALUES ($1, 'max_agents', 1)`, [ws]);
    expect(await lockedIds(ws, 'member')).toEqual([m1, m2, m3]);
    expect(await isLocked(ws, 'member', owner)).toBe(false);

    // Their open chats go back to the queue; closed ones and others' stay.
    const open = await conversation(ws, 1, { assigned_to: m2 });
    const pending = await conversation(ws, 1, { assigned_to: m3, status: 'pending' });
    const closed = await conversation(ws, 1, { assigned_to: m2, status: 'closed' });
    const owners = await conversation(ws, 1, { assigned_to: owner });
    const released = (await q(`SELECT x::text AS id FROM public.billing_release_locked_agent_chats($1) x`, [ws])).map((r) => r.id).sort();
    expect(released).toEqual([open, pending].sort());
    const assigned = await q(`SELECT id::text, assigned_to::text FROM public.conversations WHERE id = ANY($1) ORDER BY id`, [[open, pending, closed, owners]]);
    expect(Object.fromEntries(assigned.map((r) => [r.id, r.assigned_to]))).toEqual({
      [open]: null, [pending]: null, [closed]: m2, [owners]: owner,
    });

    const r = await report(ws);
    expect(r.member).toMatchObject({ limit: 1, total: 4, locked: 3 });
    expect(((r.member as Row).items as Row[]).map((i) => i.user_id)).toEqual([m1, m2, m3]);
    expect(((r.member as Row).items as Row[])[0]).toMatchObject({ name: expect.stringMatching(/^Agent /), email: expect.stringMatching(/@test\.local$/) });
  });

  it('conversations.updated_at is in no index: every touch of it (widget heartbeat, messages) can stay a HOT update', async () => {
    expect(await q(`SELECT i.indexrelid::regclass::text AS idx FROM pg_index i
                      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
                     WHERE i.indrelid = 'public.conversations'::regclass AND a.attname = 'updated_at'`)).toEqual([]);
  });

  it('chats lock by last activity; a customer message reopens one (D2)', async () => {
    const plan = await makePlan('l-chats', { data_retention_days: 30 });
    const { ws } = await makeWorkspace();
    await subscribe(ws, plan);
    const old = await conversation(ws, 45);
    const recent = await conversation(ws, 10);
    // created long ago, active recently: kept.
    const longRunning = String((await one(
      `INSERT INTO public.conversations (workspace_id, created_at, updated_at)
       VALUES ($1, now() - interval '200 days', now() - interval '1 day') RETURNING id`, [ws])).id);
    // no updated_at: its creation counts.
    const noUpdate = String((await one(
      `INSERT INTO public.conversations (workspace_id, created_at, updated_at)
       VALUES ($1, now() - interval '40 days', NULL) RETURNING id`, [ws])).id);
    const c = await cutoff(ws, 'conversation');
    expect(c).toMatchObject({ lim: 30, total: 4, locked: 2, cut_id: null });
    expect(Math.abs(new Date(c.cut_ts as string).getTime() - (Date.now() - 30 * 86_400_000))).toBeLessThan(60_000);
    expect(await lockedIds(ws, 'conversation')).toEqual([old, noUpdate]);
    for (const id of [recent, longRunning]) expect(await isLocked(ws, 'conversation', id)).toBe(false);

    // A message row alone moves nothing: no trigger writes the chat a second
    // time (the widget, channel and support writers touch updated_at
    // themselves, once; a channel menu tap deliberately does not).
    const before = (await one(`SELECT updated_at FROM public.conversations WHERE id = $1`, [old])).updated_at;
    await q(`INSERT INTO public.conversation_messages (conversation_id, sender_type, body) VALUES ($1, 'agent', 'hi')`, [old]);
    await q(`INSERT INTO public.conversation_messages (conversation_id, sender_type, body) VALUES ($1, 'contact', 'menu tap')`, [old]);
    expect((await one(`SELECT updated_at FROM public.conversations WHERE id = $1`, [old])).updated_at).toEqual(before);
    expect(await q(`SELECT tgname FROM pg_trigger WHERE tgrelid = 'public.conversation_messages'::regclass
                     AND tgname = 'trg_conversation_messages_touch_conversation'`)).toEqual([]);
    expect(await isLocked(ws, 'conversation', old)).toBe(true);
    // The customer coming back: the server's touch of updated_at reopens it.
    await q(`UPDATE public.conversations SET updated_at = now() WHERE id = $1`, [old]);
    expect(await isLocked(ws, 'conversation', old)).toBe(false);

    const r = await report(ws);
    expect(r.conversation).toMatchObject({ retention_days: 30, total: 4, locked: 1 });
    expect((r.conversation as Row).oldest_kept).not.toBeNull();
  });

  it('the downgrade report names what a plan would lock', async () => {
    const target = await makePlan('l-target', {
      max_kb_articles: 1, max_contacts: 1, max_agents: 2, data_retention_days: 30, max_conversations: 5, storage_gb: 1,
    }, { locked_data_retention_days: 60 });
    const current = await makePlan('l-current', { max_kb_articles: 100 });
    const { ws } = await makeWorkspace();
    await subscribe(ws, current);
    const kb = await articles(ws, [3, 2, 1]);
    await contact(ws, {}, 3);
    await contact(ws, {}, 2);
    await member(ws, 5);
    await conversation(ws, 90);
    await conversation(ws, 1);
    const period = new Date().toISOString().slice(0, 7);
    await q(`INSERT INTO public.workspace_usage_counters (workspace_id, period, conversations_count, storage_bytes)
             VALUES ($1, $2, 7, $3)
             ON CONFLICT (workspace_id, period) DO UPDATE SET conversations_count = 7, storage_bytes = EXCLUDED.storage_bytes`,
      [ws, period, 3 * 1024 ** 3]);

    expect((await report(ws)).has_locks).toBe(false); // the plan in force locks nothing
    const r = await report(ws, target);
    expect(r).toMatchObject({
      plan_id: target,
      locks_enabled: true,
      has_locks: true,
      kb_article: { limit: 1, total: 3, locked: 2 },
      contact: { limit: 1, total: 2, locked: 1 },
      member: { limit: 2, total: 2, locked: 0, items: [] },
      conversation: { retention_days: 30, total: 2, locked: 1 },
      conversation_quota: { limit: 5, used_this_month: 7, full: true },
      storage: { limit_gb: 1, used_gb: 3, uploads_blocked: true },
      locked_data_retention_days: 60,
    });
    expect((r.kb_article as Row).items).toEqual([{ id: kb[1], title: 'Article 2' }, { id: kb[2], title: 'Article 3' }]);
    const notBefore = new Date(r.first_deletion_not_before as string).getTime();
    expect(Math.abs(notBefore - (Date.now() + 60 * 86_400_000))).toBeLessThan(60_000);
    // A report writes nothing.
    expect(Number((await one(`SELECT count(*) AS n FROM public.billing_lock_clocks WHERE workspace_id = $1`, [ws])).n)).toBe(0);
  });

  it('the deletion clock: opens when something locks, resets when nothing does', async () => {
    const plan = await makePlan('l-clock', { max_contacts: 1 }, { locked_data_retention_days: 90 });
    const { ws } = await makeWorkspace();
    await subscribe(ws, plan);
    await contact(ws, {}, 5);
    const observe = async () =>
      (await q(`SELECT kind, episode_key, locked_count FROM public.billing_lock_clock_observe($1)`, [ws]));
    expect(await observe()).toEqual([]);
    await contact(ws, {}, 4);
    const first = await observe();
    expect(first).toMatchObject([{ kind: 'contact', locked_count: 1 }]);
    await contact(ws, {}, 3);
    // The same episode, with the new count.
    expect(await observe()).toEqual([{ ...first[0], locked_count: 2 }]);
    // An upgrade (the override raised) removes the clock.
    await q(`INSERT INTO public.workspace_limit_overrides (workspace_id, limit_key, limit_value) VALUES ($1, 'max_contacts', 10)`, [ws]);
    expect(await observe()).toEqual([]);
    expect(Number((await one(`SELECT count(*) AS n FROM public.billing_lock_clocks WHERE workspace_id = $1`, [ws])).n)).toBe(0);
    // Turning the switch off also stops every clock.
    await q(`DELETE FROM public.workspace_limit_overrides WHERE workspace_id = $1`, [ws]);
    expect(await observe()).toHaveLength(1);
    await setLocks(false);
    try {
      expect(await observe()).toEqual([]);
    } finally {
      await setLocks(true);
    }
  });

  it('chat batches: an episode per monthly batch date, its cutoff fixed by its notice', async () => {
    const plan = await makePlan('l-batch', { data_retention_days: 30 }, { locked_data_retention_days: 30 });
    const { ws } = await makeWorkspace();
    await subscribe(ws, plan);
    const batch = await one(`SELECT public.billing_lock_next_batch() AS d,
                                    now() >= public.billing_lock_next_batch() - interval '30 days' AS due,
                                    to_char(public.billing_lock_next_batch() AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS k`);
    const d = new Date(batch.d as string);
    expect(d.getUTCDate()).toBe(1);
    expect(d.getUTCHours()).toBe(0);
    // Activity before D - 60 days goes in batch D; after it, not yet.
    const daysToD = (d.getTime() - Date.now()) / 86_400_000;
    const inBatch = await conversation(ws, Math.ceil(60 - daysToD) + 2);
    await conversation(ws, Math.floor(60 - daysToD) - 2);
    const rows = await q(`SELECT kind, episode_key, locked_count, cutoff_at FROM public.billing_lock_clock_observe($1)`, [ws]);
    if (batch.due) {
      expect(rows).toMatchObject([{ kind: 'conversation', episode_key: batch.k, locked_count: 1 }]);
      expect(new Date(rows[0].cutoff_at as string).getTime()).toBe(d.getTime() - 60 * 86_400_000);
    } else {
      expect(rows).toEqual([]);
    }
    // Without locked_data_retention_days nothing is ever deleted: no batch.
    await q(`UPDATE public.billing_plans SET locked_data_retention_days = NULL WHERE id = $1`, [plan]);
    expect(await q(`SELECT * FROM public.billing_lock_clock_observe($1)`, [ws])).toEqual([]);
    expect(inBatch).toBeTruthy();
  });

  it('deletion: only after both notices and the deadline, only rows locked at the 30-day notice', async () => {
    const plan = await makePlan('l-delete', { max_kb_articles: 1 }, { locked_data_retention_days: 30 });
    const { ws } = await makeWorkspace();
    await subscribe(ws, plan);
    const [keep, lockedOld, lockedNew] = await articles(ws, [100, 90, 80]);
    const [episode] = await q(`SELECT episode_key FROM public.billing_lock_clock_observe($1) WHERE kind = 'kb_article'`, [ws]);
    const key = String(episode.episode_key);
    const del = async (ids: string[]) =>
      Number((await one(`SELECT public.billing_locked_delete($1, 'kb_article', $2, $3) AS n`, [ws, key, ids])).n);
    const clock = () => one(`SELECT * FROM public.billing_lock_clocks WHERE workspace_id = $1 AND kind = 'kb_article' AND episode_key = $2`, [ws, key]);
    const exists = async (id: string) => Number((await one(`SELECT count(*) AS n FROM public.knowledge_base_articles WHERE id = $1`, [id])).n) === 1;

    // Long past its deadline, but no notice yet: nothing.
    await q(`UPDATE public.billing_lock_clocks SET since = now() - interval '100 days' WHERE workspace_id = $1`, [ws]);
    expect(await del([lockedOld, lockedNew])).toBe(0);
    // The 30-day notice claimed (it fixes the cutoff it announces), but its
    // mail never confirmed: it does not count.
    expect(await q(`SELECT locked_count FROM public.billing_lock_notice_claim($1, 'kb_article', $2, '30')`, [ws, key])).toEqual([{ locked_count: 2 }]);
    await q(`UPDATE public.billing_lock_clocks SET notice_7_at = now() - interval '8 days' WHERE workspace_id = $1`, [ws]);
    expect(await del([lockedOld, lockedNew])).toBe(0);
    await q(`UPDATE public.billing_lock_clocks SET notice_7_at = NULL WHERE workspace_id = $1`, [ws]);
    // Only the 30-day notice: nothing.
    await q(`UPDATE public.billing_lock_clocks SET notice_30_at = now() - interval '40 days', notice_30_claimed_at = NULL WHERE workspace_id = $1`, [ws]);
    expect(await del([lockedOld, lockedNew])).toBe(0);
    // The 7-day notice went out late (3 days ago): the deadline moves to 7
    // days after it.
    await q(`UPDATE public.billing_lock_clocks SET notice_7_at = now() - interval '3 days' WHERE workspace_id = $1`, [ws]);
    expect(new Date((await one(`SELECT public.billing_lock_episode_deadline(k) AS d FROM public.billing_lock_clocks k
                                  WHERE workspace_id = $1`, [ws])).d as string).getTime())
      .toBeGreaterThan(Date.now() + 3 * 86_400_000);
    expect(await del([lockedOld, lockedNew])).toBe(0);
    await q(`UPDATE public.billing_lock_clocks SET notice_7_at = now() - interval '8 days' WHERE workspace_id = $1`, [ws]);

    // An unlocked article is never deleted, whatever the caller passes.
    expect(await del([keep])).toBe(0);
    expect(await exists(keep)).toBe(true);
    // An article created after the 30-day notice was not named in it: kept.
    const [late] = await articles(ws, [1]);
    expect(await isLocked(ws, 'kb_article', late)).toBe(true);
    expect(await del([lockedOld, lockedNew, late, keep])).toBe(2);
    expect(await exists(lockedOld)).toBe(false);
    expect(await exists(lockedNew)).toBe(false);
    expect(await exists(late)).toBe(true);
    expect(await exists(keep)).toBe(true);
    expect((await clock()).deleted_at).not.toBeNull();
    // Done is done: a second call deletes nothing.
    expect(await del([late])).toBe(0);
    // What is still locked starts a new episode, with new notices.
    const next = await q(`SELECT episode_key, notice_30_at FROM public.billing_lock_clock_observe($1) WHERE kind = 'kb_article'`, [ws]);
    expect(next).toHaveLength(1);
    expect(next[0].episode_key).not.toBe(key);
    expect(next[0].notice_30_at).toBeNull();
  });

  it('deletion: a contact goes, its chats stay; members are never deleted; the switch off stops it', async () => {
    const plan = await makePlan('l-delete-contact', { max_contacts: 1 }, { locked_data_retention_days: 30 });
    const { ws } = await makeWorkspace();
    await subscribe(ws, plan);
    await contact(ws, {}, 50);
    const gone = await contact(ws, {}, 40);
    const chat = String((await one(`INSERT INTO public.conversations (workspace_id, contact_id) VALUES ($1, $2) RETURNING id`, [ws, gone])).id);
    const [episode] = await q(`SELECT episode_key FROM public.billing_lock_clock_observe($1)`, [ws]);
    await q(`SELECT * FROM public.billing_lock_notice_claim($1, 'contact', $2, '30')`, [ws, episode.episode_key]);
    await q(`UPDATE public.billing_lock_clocks SET since = now() - interval '60 days', notice_30_at = now() - interval '31 days',
               notice_7_at = now() - interval '8 days' WHERE workspace_id = $1`, [ws]);
    await expect(q(`SELECT public.billing_locked_delete($1, 'member', $2, $3)`, [ws, episode.episode_key, [gone]]))
      .rejects.toThrow(/billing_lock_kind_invalid/);

    await setLocks(false);
    try {
      expect(Number((await one(`SELECT public.billing_locked_delete($1, 'contact', $2, $3) AS n`, [ws, episode.episode_key, [gone]])).n)).toBe(0);
    } finally {
      await setLocks(true);
    }
    expect(Number((await one(`SELECT public.billing_locked_delete($1, 'contact', $2, $3) AS n`, [ws, episode.episode_key, [gone]])).n)).toBe(1);
    expect(await one(`SELECT contact_id FROM public.conversations WHERE id = $1`, [chat])).toEqual({ contact_id: null });
  });

  it('deletion: a limit lowered after the 30-day notice deletes only what the notice announced', async () => {
    const plan = await makePlan('l-delete-lowered', { max_kb_articles: 3 }, { locked_data_retention_days: 30 });
    const { ws } = await makeWorkspace();
    await subscribe(ws, plan);
    // Five articles, three kept: the two newest are locked and announced.
    const [a1, a2, a3, a4, a5] = await articles(ws, [100, 90, 80, 70, 60]);
    const [episode] = await q(`SELECT episode_key FROM public.billing_lock_clock_observe($1) WHERE kind = 'kb_article'`, [ws]);
    const key = String(episode.episode_key);
    expect(await q(`SELECT locked_count FROM public.billing_lock_notice_claim($1, 'kb_article', $2, '30')`, [ws, key])).toEqual([{ locked_count: 2 }]);
    await q(`UPDATE public.billing_lock_clocks SET since = now() - interval '60 days', notice_30_at = now() - interval '31 days',
               notice_30_claimed_at = NULL, notice_7_at = now() - interval '8 days' WHERE workspace_id = $1`, [ws]);
    // The day before the deadline the Super Admin lowers the limit to 1:
    // a2 and a3 lock too, but no notice named them.
    await q(`INSERT INTO public.workspace_limit_overrides (workspace_id, limit_key, limit_value) VALUES ($1, 'max_kb_articles', 1)`, [ws]);
    expect(await lockedIds(ws, 'kb_article')).toEqual([a2, a3, a4, a5]);
    const n = Number((await one(`SELECT public.billing_locked_delete($1, 'kb_article', $2, $3) AS n`, [ws, key, [a1, a2, a3, a4, a5]])).n);
    expect(n).toBe(2);
    const left = (await q(`SELECT id::text FROM public.knowledge_base_articles WHERE workspace_id = $1 ORDER BY created_at`, [ws])).map((r) => r.id);
    expect(left).toEqual([a1, a2, a3]);
    expect(await q(`SELECT t FROM public.billing_locked_delete_targets($1, 'kb_article', $2, NULL, 100) t`, [ws, key])).toEqual([]);
    // The announced episode is done; what locked later gets its own, with its own notices.
    expect((await one(`SELECT deleted_at FROM public.billing_lock_clocks WHERE workspace_id = $1 AND episode_key = $2`, [ws, key])).deleted_at).not.toBeNull();
    const next = await q(`SELECT episode_key, locked_count, notice_30_at FROM public.billing_lock_clock_observe($1) WHERE kind = 'kb_article'`, [ws]);
    expect(next).toMatchObject([{ locked_count: 2, notice_30_at: null }]);
    expect(next[0].episode_key).not.toBe(key);
  });

  it('notice claims: one sender at a time, a stale claim may be taken again, the 7-day one only after the 30-day one', async () => {
    const plan = await makePlan('l-claim', { max_contacts: 1 }, { locked_data_retention_days: 30 });
    const { ws } = await makeWorkspace();
    await subscribe(ws, plan);
    await contact(ws, {}, 50);
    await contact(ws, {}, 40);
    const [episode] = await q(`SELECT episode_key FROM public.billing_lock_clock_observe($1)`, [ws]);
    const claim = (which: string) => q(`SELECT locked_count FROM public.billing_lock_notice_claim($1, 'contact', $2, $3)`, [ws, episode.episode_key, which]);
    expect(await claim('7')).toEqual([]);
    expect(await claim('30')).toEqual([{ locked_count: 1 }]);
    expect(await claim('30')).toEqual([]);
    await q(`UPDATE public.billing_lock_clocks SET notice_30_claimed_at = now() - interval '31 minutes' WHERE workspace_id = $1`, [ws]);
    expect(await claim('30')).toEqual([{ locked_count: 1 }]);
    // Claimed is not sent: the deletion clock does not count it.
    expect((await one(`SELECT public.billing_lock_episode_deadline(k) AS d FROM public.billing_lock_clocks k WHERE workspace_id = $1`, [ws])).d).toBeNull();
    await q(`UPDATE public.billing_lock_clocks SET notice_30_at = now(), notice_30_claimed_at = NULL WHERE workspace_id = $1`, [ws]);
    expect(await claim('30')).toEqual([]);
    expect(await claim('7')).toEqual([{ locked_count: 1 }]);
    expect(await claim('7')).toEqual([]);
  });

  it('deletion: chats of a batch, past the batch date, before the noticed cutoff', async () => {
    const plan = await makePlan('l-delete-chats', { data_retention_days: 30 }, { locked_data_retention_days: 30 });
    const { ws } = await makeWorkspace();
    await subscribe(ws, plan);
    const ancient = await conversation(ws, 200);
    const old = await conversation(ws, 70);
    const recent = await conversation(ws, 5);
    // Batch date D = the 1st of this month (past), noticed 40 and 10 days ago,
    // cutoff fixed at D - 60 days.
    const d = new Date();
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
    await q(`INSERT INTO public.billing_lock_clocks (workspace_id, kind, episode_key, since, cutoff_at, locked_count, notice_30_at, notice_7_at)
             VALUES ($1, 'conversation', $2, now() - interval '40 days', ($2 || 'T00:00:00Z')::timestamptz - interval '60 days', 2,
                     now() - interval '40 days', now() - interval '10 days')`, [ws, key]);
    const n = Number((await one(`SELECT public.billing_locked_delete($1, 'conversation', $2, $3) AS n`, [ws, key, [ancient, old, recent]])).n);
    const left = (await q(`SELECT id::text FROM public.conversations WHERE workspace_id = $1`, [ws])).map((r) => r.id);
    const cutoffMs = Date.parse(`${key}T00:00:00Z`) - 60 * 86_400_000;
    const oldActivity = Date.now() - 70 * 86_400_000;
    // ancient is always before the cutoff; old only when D - 60 days is after its activity.
    const expected = oldActivity < cutoffMs ? [recent] : [old, recent];
    expect(n).toBe(3 - expected.length);
    expect(left.sort()).toEqual(expected.sort());
  });

  it('the AI KB builder cannot rewrite a locked article', async () => {
    const plan = await makePlan('l-aikb', { max_kb_articles: 1 });
    const { ws, owner } = await makeWorkspace();
    await subscribe(ws, plan);
    const [kept, locked] = await articles(ws, [5, 4]);
    const job = String((await one(
      `INSERT INTO public.ai_kb_jobs (workspace_id, source_kind, source_domain) VALUES ($1, 'workspace_domain', 'example.test') RETURNING id`,
      [ws])).id);
    const draft = async (articleId: string) => String((await one(
      `INSERT INTO public.ai_kb_generated_articles (workspace_id, job_id, title, slug, kb_article_id) VALUES ($1, $2, 'New title', $3, $4) RETURNING id`,
      [ws, job, `g-${randomUUID().slice(0, 8)}`, articleId])).id);
    const onLocked = await draft(locked);
    await expect(q(`SELECT public.publish_ai_kb_generated_article($1, $2, $3, 'body')`, [onLocked, ws, owner]))
      .rejects.toThrow(/kb_article_locked/);
    expect(await one(`SELECT title FROM public.knowledge_base_articles WHERE id = $1`, [locked])).toEqual({ title: 'Article 2' });
    const onKept = await draft(kept);
    expect((await one(`SELECT public.publish_ai_kb_generated_article($1, $2, $3, 'body') AS r`, [onKept, ws, owner])).r)
      .toMatchObject({ ok: true, kb_article_id: kept });
    expect(await one(`SELECT title FROM public.knowledge_base_articles WHERE id = $1`, [kept])).toEqual({ title: 'New title' });
  });

  it('seat capacity: Free\'s seats after expiry, overrides, suspended members hold none while the switch is on', async () => {
    const plan = await makePlan('l-seats', { max_agents: 5 });
    const { ws } = await makeWorkspace();
    await subscribe(ws, plan);
    await member(ws, 3);
    await member(ws, 2, { suspended: true });
    const seats = () => one(`SELECT limit_value, used, source FROM public.wi_resolve_seat_capacity($1)`, [ws]);
    expect(await seats()).toEqual({ limit_value: 5, used: 2, source: 'plan_authoritative' });
    // Switch off: a suspended member still holds a seat, as before 265 (no
    // suspend → invite → reinstate past max_agents while nothing locks).
    await setLocks(false);
    try {
      expect(await seats()).toEqual({ limit_value: 5, used: 3, source: 'plan_authoritative' });
    } finally {
      await setLocks(true);
    }
    await q(`UPDATE public.workspace_subscriptions SET status = 'expired' WHERE workspace_id = $1`, [ws]);
    expect(await seats()).toEqual({ limit_value: 2, used: 2, source: 'plan_authoritative' }); // Free: 2, not 0
    await q(`INSERT INTO public.workspace_limit_overrides (workspace_id, limit_key, limit_value) VALUES ($1, 'max_agents', 4)`, [ws]);
    expect(await seats()).toMatchObject({ limit_value: 4 });
    await q(`UPDATE public.workspace_limit_overrides SET limit_value = -1 WHERE workspace_id = $1`, [ws]);
    expect(await seats()).toMatchObject({ limit_value: null });
    // A plan that does not name max_agents still fails closed, as before.
    await q(`DELETE FROM public.workspace_limit_overrides WHERE workspace_id = $1`, [ws]);
    const trial = String((await one(`SELECT id FROM public.billing_plans WHERE slug = 'trial'`)).id);
    await q(`UPDATE public.workspace_subscriptions SET status = 'active', plan_id = $2 WHERE workspace_id = $1`, [ws, trial]);
    await expect(seats()).rejects.toThrow(/ENTITLEMENT_UNAVAILABLE/);
  });

  it('only service_role reaches the tables and functions', async () => {
    for (const t of ['billing_lock_clocks', 'billing_lock_exports']) {
      const r = await one(
        `SELECT has_table_privilege('anon', $1, 'SELECT') AS anon, has_table_privilege('authenticated', $1, 'SELECT') AS auth,
                has_table_privilege('service_role', $1, 'SELECT,INSERT,UPDATE,DELETE') AS svc,
                (SELECT relrowsecurity FROM pg_class WHERE oid = $1::regclass) AS rls`, [`public.${t}`]);
      expect({ t, ...r }).toEqual({ t, anon: false, auth: false, svc: true, rls: true });
    }
    const fns = await q(
      `SELECT p.oid::regprocedure::text AS fn,
              has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth,
              has_function_privilege('public', p.oid, 'EXECUTE') AS pub,
              has_function_privilege('service_role', p.oid, 'EXECUTE') AS svc
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND (p.proname LIKE 'billing\\_lock%' OR p.proname LIKE 'billing\\_locked%' OR p.proname IN (
            'billing_locks_enabled', 'billing_effective_plan_id', 'billing_limit_raw', 'billing_effective_limit',
            'billing_countable_count', 'billing_is_locked', 'billing_release_locked_agent_chats',
            'wi_resolve_seat_capacity', '_ai_kb_apply_generated'))
        ORDER BY 1`);
    expect(fns.length).toBeGreaterThanOrEqual(21);
    for (const f of fns) expect(f).toEqual({ fn: f.fn, anon: false, auth: false, pub: false, svc: true });
  });

  it('one export at a time per workspace', async () => {
    const { ws, owner } = await makeWorkspace();
    await q(`INSERT INTO public.billing_lock_exports (workspace_id, requested_by, kinds) VALUES ($1, $2, '{contact}')`, [ws, owner]);
    await expect(q(`INSERT INTO public.billing_lock_exports (workspace_id, requested_by, kinds) VALUES ($1, $2, '{kb_article}')`, [ws, owner]))
      .rejects.toThrow(/billing_lock_exports_one_live/);
    await q(`UPDATE public.billing_lock_exports SET status = 'completed' WHERE workspace_id = $1`, [ws]);
    await q(`INSERT INTO public.billing_lock_exports (workspace_id, requested_by, kinds) VALUES ($1, $2, '{kb_article}')`, [ws, owner]);
    await expect(q(`UPDATE public.billing_lock_exports SET status = 'archived' WHERE workspace_id = $1`, [ws]))
      .rejects.toThrow(/billing_lock_exports_status_check/);
  });
});
