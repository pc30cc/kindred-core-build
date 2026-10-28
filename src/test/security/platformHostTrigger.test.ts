// @vitest-environment node
/**
 * The website trigger against the platform-host guard, in real PostgreSQL.
 *
 * The SQL that turns a profile's website into a verified domain is taken
 * as-is from migration 239 (normalize_domain, register_workspace_domain,
 * workspaces_auto_register_owner_domain, the normalize trigger, the generated
 * normalized_domain and its unique index) and run in PGlite over a minimal
 * stand-in of the tables it touches. Two things are proven:
 *
 *  - a customer's website is verified for the account's first workspace
 *    exactly as before, and a platform host stored in a profile is dropped
 *    by the server (dropPlatformWebsite) before the workspace INSERT, so the
 *    trigger never verifies it;
 *  - the guard's reading of a value (hostCandidates) covers SQL's: every
 *    spelling SQL reduces to a platform host is one the guard refuses.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- the Supabase test double is intentionally untyped. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

const pg = vi.hoisted(() => ({ db: null as unknown as import('@electric-sql/pglite').PGlite }));

// A supabase-js double over PGlite: the few calls platformHosts.ts makes.
vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    from(table: string) {
      const where: string[] = [];
      const params: unknown[] = [];
      let cols = '*';
      let patch: Record<string, unknown> | null = null;
      const run = async () => {
        try {
          if (patch) {
            const keys = Object.keys(patch);
            const set = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
            const shifted = where.map((w) => w.replace(/\$(\d+)/g, (_, n) => `$${Number(n) + keys.length}`));
            const sql = `UPDATE public.${table} SET ${set}${shifted.length ? ` WHERE ${shifted.join(' AND ')}` : ''}`;
            await pg.db.query(sql, [...Object.values(patch), ...params]);
            return { data: null, error: null };
          }
          const sql = `SELECT ${cols} FROM public.${table}${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`;
          return { data: (await pg.db.query(sql, params)).rows, error: null };
        } catch (e: any) {
          return { data: null, error: { message: e.message } };
        }
      };
      const builder: any = {
        select: (c?: string) => { cols = c || '*'; return builder; },
        eq: (col: string, val: unknown) => { params.push(val); where.push(`${col} = $${params.length}`); return builder; },
        in: (col: string, vals: unknown[]) => { params.push(vals); where.push(`${col} = ANY($${params.length})`); return builder; },
        limit: () => builder,
        update: (p: Record<string, unknown>) => { patch = p; return builder; },
        maybeSingle: async () => {
          const r = await run();
          return { data: (r.data as any[] | null)?.[0] ?? null, error: r.error };
        },
        then: (resolve: any, reject?: any) => run().then(resolve, reject),
      };
      return builder;
    },
  }),
}));

const { __resetPlatformHostsCache, dropPlatformWebsite, hostCandidates, isPlatformHostIn } =
  await import('../../../server/services/platformHosts.js');

const MIGRATION = readFileSync('database/migrations/239_selfhost_hosted_parity.sql', 'utf8');

/** `-- FUNCTION: name(` … the closing `$$;`, exactly as the migration has it. */
function fn(name: string): string {
  const start = MIGRATION.indexOf(`-- FUNCTION: ${name}(`);
  const end = MIGRATION.indexOf('\n$$;', start);
  if (start < 0 || end < 0) throw new Error(`migration 239 has no ${name}`);
  return MIGRATION.slice(start, end + 4);
}
/** The one statement of the migration that starts with `prefix`. */
function statement(prefix: string): string {
  const start = MIGRATION.indexOf(prefix);
  if (start < 0) throw new Error(`migration 239 has no "${prefix}"`);
  return MIGRATION.slice(start, MIGRATION.indexOf(';\n', start) + 1);
}

const GENERATED = statement('ALTER TABLE public.workspace_domains ADD COLUMN IF NOT EXISTS normalized_domain');
const NORMALIZED_EXPR = /GENERATED ALWAYS AS \((.*)\) STORED;$/.exec(GENERATED)![1];

