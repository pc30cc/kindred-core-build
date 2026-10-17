// @vitest-environment node
/**
 * 275 — the chat widget template catalog, against a database built by the
 * whole chain, and through the real data layer (postgres-only).
 *
 *   T1  widget_edition_settings: one row per edition, an object catalog of
 *       bounded size; nothing seeded;
 *   T2  only service_role reaches it (RLS on, anon / authenticated denied);
 *   T3  widget_settings.widget_template_id (nullable, a slug) and
 *       widget_template_options (an object, `{}` by default) — existing rows
 *       read NULL and `{}`, i.e. the default template as before;
 *   T4  kb_article_feedback.rating also accepts 'neutral';
 *   T5  275 runs twice and every check is still there once;
 *   T6  the server's store (server/services/widget/templateCatalog.ts): the
 *       Super Admin's upsert creates then updates the edition's row, the
 *       platform snapshot read sees it, usage counts are right;
 *   T7  a database from before 275 (no table, no columns): the real data
 *       layer's errors read as "no catalog" and as migration_required;
 *   T8  275 sets its own lock_timeout (a runner with no PGOPTIONS gives up
 *       after 5 s instead of queueing widget reads) and resets it at the end.
 *
 * Driven by TEST_DATABASE_URL; skipped without it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { createFullChainDatabase, type FullChainDatabase } from './fullChainDatabase';
import { applyMigrationSql } from './pgMigrationChain';

const DSN = process.env.TEST_DATABASE_URL;
const suite = DSN ? describe : describe.skip;
const FILE = resolve(process.cwd(), 'database/migrations/275_widget_template_catalog.sql');

type Row = Record<string, unknown>;

suite('275 — chat widget template catalog (real PostgreSQL)', () => {
  let chain: FullChainDatabase;
  let config: import('../../../server/config.js').ServerConfig;
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
  const workspaces: string[] = [];

  beforeAll(async () => {
    chain = await createFullChainDatabase(DSN!, `widgetcatalog275_${Date.now()}`);
    for (let i = 0; i < 3; i += 1) {
      const owner = randomUUID();
      const ws = randomUUID();
      await q(`INSERT INTO public.profiles (id, email) VALUES ($1, $2)`, [owner, `o-${owner.slice(0, 8)}@test.local`]);
      await q(`INSERT INTO public.workspaces (id, name, slug, owner_id) VALUES ($1, 'Acme', $2, $3)`, [ws, `ws-${ws.slice(0, 8)}`, owner]);
      await q(`INSERT INTO public.widget_settings (workspace_id) VALUES ($1) ON CONFLICT DO NOTHING`, [ws]);
      workspaces.push(ws);
    }
    Object.assign(process.env, {
      DATABASE_URL: chain.url,
      PLATFORM_SIGNING_SECRET: 'signing-secret-for-this-test-only-0123456789',
      SUPABASE_URL: 'https://legacy-project.supabase.co',
      SUPABASE_ANON_KEY: 'legacy-anon-key-value',
      SUPABASE_SERVICE_ROLE_KEY: 'legacy-service-role-key-value-at-least-32',
      CORS_ORIGINS: 'http://127.0.0.1',
    });
    delete process.env.DATABASE_MODE;
    const { loadConfig } = await import('../../../server/config.js');
    config = loadConfig();
  }, 600_000);

  afterAll(async () => {
    const { closeDataLayer } = await import('../../../server/db/index.js');
    await closeDataLayer();
    await chain?.drop();
  });

  it('T1 one row per edition, an object catalog of bounded size, nothing seeded', async () => {
    expect(await q(`SELECT * FROM public.widget_edition_settings`)).toEqual([]);
    await q(`INSERT INTO public.widget_edition_settings (edition) VALUES ('iran')`);
    expect(await one(`SELECT chat_templates FROM public.widget_edition_settings WHERE edition = 'iran'`)).toEqual({ chat_templates: {} });
    expect(await errorOf(q(`INSERT INTO public.widget_edition_settings (edition) VALUES ('iran')`))).toContain('duplicate key');
    expect(await errorOf(q(`INSERT INTO public.widget_edition_settings (edition) VALUES ('mars')`))).toContain('widget_edition_settings_edition_check');
    expect(await errorOf(q(`UPDATE public.widget_edition_settings SET chat_templates = '[]'`))).toContain('widget_edition_settings_chat_templates_check');
    expect(await errorOf(q(`UPDATE public.widget_edition_settings SET chat_templates = jsonb_build_object('x', repeat('a', 17000))`)))
      .toContain('widget_edition_settings_chat_templates_check');
    await q(`DELETE FROM public.widget_edition_settings`);
  });

  it('T2 only service_role reaches the table', async () => {
    const rls = await one(`SELECT relrowsecurity FROM pg_class WHERE oid = 'public.widget_edition_settings'::regclass`);
    expect(rls.relrowsecurity).toBe(true);
    for (const role of ['anon', 'authenticated']) {
      const priv = await one(`SELECT has_table_privilege($1, 'public.widget_edition_settings', 'SELECT') AS s,
                                     has_table_privilege($1, 'public.widget_edition_settings', 'UPDATE') AS u`, [role]);
      expect(priv).toEqual({ s: false, u: false });
    }
    expect((await one(`SELECT has_table_privilege('service_role', 'public.widget_edition_settings', 'INSERT') AS i`)).i).toBe(true);
    const denied = await errorOf((async () => {
      await q('BEGIN');
      try {
        await q('SET LOCAL ROLE authenticated');
        await q('SELECT * FROM public.widget_edition_settings');
      } finally {
        await q('ROLLBACK');
      }
    })());
    expect(denied).toContain('permission denied');
  });

  it('T3 the workspace choice and options: NULL and {} for every existing row, shape-checked', async () => {
    const cols = await q(`SELECT column_name, is_nullable, column_default FROM information_schema.columns
                           WHERE table_schema = 'public' AND table_name = 'widget_settings' AND column_name LIKE 'widget_template%'
                           ORDER BY column_name`);
    expect(cols).toEqual([
      { column_name: 'widget_template_id', is_nullable: 'YES', column_default: null },
      { column_name: 'widget_template_options', is_nullable: 'NO', column_default: "'{}'::jsonb" },
    ]);
    const rows = await q(`SELECT widget_template_id, widget_template_options FROM public.widget_settings WHERE workspace_id = ANY($1)`, [workspaces]);
    expect(rows).toEqual(workspaces.map(() => ({ widget_template_id: null, widget_template_options: {} })));
    const ws = workspaces[0];
    await q(`UPDATE public.widget_settings SET widget_template_id = 't1' WHERE workspace_id = $1`, [ws]);
    for (const bad of ['Simple Home', 'T1', '-t1', 'x'.repeat(33), 'a_b']) {
      expect(await errorOf(q(`UPDATE public.widget_settings SET widget_template_id = $2 WHERE workspace_id = $1`, [ws, bad])))
        .toContain('widget_settings_widget_template_id_check');
    }
    expect(await errorOf(q(`UPDATE public.widget_settings SET widget_template_options = '[]' WHERE workspace_id = $1`, [ws])))
      .toContain('widget_settings_widget_template_options_check');
    expect(await errorOf(q(`UPDATE public.widget_settings SET widget_template_options = NULL WHERE workspace_id = $1`, [ws])))
      .toContain('null value');
    await q(`UPDATE public.widget_settings SET widget_template_id = NULL WHERE workspace_id = $1`, [ws]);
  });

  it('T4 KB article feedback accepts a neutral answer', async () => {
    const def = await one(`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = 'kb_article_feedback_rating_chk'`);
    expect(String(def.d)).toMatch(/'up'.*'neutral'.*'down'/);
  });

  it('T5 275 runs twice; every check exists once', async () => {
    await applyMigrationSql(chain.db, readFileSync(FILE, 'utf8'));
    const checks = await q(`SELECT conname FROM pg_constraint WHERE conname IN (
        'widget_edition_settings_edition_check', 'widget_edition_settings_chat_templates_check',
        'widget_settings_widget_template_id_check', 'widget_settings_widget_template_options_check',
        'kb_article_feedback_rating_chk') ORDER BY conname`);
    expect(checks.map((c) => c.conname)).toEqual([
      'kb_article_feedback_rating_chk',
      'widget_edition_settings_chat_templates_check',
      'widget_edition_settings_edition_check',
      'widget_settings_widget_template_id_check',
      'widget_settings_widget_template_options_check',
    ]);
    const policies = await q(`SELECT policyname FROM pg_policies WHERE tablename = 'widget_edition_settings'`);
    expect(policies).toEqual([{ policyname: 'service_role_only' }]);
  });

  it('T6 the server store reads, upserts and counts through the real data layer', async () => {
    const store = await import('../../../server/services/widget/templateCatalog.js');
    const { getServiceClient } = await import('../../../server/supabase.js');
    expect(await store.readEditionChatTemplates(config, 'iran')).toEqual({ ready: true, stored: null, updatedAt: null, updatedBy: null });
    const admin = randomUUID();
    const first = await store.saveEditionChatTemplates(config, 'iran', { default: 'default', items: { t1: { enabled: true } } }, admin);
    expect(first.error).toBeNull();
    const second = await store.saveEditionChatTemplates(config, 'iran', { default: 't1', items: { t1: { enabled: true, name: { fa: 'فیروزه' } } } }, admin);
    expect(second.error).toBeNull();
    const row = await store.readEditionChatTemplates(config, 'iran');
    expect(row).toMatchObject({ ready: true, updatedBy: admin, stored: { default: 't1', items: { t1: { enabled: true, name: { fa: 'فیروزه' } } } } });
    expect((await q(`SELECT count(*)::int AS n FROM public.widget_edition_settings`))[0].n).toBe(1);

    const rows = await store.readChatTemplateRows(getServiceClient(config));
    expect(rows).toEqual({ byEdition: { iran: row.stored }, ready: true, error: false });

    await q(`UPDATE public.widget_settings SET widget_template_id = 't1' WHERE workspace_id = $1`, [workspaces[1]]);
    const usage = await store.countTemplateUsage(config, ['default', 't1', 't2']);
    const unchosen = (await one(`SELECT count(*)::int AS n FROM public.widget_settings WHERE widget_template_id IS NULL`)).n;
    expect(usage).toEqual({ chosenBy: { default: 0, t1: 1, t2: 0 }, followingDefault: unchosen });
  });

  it('T7 a database from before 275: the real data layer\'s errors read as "no catalog" / migration_required', async () => {
    const store = await import('../../../server/services/widget/templateCatalog.js');
    const { getServiceClient } = await import('../../../server/supabase.js');
    const sb = getServiceClient(config);
    try {
      // No table yet: the snapshot read is "not ready", never degraded; the Super Admin reads the defaults.
      await q(`ALTER TABLE public.widget_edition_settings RENAME TO widget_edition_settings_hidden`);
      expect(await store.readChatTemplateRows(sb)).toEqual({ byEdition: {}, ready: false, error: false });
      expect(await store.readEditionChatTemplates(config, 'iran')).toEqual({ ready: false, stored: null, updatedAt: null, updatedBy: null });
      const save = await store.saveEditionChatTemplates(config, 'iran', { default: 'default' }, randomUUID());
      expect(store.isCatalogTableMissing(save.error)).toBe(true);
      await q(`ALTER TABLE public.widget_edition_settings_hidden RENAME TO widget_edition_settings`);

      // No columns yet: a template write is recognised (409 migration_required), counts are left out.
      await q(`ALTER TABLE public.widget_settings DROP COLUMN widget_template_id, DROP COLUMN widget_template_options`);
      for (const patch of [{ widget_template_id: 't1' }, { widget_template_options: {} }]) {
        const { error } = await sb.from('widget_settings').update(patch).eq('workspace_id', workspaces[0]).select().single();
        expect(store.isTemplateColumnMissing(error), JSON.stringify(error)).toBe(true);
      }
      expect(await store.countTemplateUsage(config, ['default', 't1'])).toBeNull();
    } finally {
      if ((await q(`SELECT to_regclass('public.widget_edition_settings_hidden') AS t`))[0].t) {
        await q(`ALTER TABLE public.widget_edition_settings_hidden RENAME TO widget_edition_settings`);
      }
      await applyMigrationSql(chain.db, readFileSync(FILE, 'utf8'));
    }
    expect((await one(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'widget_settings' AND column_name LIKE 'widget_template%'`)).n).toBe(2);
  });

  it('T8 275 sets its own lock_timeout: with no PGOPTIONS it gives up instead of queueing every widget_settings read', async () => {
    // RESPOK's migrator runs scripts/migrate-database.sh with no PGOPTIONS. Without
    // a lock_timeout of its own, 275's ALTER of widget_settings waits behind any
    // open transaction there, and every widget read queues behind that wait.
    const locker = new pg.Client({ connectionString: chain.url });
    const runner = new pg.Client({ connectionString: chain.url });
    await Promise.all([locker.connect(), runner.connect()]);
    try {
      expect((await runner.query('SHOW lock_timeout')).rows[0].lock_timeout).toBe('0');
      await locker.query('BEGIN');
      await locker.query('LOCK TABLE public.widget_settings IN ROW SHARE MODE');
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
  }, 30_000);
});
