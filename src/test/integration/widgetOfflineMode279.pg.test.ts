// @vitest-environment node
/**
 * 279 — widget_settings.offline_mode accepts what the panel writes. Against
 * real PostgreSQL built by the chain up to 278:
 *
 *   - before 279 the Availability tab's "Hide widget" / "Show offline message
 *     only" / "Capture a message" are refused by the trigger (the save the
 *     panel issues failed), and the default is the old 'accept_messages';
 *   - after it the three are stored, an unknown value is still refused, an
 *     old value written by anything is stored as 'capture_message';
 *   - rows on an old value are rewritten to 'capture_message' (what the
 *     server served them), other columns and updated_at untouched;
 *   - a new row starts on 'capture_message';
 *   - a dry run (BEGIN … ROLLBACK) leaves no trace; a second run changes
 *     nothing; grants on the function are what they were.
 *
 * Its own database (CREATE DATABASE on the TEST_DATABASE_URL server).
 * Skipped without TEST_DATABASE_URL.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { applyMigrationSql } from './pgMigrationChain';

const DSN = process.env.TEST_DATABASE_URL;
const suite = DSN ? describe : describe.skip;

const DB = `widget_offline_mode_279_${Date.now()}`;
const DIR = resolve(process.cwd(), 'database/migrations');
const FILE = '279_widget_offline_mode_values.sql';
const SQL = () => readFileSync(resolve(DIR, FILE), 'utf8');

type Row = Record<string, unknown>;

let admin: pg.Client;
let db: pg.Client;
const q = async (sql: string, params: unknown[] = []): Promise<Row[]> => (await db.query(sql, params)).rows as Row[];

const FN_GRANTS = `SELECT grantee, privilege_type FROM information_schema.routine_privileges
                    WHERE routine_schema = 'public' AND routine_name = 'widget_settings_validate_offline_mode'
                    ORDER BY grantee, privilege_type`;
let grantsBefore: Row[] = [];

async function workspace(offlineMode?: string): Promise<string> {
  const owner = randomUUID();
  await q(`INSERT INTO public.profiles (id, email) VALUES ($1, $2)`, [owner, `o-${owner.slice(0, 8)}@test.local`]);
  const id = randomUUID();
  await q(`INSERT INTO public.workspaces (id, name, slug, owner_id) VALUES ($1, 'Acme', $2, $3)`, [id, `ws-${id.slice(0, 8)}`, owner]);
  if (offlineMode === undefined) {
    await q(`INSERT INTO public.widget_settings (workspace_id, enabled) VALUES ($1, true)`, [id]);
  } else {
    await q(`INSERT INTO public.widget_settings (workspace_id, enabled, offline_mode) VALUES ($1, true, $2)`, [id, offlineMode]);
  }
  return id;
}

/** The PATCH's own statement for one value, in a savepoint; the stored value, or the error code. */
async function save(ws: string, value: string): Promise<{ stored?: unknown; code?: string }> {
  await db.query('BEGIN');
  try {
    const rows = await q(`UPDATE public.widget_settings SET offline_mode = $2 WHERE workspace_id = $1 RETURNING offline_mode`, [ws, value]);
    return { stored: rows[0]?.offline_mode };
  } catch (e) {
    return { code: (e as { code?: string }).code };
  } finally {
    await db.query('ROLLBACK');
  }
}

const columnDefault = async (): Promise<unknown> =>
  (await q(`SELECT column_default FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'widget_settings' AND column_name = 'offline_mode'`))[0]?.column_default;

const triggerCount = async (): Promise<number> =>
  Number((await q(`SELECT count(*) AS n FROM pg_trigger
                    WHERE tgrelid = 'public.widget_settings'::regclass
                      AND tgname = 'widget_settings_validate_offline_mode' AND NOT tgisinternal`))[0].n);

let wsDefault: string;
let wsContact: string;
let wsHide: string;