const config = { corsOrigins: ['*'] } as any;
const PLATFORM = { apex: 'webyar.ai', hosts: new Set(['webyar.ai', 'app.webyar.ai', 'api.webyar.ai']) };

beforeAll(async () => {
  pg.db = new PGlite();
  await pg.db.exec(`
    CREATE TABLE public.profiles (id uuid PRIMARY KEY, website_domain text, updated_at timestamptz);
    CREATE TABLE public.accounts (id uuid PRIMARY KEY, owner_id uuid);
    CREATE TABLE public.workspaces (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid);
    CREATE TABLE public.workspace_domains (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL, domain text NOT NULL,
      verified boolean DEFAULT false, is_primary boolean DEFAULT false, created_at timestamptz DEFAULT now());
    CREATE TABLE public.widget_settings (
      workspace_id uuid PRIMARY KEY, allowed_domains text[], allow_subdomains boolean DEFAULT false, updated_at timestamptz);
    CREATE TABLE public.platform_domains (
      primary_domain text, canonical_base_url text, public_base_url text, app_base_url text,
      api_base_url text, help_center_base_url text, email_base_url text);
    CREATE TABLE public.widget_platform_settings (
      widget_loader_base_url text, widget_asset_base_url text, widget_public_base_url text, widget_api_base_url text);
    INSERT INTO public.platform_domains VALUES
      ('webyar.ai', 'https://webyar.ai', 'https://webyar.ai', 'https://app.webyar.ai', 'https://api.webyar.ai', NULL, NULL);
  `);
  for (const name of ['normalize_domain', 'workspace_domains_normalize', 'register_workspace_domain', 'workspaces_auto_register_owner_domain']) {
    await pg.db.exec(fn(name));
  }
  await pg.db.exec(GENERATED);
  await pg.db.exec(statement('CREATE UNIQUE INDEX IF NOT EXISTS workspace_domains_verified_domain_uniq'));
  await pg.db.exec(statement('CREATE OR REPLACE TRIGGER trg_workspace_domains_normalize'));
  await pg.db.exec(statement('CREATE OR REPLACE TRIGGER trg_workspaces_auto_register_owner_domain'));
}, 60_000);

afterAll(async () => { await pg.db?.close(); });
beforeEach(() => { __resetPlatformHostsCache(); });

/** Signup's profile, then what POST /api/workspaces does: the guard, then the INSERT. */
async function provision(website: string) {
  const owner = randomUUID();
  const account = randomUUID();
  await pg.db.query('INSERT INTO public.profiles (id, website_domain) VALUES ($1, $2)', [owner, website]);
  await pg.db.query('INSERT INTO public.accounts (id, owner_id) VALUES ($1, $2)', [account, owner]);
  await dropPlatformWebsite(config, owner);
  const ws = (await pg.db.query<{ id: string }>('INSERT INTO public.workspaces (account_id) VALUES ($1) RETURNING id', [account])).rows[0].id;
  const domains = (await pg.db.query<any>(
    'SELECT domain, normalized_domain, verified, is_primary FROM public.workspace_domains WHERE workspace_id = $1', [ws],
  )).rows;
  const widget = (await pg.db.query<any>('SELECT allowed_domains, allow_subdomains FROM public.widget_settings WHERE workspace_id = $1', [ws])).rows[0];
  const profile = (await pg.db.query<any>('SELECT website_domain FROM public.profiles WHERE id = $1', [owner])).rows[0];
  return { domains, widget, profile };
}

