// @vitest-environment node
/**
 * 285 — the App Review workspace (ws_appreview, the account apple@webyar.ai)
 * is never closed for quiet (owner, 2026-10-26), on a real database: the
 * chain up to 284 and the real seed (249), then 285 applied to it as
 * WebYar's is by hand.
 *
 *   Before 285 a conversation started in that workspace after the seed (no
 *   app_review_seed mark) is due; after it, it reads not_widget, stays out of
 *   the ticker's work list, and the close refuses it (timer and backlog),
 *   while the same conversation in another workspace is still due. The
 *   seeded threads read as before. The backlog script's dry run lists the
 *   other workspace's row only. A second run changes nothing; the function
 *   stays service_role's; without 284 the file stops.
 *
 * Driven by TEST_DATABASE_URL; skipped without it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { applyMigrationSql } from './pgMigrationChain';

const DSN = process.env.TEST_DATABASE_URL;
const suite = DSN ? describe : describe.skip;
const PSQL = spawnSync('psql', ['--version']).status === 0;

type Row = Record<string, unknown>;

const MIGRATION = resolve(process.cwd(), 'database/migrations/285_inactivity_close_app_review_workspace.sql');
const BACKLOG = resolve(process.cwd(), 'database/backfill/284_inactivity_backlog_close.sql');
/** The App Review reviewer's password hash (appReviewAccount.pg.test.ts's). */
const APP_REVIEW_HASH = '$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNo';

