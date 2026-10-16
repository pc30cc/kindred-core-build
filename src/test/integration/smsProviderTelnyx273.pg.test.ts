// @vitest-environment node
/**
 * 273 — 'telnyx' joins platform_sms_provider_config.provider_name. Against
 * real PostgreSQL built by the chain up to 272:
 *
 *   - before 273 a Telnyx row is refused; after it, accepted, while an
 *     unknown vendor is still refused;
 *   - existing rows (a Kavenegar config) are untouched;
 *   - a second run changes nothing; a dry run (BEGIN … ROLLBACK) leaves no
 *     trace; grants and row security on the table are exactly what they were.
 *
 * Its own database (CREATE DATABASE on the TEST_DATABASE_URL server).
 * Skipped without TEST_DATABASE_URL; REQUIRE_BILLING_DB=1 makes that a failure.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { applyMigrationSql } from './pgMigrationChain';

const DSN = process.env.TEST_DATABASE_URL;
if (process.env.REQUIRE_BILLING_DB === '1' && !DSN) {
  throw new Error('REQUIRE_BILLING_DB=1 but TEST_DATABASE_URL is not set — the 273 tests are mandatory.');
}
const suite = DSN ? describe : describe.skip;

const DB = `sms_provider_telnyx_273_${Date.now()}`;
const DIR = resolve(process.cwd(), 'database/migrations');
const FILE = '273_sms_provider_telnyx.sql';
const SQL = () => readFileSync(resolve(DIR, FILE), 'utf8');
const PROFILE = '490001a1-442d-809f-5753-c2332bd10640';

type Row = Record<string, unknown>;

let admin: pg.Client;
let db: pg.Client;
let grantsBefore: Row[] = [];
const GRANTS = `SELECT grantee, privilege_type FROM information_schema.role_table_grants
                 WHERE table_schema = 'public' AND table_name = 'platform_sms_provider_config'
                 ORDER BY grantee, privilege_type`;
const q = async (sql: string, params: unknown[] = []): Promise<Row[]> => (await db.query(sql, params)).rows as Row[];

const constraintDef = async (): Promise<string> =>
  String(
    (await q(`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint
               WHERE conrelid = 'public.platform_sms_provider_config'::regclass
                 AND conname = 'platform_sms_provider_config_name_chk'`))[0]?.d ?? '',
  );

/** Tries a provider_name inside a savepoint; true when the CHECK accepts it. */
async function accepts(name: string): Promise<boolean> {
  await db.query('BEGIN');
  try {
    await db.query(`UPDATE public.platform_sms_provider_config SET provider_name = $1 WHERE singleton`, [name]);
    return true;
  } catch (e) {
    expect((e as { code?: string }).code).toBe('23514'); // check_violation
    return false;
  } finally {
    await db.query('ROLLBACK');
  }
}

suite('273 — platform SMS provider: Telnyx (real PostgreSQL, whole chain)', () => {
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
    for (const file of readdirSync(DIR).filter((f) => f.endsWith('.sql') && f < FILE).sort()) {
      await applyMigrationSql(db, readFileSync(resolve(DIR, file), 'utf8'));
    }
    // Production-shaped row: the Iranian edition's live Kavenegar config.
    await q(`INSERT INTO public.platform_sms_provider_config (singleton, provider_name, config, is_active)
             VALUES (true, 'kavenegar', $1, true)
             ON CONFLICT (singleton) DO UPDATE SET provider_name = EXCLUDED.provider_name, config = EXCLUDED.config, is_active = EXCLUDED.is_active`,
    [JSON.stringify({ apiKey: 'placeholder', verifyTemplate: 'verifyLogin' })]);
    grantsBefore = await q(GRANTS);
  }, 600_000);

  afterAll(async () => {
    await db?.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
      await admin.end();
    }
  });

  it('before 273: Telnyx is refused', async () => {
    expect(await accepts('telnyx')).toBe(false);
    expect(await accepts('smsir')).toBe(true);
  });

  it('a dry run (BEGIN … ROLLBACK) leaves nothing behind', async () => {
    const before = await constraintDef();
    const rows = await q(`SELECT * FROM public.platform_sms_provider_config`);
    await db.query('BEGIN');
    try {
      await db.query(SQL());
      expect(await constraintDef()).toContain('telnyx');
    } finally {
      await db.query('ROLLBACK');
    }
    expect(await constraintDef()).toBe(before);
    expect(await q(`SELECT * FROM public.platform_sms_provider_config`)).toEqual(rows);
  });

  it('applies: Telnyx is accepted, every old name still is, an unknown vendor is not; rows untouched', async () => {
    const rows = await q(`SELECT * FROM public.platform_sms_provider_config`);
    await applyMigrationSql(db, SQL());
    for (const name of ['kavenegar', 'smsir', 'telnyx', 'disabled']) expect(await accepts(name), name).toBe(true);
    for (const name of ['twilio', 'TELNYX', '']) expect(await accepts(name), name).toBe(false);
    expect(await q(`SELECT * FROM public.platform_sms_provider_config`)).toEqual(rows);

    await q(`UPDATE public.platform_sms_provider_config
                SET provider_name = 'telnyx', config = $1, is_active = true WHERE singleton`,
    [JSON.stringify({ apiKey: 'placeholder', verifyProfileId: PROFILE, channel: 'sms' })]);
    const [saved] = await q(`SELECT provider_name, config FROM public.platform_sms_provider_config`);
    expect(saved).toEqual({ provider_name: 'telnyx', config: { apiKey: 'placeholder', verifyProfileId: PROFILE, channel: 'sms' } });
  });

  it('re-runnable: a second run keeps the same constraint and the Telnyx row', async () => {
    const before = await constraintDef();
    await applyMigrationSql(db, SQL());
    expect(await constraintDef()).toBe(before);
    expect((await q(`SELECT provider_name FROM public.platform_sms_provider_config`))[0].provider_name).toBe('telnyx');
  });

  it('grants and row security are exactly what they were before 273', async () => {
    expect(await q(GRANTS)).toEqual(grantsBefore);
    const [rls] = await q(`SELECT relrowsecurity FROM pg_class WHERE oid = 'public.platform_sms_provider_config'::regclass`);
    expect(rls.relrowsecurity).toBe(true);
  });
});