describe('the website trigger, with the server guard in front of it', () => {
  it.each([
    ['shop.example', 'shop.example'],
    ['https://www.ninisite.com/', 'ninisite.com'],
    ['Asdadas.com', 'asdadas.com'],
  ])('verifies the customer website %j for the first workspace, as today', async (website, host) => {
    const { domains, widget, profile } = await provision(website);
    expect(domains).toEqual([{ domain: host, normalized_domain: host, verified: true, is_primary: true }]);
    expect(widget).toEqual({ allowed_domains: [host], allow_subdomains: true });
    expect(profile.website_domain).toBe(website);
  });

  it.each([
    'api.webyar.ai',
    'https://API.WebYar.ai:443/x',
    'app.webyar.ai',
    'www.www.api.webyar.ai?x',
    'foo.webyar.ai',
    // U+0130: Postgres lower() makes it a plain i, so SQL stores app.webyar.ai.
    'app.webyar.a\u0130',
    'https://LIVEKIT.WEBYAR.A\u0130/x',
  ])('drops the platform host %j first: no domain, the profile cleared', async (website) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { domains, widget, profile } = await provision(website);
    warn.mockRestore();
    expect(domains).toEqual([]);
    expect(widget).toBeUndefined();
    expect(profile.website_domain).toBeNull();
  });

  it('without the guard the same value IS verified: what the finding describes', async () => {
    const owner = randomUUID();
    const account = randomUUID();
    await pg.db.query('INSERT INTO public.profiles (id, website_domain) VALUES ($1, $2)', [owner, 'HTTPS://api.webyar.ai:8443/x']);
    await pg.db.query('INSERT INTO public.accounts (id, owner_id) VALUES ($1, $2)', [account, owner]);
    await pg.db.query('INSERT INTO public.workspaces (account_id) VALUES ($1)', [account]);
    const rows = (await pg.db.query<any>(
      "SELECT normalized_domain, verified FROM public.workspace_domains WHERE normalized_domain = 'api.webyar.ai'",
    )).rows;
    expect(rows).toEqual([{ normalized_domain: 'api.webyar.ai', verified: true }]);
    await pg.db.query("DELETE FROM public.workspace_domains WHERE normalized_domain = 'api.webyar.ai'");
  });
});

