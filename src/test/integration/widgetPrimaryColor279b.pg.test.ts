// @vitest-environment node
/**
 * 279b — widget_settings.primary_color: NULL is "Brand colour". Against real
 * PostgreSQL built by the chain up to 279:
 *
 *   - before it a new row gets a colour nobody chose (#6D5DFB since 251);
 *   - it moves the seeded #3B82F6 (any case, spaces) and anything the widget
 *     cannot draw ("#12", "red") to NULL, spells "#abc" as "#AABBCC", trims a
 *     six-digit colour, and keeps every real colour (and #6D5DFB) as it is,
 *     other columns and updated_at untouched;
 *   - a new row starts on NULL (the brand colour); the PATCH's own UPDATE
 *     still stores a colour and NULL;
 *   - a dry run (BEGIN … ROLLBACK) leaves no trace; a second run changes
 *     nothing.
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

const DB = `widget_primary_color_279b_${Date.now()}`;
const DIR = resolve(process.cwd(), 'database/migrations');
const FILE = '279b_widget_primary_color_brand.sql';
const SQL = () => readFileSync(resolve(DIR, FILE), 'utf8');

type Row = Record<string, unknown>;

let admin: pg.Client;
let db: pg.Client;
const q = async (sql: string, params: unknown[] = []): Promise<Row[]> => (await db.query(sql, params)).rows as Row[];

async function workspace(color?: string | null): Promise<string> {
  const owner = randomUUID();
  await q(`INSERT INTO public.profiles (id, email) VALUES ($1, $2)`, [owner, `o-${owner.slice(0, 8)}@test.local`]);
  const id = randomUUID();
  await q(`INSERT INTO public.workspaces (id, name, slug, owner_id) VALUES ($1, 'Acme', $2, $3)`, [id, `ws-${id.slice(0, 8)}`, owner]);
  if (color === undefined) {
    await q(`INSERT INTO public.widget_settings (workspace_id, enabled) VALUES ($1, true)`, [id]);
  } else {
    await q(`INSERT INTO public.widget_settings (workspace_id, enabled, primary_color) VALUES ($1, true, $2)`, [id, color]);
  }
  return id;
}

const colorOf = async (ws: string): Promise<unknown> =>
  (await q(`SELECT primary_color FROM public.widget_settings WHERE workspace_id = $1`, [ws]))[0].primary_color;

const columnDefault = async (): Promise<unknown> =>
  (await q(`SELECT column_default FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'widget_settings' AND column_name = 'primary_color'`))[0]?.column_default;

const STORED: Array<[string | null, string | null]> = [
  ['#3B82F6', null],
  ['#3b82f6', null],
  ['  #3B82F6 ', null],
  ['#12', null],
  ['red', null],
  ['', null],
  ['#abc', '#AABBCC'],
  [' #0EA5E9  ', '#0EA5E9'],
  ['#10b981', '#10b981'],
  ['#6D5DFB', '#6D5DFB'],
  [null, null],
];
const rows: Array<{ ws: string; want: string | null }> = [];
let wsDefault: string;

suite('279b — widget primary colour: NULL is the brand colour (real PostgreSQL, whole chain)', () => {
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
    wsDefault = await workspace();
    for (const [stored, want] of STORED) rows.push({ ws: await workspace(stored), want });
  }, 600_000);

  afterAll(async () => {
    await db?.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
      await admin.end();
    }
  });

  it('before 279b: a new row gets a colour nobody chose', async () => {
    expect(await colorOf(wsDefault)).toBe('#6D5DFB');
    expect(await columnDefault()).toBe(`'#6D5DFB'::text`);
  });

  it('a dry run (BEGIN … ROLLBACK) leaves nothing behind', async () => {
    const before = await q(`SELECT workspace_id, primary_color, updated_at FROM public.widget_settings ORDER BY workspace_id`);
    await db.query('BEGIN');
    try {
      await db.query(SQL());
      expect(await columnDefault()).toBeNull();
    } finally {
      await db.query('ROLLBACK');
    }
    expect(await columnDefault()).toBe(`'#6D5DFB'::text`);
    expect(await q(`SELECT workspace_id, primary_color, updated_at FROM public.widget_settings ORDER BY workspace_id`)).toEqual(before);
  });

  it('applies: the seed and what is no colour become NULL, real colours stay, nothing else changes', async () => {
    const before = await q(`SELECT * FROM public.widget_settings ORDER BY workspace_id`);
    await applyMigrationSql(db, SQL());
    for (const { ws, want } of rows) expect(await colorOf(ws), ws).toBe(want);
    // The row created on 251's default keeps the colour it has shown.
    expect(await colorOf(wsDefault)).toBe('#6D5DFB');
    const after = await q(`SELECT * FROM public.widget_settings ORDER BY workspace_id`);
    expect(after.map(({ primary_color: _c, ...rest }) => rest)).toEqual(before.map(({ primary_color: _c, ...rest }) => rest));
  });

  it('a new row starts on the brand colour (NULL); a colour and NULL are still stored', async () => {
    expect(await columnDefault()).toBeNull();
    const fresh = await workspace();
    expect(await colorOf(fresh)).toBeNull();
    await q(`UPDATE public.widget_settings SET primary_color = '#EF4444' WHERE workspace_id = $1`, [fresh]);
    expect(await colorOf(fresh)).toBe('#EF4444');
    await q(`UPDATE public.widget_settings SET primary_color = NULL WHERE workspace_id = $1`, [fresh]);
    expect(await colorOf(fresh)).toBeNull();
  });

  it('re-runnable: a second run changes nothing', async () => {
    const before = await q(`SELECT workspace_id, primary_color, updated_at FROM public.widget_settings ORDER BY workspace_id`);
    await applyMigrationSql(db, SQL());
    expect(await q(`SELECT workspace_id, primary_color, updated_at FROM public.widget_settings ORDER BY workspace_id`)).toEqual(before);
    expect(await columnDefault()).toBeNull();
  });
});
