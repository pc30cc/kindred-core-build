/**
 * 137 — billing_provider_credentials: the ONE canonical provider-settings
 * source, against real PostgreSQL.
 *
 * Before this migration a billing provider's credentials could live in
 * billing_gateways.config (per-provider, operational table) AND in
 * app_runtime_config.default_billing_provider.config (a singleton "current
 * default" pointer) simultaneously, with no rule for which wins on drift.
 * This suite proves the migration:
 *   - backfills every gateway's existing credentials into the new canonical
 *     table (nothing is lost);
 *   - lets the Providers-entered value win over a stale billing_gateways
 *     value for the SAME provider (item 4: "billing_gateways must not
 *     silently override credentials entered in Providers");
 *   - never migrates an empty config;
 *   - trims the default-provider pointer (both the modern and legacy key
 *     shapes) down to a name-only value — it must never carry `.config`
 *     again;
 *   - is idempotent (a second apply changes nothing);
 *   - registers the new table in the purge-protection allow-list (127).
 *
 * CI-MANDATORY like the other billing .pg.test.ts suites.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DSN = process.env.TEST_DATABASE_URL;
const REQUIRED = process.env.REQUIRE_BILLING_DB === '1';

if (REQUIRED && !DSN) {
  throw new Error(
    'REQUIRE_BILLING_DB=1 but TEST_DATABASE_URL is not set — the billing_provider_credentials migration test is mandatory in CI.',
  );
}

const suite = DSN ? describe : describe.skip;

let client: any;

const q = async (sql: string, params?: unknown[]) => (await client.query(sql, params)).rows;
const one = async (sql: string, params?: unknown[]) => (await q(sql, params))[0];

/** Minimal pre-existing shape of the two tables the migration reads/writes. */
async function seedPreMigrationSchema() {
  await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
  await client.query(`
    CREATE TABLE IF NOT EXISTS public.app_runtime_config (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS public.billing_gateways (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      provider_name TEXT NOT NULL UNIQUE,
      display_name JSONB NOT NULL DEFAULT '{}'::jsonb,
      is_active BOOLEAN NOT NULL DEFAULT false,
      is_test BOOLEAN NOT NULL DEFAULT false,
      currencies TEXT[] NOT NULL DEFAULT '{}',
      countries TEXT[] NOT NULL DEFAULT '{}',
      sort_order INTEGER NOT NULL DEFAULT 0,
      config JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

function applyMigration() {
  return client.query(
    readFileSync(resolve(process.cwd(), 'database/migrations/137_billing_provider_credentials.sql'), 'utf8'),
  );
}

suite('billing_provider_credentials migration (PostgreSQL)', () => {
  beforeAll(async () => {
    const { Client } = await import('pg');
    client = new Client({ connectionString: DSN });
    await client.connect();
    for (const role of ['anon', 'authenticated', 'service_role']) {
      await client.query(
        `DO $$ BEGIN CREATE ROLE ${role} NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
      );
    }
    await seedPreMigrationSchema();
  }, 60_000);

  afterAll(async () => {
    await client?.end();
  });

  it('backfills every non-empty gateway credential, skips empty ones, and lets Providers win a drift', async () => {
    await client.query(
      `INSERT INTO public.billing_gateways (provider_name, config) VALUES
         ('zarinpal', '{"merchant_id":"stale-gateway-value"}'),
         ('zibal', '{"merchant_id":"only-in-gateways"}'),
         ('nextpay', '{}')`,
    );
    await client.query(
      `INSERT INTO public.app_runtime_config (key, value) VALUES
         ('default_billing_provider', '{"provider_name":"zarinpal","config":{"merchant_id":"newer-providers-value"}}'::jsonb)`,
    );

    await applyMigration();

    const rows = await q(`SELECT provider_name, config FROM public.billing_provider_credentials ORDER BY provider_name`);
    expect(rows).toEqual([
      { provider_name: 'zarinpal', config: { merchant_id: 'newer-providers-value' } }, // Providers wins over the stale gateway value
      { provider_name: 'zibal', config: { merchant_id: 'only-in-gateways' } },
    ]);
    // nextpay's empty config never produced a row.
    const nextpay = await one(`SELECT 1 AS x FROM public.billing_provider_credentials WHERE provider_name='nextpay'`);
    expect(nextpay).toBeUndefined();

    // billing_gateways.config is left untouched (legacy read fallback, no data lost).
    const gatewayRow = await one(`SELECT config FROM public.billing_gateways WHERE provider_name='zarinpal'`);
    expect(gatewayRow.config).toEqual({ merchant_id: 'stale-gateway-value' });
  });

  it('trims the default-provider pointer to name-only — both the modern and legacy key shapes', async () => {
    const modern = await one(`SELECT value FROM public.app_runtime_config WHERE key='default_billing_provider'`);
    expect(modern.value).toEqual({ provider_name: 'zarinpal' });

    await client.query(
      `INSERT INTO public.app_runtime_config (key, value) VALUES
         ('billing_default_provider', '{"provider":"zibal","merchant_id":"legacy-shape-leak"}'::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    );
    await applyMigration();
    const legacy = await one(`SELECT value FROM public.app_runtime_config WHERE key='billing_default_provider'`);
    expect(legacy.value).toEqual({ provider: 'zibal' });
  });

  it('is idempotent — a second apply changes nothing', async () => {
    const before = await q(`SELECT provider_name, config FROM public.billing_provider_credentials ORDER BY provider_name`);
    const result = await applyMigration();
    const after = await q(`SELECT provider_name, config FROM public.billing_provider_credentials ORDER BY provider_name`);
    expect(after).toEqual(before);
    // The final statement in the file is CREATE OR REPLACE FUNCTION — its own
    // "command" carries no row count, but nothing upstream should have
    // touched a row on the replay.
    expect(result).toBeTruthy();
  });

  it('registers the new table in the purge-protection allow-list (127)', async () => {
    const row = await one(`SELECT public.admin_reset_settings_tables() AS tables`);
    expect(row.tables).toContain('billing_provider_credentials');
    expect(row.tables).toContain('billing_gateways'); // the original 127 list survives a CREATE OR REPLACE
  });

  it('is safe to apply before any gateway or default-provider row exists', async () => {
    const { Client } = await import('pg');
    const admin = new Client({ connectionString: DSN });
    await admin.connect();
    const dbName = `billing_cred_fresh_${Date.now()}`;
    await admin.query(`CREATE DATABASE ${dbName}`);
    await admin.end();

    const url = new URL(DSN!);
    url.pathname = `/${dbName}`;
    const fresh = new Client({ connectionString: url.toString() });
    await fresh.connect();
    try {
      const priorClient = client;
      client = fresh;
      await seedPreMigrationSchema();
      // No billing_gateways rows, no app_runtime_config rows at all — the
      // migration must be a pure no-op, not throw.
      await expect(applyMigration()).resolves.toBeTruthy();
      const rows = await q(`SELECT count(*) c FROM public.billing_provider_credentials`);
      expect(Number(rows[0].c)).toBe(0);
      client = priorClient;
    } finally {
      await fresh.end();
      const cleanup = new Client({ connectionString: DSN });
      await cleanup.connect();
      await cleanup.query(`DROP DATABASE IF EXISTS ${dbName}`);
      await cleanup.end();
    }
  });
});