describe('the guard reads a value at least as widely as SQL does', () => {
  const HOSTS = ['api.webyar.ai', 'API.WEBYAR.AI', 'app.webyar.ai', 'webyar.ai', 'x.api.webyar.ai'];
  const BEFORE = ['', ' ', '  ', 'https://', 'HTTP://', 'http://', '//', 'https://https://', 'x@', 'x:y@', 'www.', 'WWW.', 'www.www.', 'https://www.', '\t'];
  const AFTER = ['', '.', '/', '/x', ':443', ':x', ':99999', '?x', '#x', ' ', ' /x', ' :1', '\\x', ':1@shop.example', '@shop.example', '/?#', '\n'];

  /** SQL's own reading, as the trigger path applies it: normalize twice, then the generated column. */
  async function sqlReading(values: string[]): Promise<Map<string, string | null>> {
    const { rows } = await pg.db.query<{ x: string; n: string | null }>(
      `SELECT x, ${NORMALIZED_EXPR} AS n
         FROM (SELECT x, public.normalize_domain(public.normalize_domain(x)) AS domain FROM unnest($1::text[]) AS x) s`,
      [values],
    );
    return new Map(rows.map((r) => [r.x, r.n]));
  }
  /**
   * Does SQL's reading claim a platform host? Only a value some request can
   * carry counts: the resolver's key is a URL hostname (`\x.api.webyar.ai`
   * stays stored with its backslash and never matches anything). A trailing
   * dot does match a Host that carries one, so it counts.
   */
  const sqlLandsOnPlatform = (n: string | null) => {
    if (!n) return false;
    try {
      if (new URL(`http://${n}`).hostname !== n) return false;
    } catch {
      return false;
    }
    const host = n.replace(/\.+$/, '');
    return PLATFORM.hosts.has(host) || host === PLATFORM.apex || host.endsWith(`.${PLATFORM.apex}`);
  };

  it('every combination SQL turns into a platform host is refused', async () => {
    const values = HOSTS.flatMap((h) => BEFORE.flatMap((b) => AFTER.map((a) => `${b}${h}${a}`)));
    const reading = await sqlReading(values);
    const missed = values.filter((v) => sqlLandsOnPlatform(reading.get(v) ?? null) && !isPlatformHostIn(PLATFORM, v));
    expect(missed).toEqual([]);
    // The combinations do reach the platform host in SQL (the test tests something).
    expect(values.filter((v) => sqlLandsOnPlatform(reading.get(v) ?? null)).length).toBeGreaterThan(500);
  });

  /**
   * Letters and dots outside ASCII, and their look-alikes: PGlite folds case
   * the way production's libc does (U+0130 İ to a plain i, the Kelvin sign
   * to k), so a letter that JavaScript folds differently shows up here.
   */
  const TWINS: Record<string, string[]> = {
    i: ['\u0130', 'I', '\u0131', '\u0069\u0307', '\uff49'],
    a: ['A', '\uff41', '\u0430'],
    k: ['\u212a', 'K'],
    s: ['\u017f', 'S'],
    '.': ['\u3002', '\uff0e', '\uff61', '..'],
  };
  const NON_ASCII = ['\u0130', '\u212a', '\u3002', '\uff0e', '\uff61', '\uff41', '\u00a0', '\u200b', '\ufeff', '\u00ad', '\u0307', '\u0131', '\u017f'];

  it('and so does every single-letter look-alike of it, non-ASCII included', async () => {
    const values = HOSTS.flatMap((h) => Array.from(h).flatMap((ch, at) =>
      (TWINS[ch.toLowerCase()] || []).map((twin) => h.slice(0, at) + twin + h.slice(at + 1))));
    const reading = await sqlReading(values);
    const missed = values.filter((v) => sqlLandsOnPlatform(reading.get(v) ?? null) && !isPlatformHostIn(PLATFORM, v));
    expect(missed).toEqual([]);
    // SQL does turn some of them into a platform host (the dotted I does).
    expect(values.filter((v) => sqlLandsOnPlatform(reading.get(v) ?? null))).toContain('app.webyar.a\u0130');
  });

  it('and so does every random mangling of it (seeded)', async () => {
    let seed = 0x5eed;
    const rand = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    const bits = [' ', '\t', '/', ':', '?', '#', '@', '.', 'www.', 'https://', 'HTTP://', '\\', '%', 'A', '1', 'x', '//', ':8443', 'u:p@', ...NON_ASCII];
    const values: string[] = [];
    for (let i = 0; i < 4000; i += 1) {
      let v = HOSTS[rand(HOSTS.length)];
      for (let k = rand(4); k >= 0; k -= 1) {
        const at = rand(v.length + 1);
        // Insert a bit, or put a look-alike in place of a letter.
        const twins = TWINS[v.charAt(at).toLowerCase()];
        v = twins && rand(2)
          ? v.slice(0, at) + twins[rand(twins.length)] + v.slice(at + 1)
          : v.slice(0, at) + bits[rand(bits.length)] + v.slice(at);
      }
      values.push(v);
    }
    const reading = await sqlReading(values);
    const missed = values.filter((v) => sqlLandsOnPlatform(reading.get(v) ?? null) && !isPlatformHostIn(PLATFORM, v));
    expect(missed).toEqual([]);
  });

  it('while customer domains stay customer domains on both readings', async () => {
    const values = ['shop.example', 'https://www.ninisite.com/', 'webyar.ai.shop.example', 'notwebyar.ai', 'api-webyar-ai.com'];
    const reading = await sqlReading(values);
    for (const v of values) {
      expect(sqlLandsOnPlatform(reading.get(v) ?? null)).toBe(false);
      expect(isPlatformHostIn(PLATFORM, v)).toBe(false);
      expect(hostCandidates(v).length).toBeGreaterThan(0);
    }
  });
});
