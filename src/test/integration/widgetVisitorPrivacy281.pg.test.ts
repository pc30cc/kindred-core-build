// @vitest-environment node
/**
 * 281 — visitor privacy (P-01), against a database built by the whole chain
 * and, for the retention runs, the real retention engine
 * (server/services/retention/retentionService.ts) through the real data
 * layer:
 *
 *   T1  the new settings: defaults (consent not asked, query strings not
 *       kept, the platform's period, no privacy line) and the CHECKs (a
 *       period of 30..1095 days, a line of at most 300 characters, an https
 *       policy link);
 *   T2  the five visitor tracking policies are seeded rolling, 395 days,
 *       enabled and workspace-overridable; a policy the Super Admin tuned is
 *       kept when the file runs again, and the file runs twice cleanly;
 *   T3  a sweep (visitorRetention.ts) deletes each workspace's rows older
 *       than its own period, else 13 months, and nothing newer: a preview
 *       counts without deleting; a deleted session takes its page views and
 *       presence along, unlinks its analytics events, and its conversation
 *       keeps its messages; every run is recorded;
 *   T4  a disabled policy deletes nothing, and the functions refuse a
 *       policy that is not a workspace-overridable rolling one.
 *
 * Driven by TEST_DATABASE_URL; skipped without it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createFullChainDatabase, type FullChainDatabase } from './fullChainDatabase';
import { applyMigrationSql } from './pgMigrationChain';

const DSN = process.env.TEST_DATABASE_URL;
const suite = DSN ? describe : describe.skip;
const FILE = resolve(process.cwd(), 'database/migrations/281_widget_visitor_privacy.sql');
const KEYS = ['visitor_page_views', 'visitor_sessions', 'web_analytics_events', 'widget_ai_nudges', 'widget_smart_events'];

type Row = Record<string, unknown>;

suite('281 — visitor privacy: consent, the forms\' line, retention (real PostgreSQL)', () => {
  let chain: FullChainDatabase;
  let config: never;
  const q = async (sql: string, p: unknown[] = []) => (await chain.db.query(sql, p)).rows as Row[];
  const n = async (sql: string, p: unknown[] = []) => Number((await q(sql, p))[0].n);
  const owner = randomUUID();
  const wsDefault = randomUUID();
  const wsShort = randomUUID();

  beforeAll(async () => {
    chain = await createFullChainDatabase(DSN!, `visitor_privacy281_${Date.now()}`);
    Object.assign(process.env, {
      DATABASE_URL: chain.url,
      PLATFORM_SIGNING_SECRET: 'signing-secret-for-this-test-only-0123456789',
      SUPABASE_URL: 'https://legacy-project.supabase.co',
      SUPABASE_ANON_KEY: 'legacy-anon-key-value',
      SUPABASE_SERVICE_ROLE_KEY: 'legacy-service-role-key-value-at-least-32',
      APP_BASE_URL: 'http://127.0.0.1:5173',
      RETENTION_BATCH_PAUSE_MS: '0',
    });
    delete process.env.DATABASE_MODE;
    await q(`INSERT INTO public.profiles (id, email, full_name) VALUES ($1, 'o281@test.local', 'Owner')`, [owner]);
    for (const id of [wsDefault, wsShort]) {
      await q(`INSERT INTO public.workspaces (id, name, slug, owner_id) VALUES ($1, 'Shop', $2, $3)`, [id, `ws-${id.slice(0, 8)}`, owner]);
    }
    const { loadConfig } = await import('../../../server/config.js');
    config = loadConfig() as never;
  }, 600_000);

  afterAll(async () => {
    const { closeDataLayer } = await import('../../../server/db/index.js');
    await closeDataLayer().catch(() => undefined);
    await chain?.drop();
  });

  it('T1 the settings: their defaults, and what the table refuses', async () => {
    await q(`INSERT INTO public.widget_settings (workspace_id) VALUES ($1) ON CONFLICT (workspace_id) DO NOTHING`, [wsDefault]);
    expect((await q(`SELECT tracking_requires_consent, tracking_keep_query, visitor_data_retention_days FROM public.widget_settings WHERE workspace_id = $1`, [wsDefault]))[0])
      .toEqual({ tracking_requires_consent: false, tracking_keep_query: false, visitor_data_retention_days: null });
    for (const days of [29, 1096]) {
      await expect(q(`UPDATE public.widget_settings SET visitor_data_retention_days = $2 WHERE workspace_id = $1`, [wsDefault, days])).rejects.toMatchObject({ code: '23514' });
    }
    await q(`UPDATE public.widget_settings SET visitor_data_retention_days = 30 WHERE workspace_id = $1`, [wsDefault]);
    await q(`UPDATE public.widget_settings SET visitor_data_retention_days = NULL WHERE workspace_id = $1`, [wsDefault]);

    await q(`INSERT INTO public.widget_prechat_settings (workspace_id) VALUES ($1)`, [wsDefault]);
    expect((await q(`SELECT privacy_notice_enabled, privacy_notice_text, privacy_policy_url, privacy_consent_required FROM public.widget_prechat_settings WHERE workspace_id = $1`, [wsDefault]))[0])
      .toEqual({ privacy_notice_enabled: false, privacy_notice_text: null, privacy_policy_url: null, privacy_consent_required: false });
    await expect(q(`UPDATE public.widget_prechat_settings SET privacy_notice_text = $2 WHERE workspace_id = $1`, [wsDefault, 'x'.repeat(301)])).rejects.toMatchObject({ code: '23514' });
    for (const url of ['http://shop.example/p', 'javascript:alert(1)', 'https://shop.example/a b']) {
      await expect(q(`UPDATE public.widget_prechat_settings SET privacy_policy_url = $2 WHERE workspace_id = $1`, [wsDefault, url]), url).rejects.toMatchObject({ code: '23514' });
    }
    await q(`UPDATE public.widget_prechat_settings SET privacy_policy_url = 'https://shop.example/privacy', privacy_notice_text = $2 WHERE workspace_id = $1`, [wsDefault, 'x'.repeat(300)]);
  });

  it('T2 the policies are seeded once; a tuned one is kept; the file runs again cleanly', async () => {
    const rows = await q(`SELECT policy_key, table_name, retention_mode, hot_retention_days, enabled, workspace_overridable, category
                          FROM public.data_retention_policies WHERE policy_key = ANY($1) ORDER BY policy_key`, [KEYS]);
    expect(rows.map((r) => r.policy_key)).toEqual(KEYS);
    for (const r of rows) {
      expect(r).toMatchObject({ table_name: r.policy_key, retention_mode: 'rolling', hot_retention_days: 395, enabled: true, workspace_overridable: true, category: 'analytics' });
    }
    await q(`UPDATE public.data_retention_policies SET hot_retention_days = 200 WHERE policy_key = 'web_analytics_events'`);
    await applyMigrationSql(chain.db, readFileSync(FILE, 'utf8'));
    expect(await n(`SELECT hot_retention_days AS n FROM public.data_retention_policies WHERE policy_key = 'web_analytics_events'`)).toBe(200);
    await q(`UPDATE public.data_retention_policies SET hot_retention_days = 395 WHERE policy_key = 'web_analytics_events'`);
    expect(await n(`SELECT count(*) AS n FROM pg_index WHERE indexrelid = 'public.widget_smart_events_ws_created_idx'::regclass AND indisvalid`)).toBe(1);
  });

  it('T3 a sweep keeps each workspace\'s period: older rows go, newer ones stay', async () => {
    // wsShort keeps 30 days; wsDefault the platform's 395.
    await q(`INSERT INTO public.widget_settings (workspace_id, visitor_data_retention_days) VALUES ($1, 30)
             ON CONFLICT (workspace_id) DO UPDATE SET visitor_data_retention_days = 30`, [wsShort]);
    const sessions: Record<string, string> = {};
    const add = async (label: string, ws: string, ageDays: number) => {
      const id = randomUUID();
      sessions[label] = id;
      const at = `now() - interval '${ageDays} days'`;
      await q(`INSERT INTO public.visitor_sessions (id, workspace_id, visitor_id, started_at, last_seen_at) VALUES ($1, $2, $3, ${at}, ${at})`, [id, ws, `v-${label}`]);
      await q(`INSERT INTO public.visitor_page_views (workspace_id, visitor_session_id, url, viewed_at) VALUES ($1, $2, '/p', ${at})`, [ws, id]);
      await q(`INSERT INTO public.visitor_presence (workspace_id, visitor_session_id) VALUES ($1, $2)`, [ws, id]);
      await q(`INSERT INTO public.web_analytics_events (workspace_id, visitor_session_id, event_name, properties, created_at) VALUES ($1, $2, 'e', '{}'::jsonb, ${at})`, [ws, id]);
      await q(`INSERT INTO public.widget_ai_nudges (workspace_id, visitor_id, session_key, topic, message, created_at, expires_at) VALUES ($1, $2, $3, 't', 'm', ${at}, ${at})`, [ws, `v-${label}`, `sk-${label}`]);
    };
    await add('default-old', wsDefault, 400);
    await add('default-recent', wsDefault, 100);
    await add('short-old', wsShort, 40);
    await add('short-recent', wsShort, 10);
    // A conversation of a session that goes keeps its message.
    const conversation = randomUUID();
    await q(`INSERT INTO public.conversations (id, workspace_id, visitor_session_id) VALUES ($1, $2, $3)`, [conversation, wsShort, sessions['short-old']]);
    await q(`INSERT INTO public.conversation_messages (conversation_id, sender_type, body) VALUES ($1, 'contact', 'سلام')`, [conversation]);

    const { runPolicy } = await import('../../../server/services/retention/retentionService.js');
    const preview = await runPolicy(config, 'visitor_sessions', { dryRun: true, triggeredBy: 'test' });
    expect(preview).toMatchObject({ status: 'completed', rowsMatched: 2, rowsDeleted: 0 });
    expect(await n(`SELECT count(*) AS n FROM public.visitor_sessions`)).toBe(4);

    const { sweepVisitorDataRetention } = await import('../../../server/services/privacy/visitorRetention.js');
    const out = await sweepVisitorDataRetention(config);
    expect(out).toEqual(Object.fromEntries(KEYS.map((k) => [k, 'completed'])));

    const left = (await q(`SELECT visitor_id FROM public.visitor_sessions ORDER BY visitor_id`)).map((r) => r.visitor_id);
    expect(left).toEqual(['v-default-recent', 'v-short-recent']);
    expect(await n(`SELECT count(*) AS n FROM public.visitor_page_views`)).toBe(2);
    expect(await n(`SELECT count(*) AS n FROM public.visitor_presence`)).toBe(2);
    expect(await n(`SELECT count(*) AS n FROM public.web_analytics_events`)).toBe(2);
    expect((await q(`SELECT visitor_id FROM public.widget_ai_nudges ORDER BY visitor_id`)).map((r) => r.visitor_id)).toEqual(['v-default-recent', 'v-short-recent']);
    expect(await n(`SELECT count(*) AS n FROM public.conversation_messages WHERE conversation_id = $1`, [conversation])).toBe(1);

    const runs = await q(`SELECT policy_key, status, rows_deleted, triggered_by FROM public.data_retention_runs WHERE triggered_by = 'visitor_retention' ORDER BY policy_key`);
    expect(runs.map((r) => [r.policy_key, r.status])).toEqual(KEYS.map((k) => [k, 'completed']));
    expect(Number(runs.find((r) => r.policy_key === 'visitor_sessions')!.rows_deleted)).toBe(2);
    // A second sweep finds nothing more.
    const again = await runPolicy(config, 'visitor_sessions', { triggeredBy: 'test' });
    expect(again).toMatchObject({ status: 'completed', rowsMatched: 0, rowsDeleted: 0 });
  });

  it('T4 a disabled policy deletes nothing; the functions refuse any other kind of policy', async () => {
    await q(`UPDATE public.data_retention_policies SET enabled = false WHERE policy_key = 'visitor_sessions'`);
    const id = randomUUID();
    await q(`INSERT INTO public.visitor_sessions (id, workspace_id, visitor_id, last_seen_at) VALUES ($1, $2, 'v-ancient', now() - interval '900 days')`, [id, wsDefault]);
    const { runPolicy } = await import('../../../server/services/retention/retentionService.js');
    expect(await runPolicy(config, 'visitor_sessions', { triggeredBy: 'test' })).toMatchObject({ status: 'skipped' });
    await expect(q(`SELECT public.visitor_data_retention_delete_batch('visitor_sessions', 100)`)).rejects.toThrow(/retention_policy_disabled/);
    expect(await n(`SELECT count(*) AS n FROM public.visitor_sessions WHERE id = $1`, [id])).toBe(1);
    await q(`UPDATE public.data_retention_policies SET enabled = true WHERE policy_key = 'visitor_sessions'`);

    await expect(q(`SELECT public.visitor_data_retention_count_expired('audit_logs')`)).rejects.toThrow(/retention_policy_not_overridable/);
    await expect(q(`SELECT public.visitor_data_retention_count_expired('conversations')`)).rejects.toThrow(/retention_policy_not_rolling/);
    await expect(q(`SELECT public.visitor_data_retention_count_expired('nope')`)).rejects.toThrow(/retention_policy_not_found/);
  });
});