suite('279 — widget offline mode values (real PostgreSQL, whole chain)', () => {
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
    // Production-shaped rows: the column default, and the other old value.
    wsDefault = await workspace();
    wsContact = await workspace('contact_fallback');
    grantsBefore = await q(FN_GRANTS);
  }, 600_000);

  afterAll(async () => {
    await db?.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
      await admin.end();
    }
  });

  it('before 279: every value the panel writes is refused; the default is the old one', async () => {
    expect((await q(`SELECT offline_mode FROM public.widget_settings WHERE workspace_id = $1`, [wsDefault]))[0].offline_mode)
      .toBe('accept_messages');
    for (const value of ['hide_widget', 'show_offline_message', 'capture_message']) {
      expect((await save(wsDefault, value)).code, value).toBe('P0001');
    }
  });

  it('a dry run (BEGIN … ROLLBACK) leaves nothing behind', async () => {
    const before = await q(`SELECT workspace_id, offline_mode, updated_at FROM public.widget_settings ORDER BY workspace_id`);
    const defaultBefore = await columnDefault();
    await db.query('BEGIN');
    try {
      await db.query(SQL());
      expect(await columnDefault()).toBe(`'capture_message'::text`);
    } finally {
      await db.query('ROLLBACK');
    }
    expect(await columnDefault()).toBe(defaultBefore);
    expect(await q(`SELECT workspace_id, offline_mode, updated_at FROM public.widget_settings ORDER BY workspace_id`)).toEqual(before);
    expect((await save(wsDefault, 'hide_widget')).code).toBe('P0001');
  });

  it('applies: old values become capture_message, other columns and updated_at untouched', async () => {
    const before = await q(`SELECT * FROM public.widget_settings ORDER BY workspace_id`);
    await applyMigrationSql(db, SQL());
    const after = await q(`SELECT * FROM public.widget_settings ORDER BY workspace_id`);
    expect(after.map((r) => r.offline_mode)).toEqual(['capture_message', 'capture_message']);
    expect(after.map(({ offline_mode: _m, ...rest }) => rest)).toEqual(before.map(({ offline_mode: _m, ...rest }) => rest));
    expect(await triggerCount()).toBe(1);
  });

  it('after 279: the three values are stored, an unknown one is refused, an old one is stored as the form', async () => {
    for (const value of ['hide_widget', 'show_offline_message', 'capture_message']) {
      expect(await save(wsDefault, value), value).toEqual({ stored: value });
    }
    for (const value of ['accept_messages', 'contact_fallback']) {
      expect(await save(wsDefault, value), value).toEqual({ stored: 'capture_message' });
    }
    for (const value of ['offline', 'HIDE_WIDGET', '']) {
      expect((await save(wsDefault, value)).code, value).toBe('23514');
    }
    expect((await save(wsDefault, null as unknown as string)).code).toBe('23502');
  });

  it('a new row starts on capture_message; an INSERT with a value keeps it', async () => {
    const fresh = await workspace();
    expect((await q(`SELECT offline_mode FROM public.widget_settings WHERE workspace_id = $1`, [fresh]))[0].offline_mode).toBe('capture_message');
    wsHide = await workspace('hide_widget');
    expect((await q(`SELECT offline_mode FROM public.widget_settings WHERE workspace_id = $1`, [wsHide]))[0].offline_mode).toBe('hide_widget');
  });

  it('re-runnable: a second run keeps every value, the default and the single trigger', async () => {
    await q(`UPDATE public.widget_settings SET offline_mode = 'show_offline_message' WHERE workspace_id = $1`, [wsContact]);
    const before = await q(`SELECT workspace_id, offline_mode, updated_at FROM public.widget_settings ORDER BY workspace_id`);
    await applyMigrationSql(db, SQL());
    expect(await q(`SELECT workspace_id, offline_mode, updated_at FROM public.widget_settings ORDER BY workspace_id`)).toEqual(before);
    expect(await columnDefault()).toBe(`'capture_message'::text`);
    expect(await triggerCount()).toBe(1);
  });

  it('grants on the trigger function are exactly what they were', async () => {
    expect(await q(FN_GRANTS)).toEqual(grantsBefore);
  });
});