suite('285 — the App Review workspace is never closed for quiet (real PostgreSQL: the chain to 284, the seed, then 285)', () => {
  let admin: pg.Client;
  let db: pg.Client;
  let url = '';
  const name = `idle_close_285_${Date.now()}`;
  const q = async (sql: string, p: unknown[] = []): Promise<Row[]> => (await db.query(sql, p)).rows as Row[];
  const one = async (sql: string, p: unknown[] = []): Promise<Row> => (await q(sql, p))[0];

  const owner = randomUUID();
  const ws = randomUUID();
  let review = '';
  let tried = '';
  let twin = '';

  /** A widget conversation, its only message the team's, `quiet` ago. */
  const quietConversation = async (workspace: string, quiet = '30 hours') => {
    const id = randomUUID();
    await q(`INSERT INTO public.conversations (id, workspace_id, status, metadata, created_at, updated_at)
             VALUES ($1, $2, 'open', '{"visitor_id":"visitor-285"}'::jsonb, now() - $3::interval - interval '1 hour', now() - $3::interval)`,
    [id, workspace, quiet]);
    await q(`INSERT INTO public.conversation_messages (id, conversation_id, sender_type, sender_id, body, metadata, created_at)
             VALUES ($1, $2, 'agent', $3, 'Hello', '{}'::jsonb, now() - $4::interval)`, [randomUUID(), id, owner, quiet]);
    return id;
  };
  const verdict = async (cid: string) => (await one(`SELECT verdict FROM public.conversation_idle_check($1)`, [cid])).verdict;
  const dueIds = async () => (await q(`SELECT due_conversation_id FROM public.conversation_idle_due(500)`)).map((r) => r.due_conversation_id);
  const close = async (cid: string, source: string) => one(
    `SELECT closed, outcome FROM public.conversation_close_if_idle($1, (SELECT updated_at FROM public.conversations WHERE id = $1), $2, NULL, NULL)`,
    [cid, source],
  );
  const seededVerdicts = async () => q(
    `SELECT c.status::text AS status, c.is_spam, c.metadata->>'app_review_seed' AS seed, chk.verdict
       FROM public.conversations c
       CROSS JOIN LATERAL public.conversation_idle_check(c.id) chk
      WHERE c.workspace_id = $1 AND c.id <> $2`, [review, tried],
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
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql') && f < '285').sort()) {
      await applyMigrationSql(db, readFileSync(resolve(dir, file), 'utf8'));
    }

    await q(`INSERT INTO public.profiles (id, email, full_name) VALUES ($1, $2, 'Owner')`, [owner, `p-${owner.slice(0, 8)}@test.local`]);
    await q(`INSERT INTO public.workspaces (id, name, slug, owner_id) VALUES ($1, 'Acme', $2, $3)`, [ws, `ws-${ws.slice(0, 8)}`, owner]);
    await q(`INSERT INTO public.workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner') ON CONFLICT DO NOTHING`, [ws, owner]);
    await q(`INSERT INTO public.widget_settings (workspace_id, enabled) VALUES ($1, true) ON CONFLICT (workspace_id) DO NOTHING`, [ws]);
    // The real demo (249): the workspace, its account and its seeded threads.
    await q(`SELECT public.app_review_seed($1)`, [APP_REVIEW_HASH]);
    review = (await one(`SELECT id FROM public.workspaces WHERE slug = 'ws_appreview'`)).id as string;
    await q(`UPDATE public.widget_platform_settings SET inactivity_close_enabled = true, inactivity_close_default_hours = 24`);
    // Started there after the seed (the reviewer trying the widget): no mark.
    tried = await quietConversation(review);
    twin = await quietConversation(ws);
  }, 600_000);

  afterAll(async () => {
    await db?.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end();
    }
  });

  it('before 285: a conversation started in the App Review workspace after the seed is due (284 left out the seeded threads only)', async () => {
    expect((await one(`SELECT metadata->>'app_review_seed' AS seed FROM public.conversations WHERE id = $1`, [tried])).seed).toBeNull();
    expect(await verdict(tried)).toBe('due');
    expect(await verdict(twin)).toBe('due');
    expect((await dueIds()).sort()).toEqual([tried, twin].sort());
  });

  it('after 285: the whole workspace reads not_widget, stays out of idle_due, and neither the timer nor the backlog closes it; the twin elsewhere is still due', async () => {
    const seededBefore = await seededVerdicts();
    expect(seededBefore.length).toBeGreaterThan(0);
    await applyMigrationSql(db, readFileSync(MIGRATION, 'utf8'));
    expect(await verdict(tried)).toBe('not_widget');
    expect(await verdict(twin)).toBe('due');
    expect(await dueIds()).toEqual([twin]);
    expect(await close(tried, 'timer')).toMatchObject({ closed: false, outcome: 'not_widget' });
    expect(await close(tried, 'backlog')).toMatchObject({ closed: false, outcome: 'not_widget' });
    expect((await one(`SELECT status::text AS status FROM public.conversations WHERE id = $1`, [tried])).status).toBe('open');
    // The seeded threads read exactly as under 284.
    expect(await seededVerdicts()).toEqual(seededBefore);
    for (const r of seededBefore) {
      expect(r.verdict).toBe(!['open', 'pending', 'resolved'].includes(r.status as string) ? 'not_live' : r.is_spam ? 'spam' : 'not_widget');
    }
  });

  (PSQL ? it : it.skip)('the backlog script\'s dry run leaves the App Review workspace out of its listing and its due list', async () => {
    const out = join(mkdtempSync(join(tmpdir(), 'backlog285-')), 'backlog.csv');
    const res = spawnSync('psql', [url, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-v', `out=${out}`, '-f', BACKLOG], { encoding: 'utf8' });
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toMatch(/Dry run: rolled back/);
    expect(res.stdout).toContain(twin);
    expect(res.stdout).not.toContain(tried);
    expect(res.stdout).not.toContain(review);
    expect(readFileSync(out, 'utf8').trim().split('\n')).toEqual([twin]);
    expect((await one(`SELECT status::text AS status FROM public.conversations WHERE id = $1`, [twin])).status).toBe('open');
  });

  it('a second run changes nothing, and only service_role may execute the function', async () => {
    await applyMigrationSql(db, readFileSync(MIGRATION, 'utf8'));
    expect(await verdict(tried)).toBe('not_widget');
    expect(await dueIds()).toEqual([twin]);
    const acl = await one(`SELECT has_function_privilege('public', 'public.conversation_idle_check(uuid)', 'EXECUTE') AS everyone,
                                  has_function_privilege('anon', 'public.conversation_idle_check(uuid)', 'EXECUTE') AS anon,
                                  has_function_privilege('authenticated', 'public.conversation_idle_check(uuid)', 'EXECUTE') AS authenticated,
                                  has_function_privilege('service_role', 'public.conversation_idle_check(uuid)', 'EXECUTE') AS service`);
    expect(acl).toEqual({ everyone: false, anon: false, authenticated: false, service: true });
  });

  it('without 284 the file stops before it creates anything', async () => {
    await q('BEGIN');
    try {
      await q(`DROP FUNCTION public.conversation_idle_check(uuid)`);
      await expect(applyMigrationSql(db, readFileSync(MIGRATION, 'utf8'))).rejects.toThrow(/285 needs 284/);
    } finally {
      await q('ROLLBACK');
    }
    expect(await verdict(tried)).toBe('not_widget');
  });
});
