/**
 * 248 — the account App Review signs in with, against real PostgreSQL.
 *
 * The seed has to be safe to run before every submission: it brings the
 * account back after App Review deleted it, replaces the demo content
 * without duplicating it, and never turns a blocked account back on.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PgQueryable } from './pgMigrationChain';
import { ensureAuthChainInstalled } from './authStubSchema';

const DSN = process.env.TEST_DATABASE_URL || process.env.CLEAN_INSTALL_DATABASE_URL;
const suite = DSN ? describe : describe.skip;

type PgTestClient = PgQueryable & { connect(): Promise<void>; end(): Promise<void> };

const HASH = '$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNo';

let db: PgTestClient;

async function one<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T> {
  const { rows } = await db.query(sql, params);
  return rows[0] as T;
}

async function cleanUp() {
  await db.query(`
    DELETE FROM public.workspaces WHERE slug = 'ws_appreview';
    DELETE FROM public.accounts WHERE slug = 'acc_appreview';
    DELETE FROM public.profiles
     WHERE email IN ('apple@webyar.ai', 'emma.wilson@demo.webyar.ai', 'daniel.carter@demo.webyar.ai');
    DELETE FROM public.billing_plans WHERE slug = 'app-review';
  `);
}

suite('248 — app_review_seed / app_review_set_enabled (real PostgreSQL)', () => {
  beforeAll(async () => {
    const { Client } = await import('pg');
    db = new Client({ connectionString: DSN }) as unknown as PgTestClient;
    await db.connect();
    await ensureAuthChainInstalled(db);
    await cleanUp();
  }, 120_000);

  afterAll(async () => {
    if (!db) return;
    await cleanUp();
    await db.end();
  });

  it('needs a password the first time', async () => {
    await expect(db.query(`SELECT public.app_review_seed()`)).rejects.toThrow(/app_review_password_required/);
  });

  it('creates the reviewer as an admin of an English workspace owned by someone else', async () => {
    const { status } = await one<{ status: Record<string, unknown> }>(
      `SELECT public.app_review_seed($1) AS status`, [HASH]);
    expect(status).toMatchObject({ email: 'apple@webyar.ai', exists: true, enabled: true, workspace_name: 'Webyar Demo' });

    const members = await db.query(`
      SELECT p.email, m.role::text AS role
        FROM public.workspace_members m
        JOIN public.profiles p ON p.id = m.user_id
        JOIN public.workspaces w ON w.id = m.workspace_id
       WHERE w.slug = 'ws_appreview' ORDER BY p.email`);
    expect(members.rows).toEqual([
      { email: 'apple@webyar.ai', role: 'admin' },
      { email: 'daniel.carter@demo.webyar.ai', role: 'agent' },
      { email: 'emma.wilson@demo.webyar.ai', role: 'owner' },
    ]);

    const creds = await db.query(`
      SELECT p.email, c.status, c.password_hash IS NOT NULL AS has_password, c.email_verified_at IS NOT NULL AS verified
        FROM public.profiles p JOIN public.user_credentials c ON c.user_id = p.id
       WHERE p.email IN ('apple@webyar.ai', 'emma.wilson@demo.webyar.ai', 'daniel.carter@demo.webyar.ai')
       ORDER BY p.email`);
    expect(creds.rows).toEqual([
      { email: 'apple@webyar.ai', status: 'active', has_password: true, verified: true },
      // The colleagues are names on screen; nobody signs in as them.
      { email: 'daniel.carter@demo.webyar.ai', status: 'disabled', has_password: false, verified: false },
      { email: 'emma.wilson@demo.webyar.ai', status: 'disabled', has_password: false, verified: false },
    ]);

    const ws = await one<{ default_locale: string; panel_locale: string; widget_locale: string }>(
      `SELECT default_locale, panel_locale, widget_locale FROM public.workspaces WHERE slug = 'ws_appreview'`);
    expect(ws).toEqual({ default_locale: 'en', panel_locale: 'en', widget_locale: 'en' });
  });

  it('puts the workspace on the hidden all-features plan until 2099', async () => {
    const sub = await one<{ slug: string; is_hidden: boolean; end_year: number; analytics: boolean; email: boolean; promo: boolean }>(`
      SELECT bp.slug, bp.is_hidden, extract(year FROM s.current_period_end)::int AS end_year,
             (bp.entitlements->>'web_analytics')::boolean AS analytics,
             (bp.entitlements->>'email_inbox')::boolean AS email,
             coalesce((bp.entitlements->>'mobile_promo_banner')::boolean, false) AS promo
        FROM public.workspace_subscriptions s
        JOIN public.billing_plans bp ON bp.id = s.plan_id
        JOIN public.workspaces w ON w.id = s.workspace_id
       WHERE w.slug = 'ws_appreview'`);
    expect(sub).toEqual({ slug: 'app-review', is_hidden: true, end_year: 2099, analytics: true, email: true, promo: false });
  });

  it('fills every queue the app shows, in English', async () => {
    const queues = await db.query(`
      SELECT c.status::text AS status, coalesce(c.metadata->>'ai_state', '') AS ai, coalesce(c.metadata->>'channel', 'web') AS channel,
             c.is_spam, c.assigned_to IS NULL OR p.email = 'apple@webyar.ai' AS visible
        FROM public.conversations c
        JOIN public.workspaces w ON w.id = c.workspace_id
        LEFT JOIN public.profiles p ON p.id = c.assigned_to
       WHERE w.slug = 'ws_appreview'`);
    const rows = queues.rows as Array<{ status: string; ai: string; channel: string; is_spam: boolean; visible: boolean }>;
    expect(rows).toHaveLength(13);
    // The inbox lists only unassigned threads and the reviewer's own.
    expect(rows.every((r) => r.visible)).toBe(true);
    expect(rows.filter((r) => r.ai === 'ai_managed')).toHaveLength(2);
    expect(rows.filter((r) => r.ai === 'needs_human')).toHaveLength(1);
    expect(rows.filter((r) => r.status === 'pending')).toHaveLength(1);
    expect(rows.filter((r) => r.status === 'resolved')).toHaveLength(2);
    expect(rows.filter((r) => r.is_spam)).toHaveLength(1);
    expect(new Set(rows.map((r) => r.channel))).toEqual(new Set(['web', 'whatsapp', 'telegram', 'email']));

    // Nothing outside ASCII in what the reviewer reads: no Persian or
    // Turkish left over from the screenshot data.
    const text = await one<{ n: number }>(`
      SELECT count(*)::int AS n FROM public.conversation_messages m
        JOIN public.conversations c ON c.id = m.conversation_id
        JOIN public.workspaces w ON w.id = c.workspace_id
       WHERE w.slug = 'ws_appreview' AND m.body ~ '[\\u0600-\\u06FF]'`);
    expect(text.n).toBe(0);

    const counts = await one<Record<string, number>>(`
      SELECT (SELECT count(*)::int FROM public.contacts k WHERE k.workspace_id = w.id) AS contacts,
             (SELECT count(*)::int FROM public.visitor_sessions s WHERE s.workspace_id = w.id AND s.metadata->>'app_review_live' = 'true') AS live,
             (SELECT count(*)::int FROM public.visitor_sessions s WHERE s.workspace_id = w.id AND s.metadata->>'app_review_traffic' = 'true') AS traffic,
             (SELECT count(*)::int FROM public.team_messages t WHERE t.workspace_id = w.id) AS team,
             (SELECT count(*)::int FROM public.canned_responses r WHERE r.workspace_id = w.id) AS replies
        FROM public.workspaces w WHERE w.slug = 'ws_appreview'`);
    expect(counts.contacts).toBe(13);
    expect(counts.live).toBe(7);
    expect(counts.traffic).toBeGreaterThan(1000);
    expect(counts.team).toBe(5);
    expect(counts.replies).toBe(5);
  });

  it('replaces the content on a second run instead of adding to it', async () => {
    await db.query(`SELECT public.app_review_seed()`);
    const n = await one<{ conversations: number; contacts: number; periods: number }>(`
      SELECT (SELECT count(*)::int FROM public.conversations c WHERE c.workspace_id = w.id) AS conversations,
             (SELECT count(*)::int FROM public.contacts k WHERE k.workspace_id = w.id) AS contacts,
             (SELECT count(*)::int FROM public.billing_subscription_periods p WHERE p.workspace_id = w.id) AS periods
        FROM public.workspaces w WHERE w.slug = 'ws_appreview'`);
    // The plan runs to 2099, so it is granted once.
    expect(n).toEqual({ conversations: 13, contacts: 13, periods: 1 });
  });

  it('turns sign-in off and on, and keeps visitors live only while it is on', async () => {
    const off = await one<{ s: { enabled: boolean } }>(`SELECT public.app_review_set_enabled(false) AS s`);
    expect(off.s.enabled).toBe(false);
    expect((await one<{ n: number }>(`SELECT public.app_review_keep_visitors_live() AS n`)).n).toBe(0);

    // A fresh set of content does not switch it back on.
    const reseeded = await one<{ s: { enabled: boolean } }>(`SELECT public.app_review_seed() AS s`);
    expect(reseeded.s.enabled).toBe(false);

    const on = await one<{ s: { enabled: boolean } }>(`SELECT public.app_review_set_enabled(true) AS s`);
    expect(on.s.enabled).toBe(true);
    expect((await one<{ n: number }>(`SELECT public.app_review_keep_visitors_live() AS n`)).n).toBe(7);
  });

  it('brings the account back after App Review deleted it', async () => {
    await db.query(`DELETE FROM public.profiles WHERE email = 'apple@webyar.ai'`);
    expect((await one<{ s: { exists: boolean } }>(`SELECT public.app_review_status() AS s`)).s.exists).toBe(false);
    await expect(db.query(`SELECT public.app_review_set_enabled(true)`)).rejects.toThrow(/app_review_account_missing/);

    const back = await one<{ s: { exists: boolean; enabled: boolean } }>(`SELECT public.app_review_seed($1) AS s`, [HASH]);
    expect(back.s).toMatchObject({ exists: true, enabled: true });
    const role = await one<{ role: string }>(`
      SELECT m.role::text AS role FROM public.workspace_members m
        JOIN public.profiles p ON p.id = m.user_id
        JOIN public.workspaces w ON w.id = m.workspace_id
       WHERE w.slug = 'ws_appreview' AND p.email = 'apple@webyar.ai'`);
    expect(role.role).toBe('admin');
  });

  it('is for the service role only', async () => {
    const grants = await db.query(`
      SELECT p.proname, has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
             has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authed
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname LIKE 'app_review_%'`);
    expect(grants.rows.length).toBe(4);
    for (const row of grants.rows as Array<{ anon: boolean; authed: boolean }>) {
      expect(row.anon).toBe(false);
      expect(row.authed).toBe(false);
    }
  });
});
