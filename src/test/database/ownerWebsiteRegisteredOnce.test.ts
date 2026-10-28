// @vitest-environment node
/**
 * Migration 288 in real PostgreSQL (PGlite): the owner's website is
 * registered once, on the account's first workspace (owner, 2026-10-28).
 *
 * The SQL is migration 239's as-is (normalize_domain, the row normalize
 * trigger, register_workspace_domain, the workspace INSERT trigger, the
 * generated normalized_domain and its unique index) over a minimal stand-in
 * of the tables it touches, then 288's file as-is on top. Proven: under 239
 * an account's second workspace fails on the unique index; under 288 it is
 * created without claiming the website again, while another account's claim
 * on the same website is still refused by the index.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

const M239 = readFileSync('database/migrations/239_selfhost_hosted_parity.sql', 'utf8');
const M288 = readFileSync('database/migrations/288_owner_website_registered_once.sql', 'utf8');

/** `-- FUNCTION: name(` … the closing `$$;`, exactly as 239 has it. */
function fn(name: string): string {
  const start = M239.indexOf(`-- FUNCTION: ${name}(`);
  const end = M239.indexOf('\n$$;', start);
  if (start < 0 || end < 0) throw new Error(`migration 239 has no ${name}`);
  return M239.slice(start, end + 4);
}
/** The one statement of 239 that starts with `prefix`. */
function statement(prefix: string): string {
  const start = M239.indexOf(prefix);
  if (start < 0) throw new Error(`migration 239 has no "${prefix}"`);
  return M239.slice(start, M239.indexOf(';\n', start) + 1);
}

let db: PGlite;

async function owner(website: string | null): Promise<string> {
  const userId = randomUUID();
  const accountId = randomUUID();
  await db.query('INSERT INTO public.profiles (id, website_domain) VALUES ($1, $2)', [userId, website]);
  await db.query('INSERT INTO public.accounts (id, owner_id) VALUES ($1, $2)', [accountId, userId]);
  return accountId;
}
async function workspace(accountId: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>('INSERT INTO public.workspaces (account_id) VALUES ($1) RETURNING id', [accountId]);
  return rows[0].id;
}
async function domainsOf(workspaceId: string) {
  const { rows } = await db.query<{ domain: string; verified: boolean; is_primary: boolean }>(
    'SELECT domain, verified, is_primary FROM public.workspace_domains WHERE workspace_id = $1', [workspaceId]);
  return rows;
}
async function allowListOf(workspaceId: string) {
  const { rows } = await db.query<{ allowed_domains: string[] }>(
    'SELECT allowed_domains FROM public.widget_settings WHERE workspace_id = $1', [workspaceId]);
  return rows[0]?.allowed_domains ?? null;
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE public.profiles (id uuid PRIMARY KEY, website_domain text, updated_at timestamptz);
    CREATE TABLE public.accounts (id uuid PRIMARY KEY, owner_id uuid);
    CREATE TABLE public.workspaces (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid);
    CREATE TABLE public.workspace_domains (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL, domain text NOT NULL,
      verified boolean DEFAULT false, is_primary boolean DEFAULT false, created_at timestamptz DEFAULT now());
    CREATE TABLE public.widget_settings (
      workspace_id uuid PRIMARY KEY, allowed_domains text[], allow_subdomains boolean DEFAULT false, updated_at timestamptz);
  `);
  for (const name of ['normalize_domain', 'workspace_domains_normalize', 'register_workspace_domain', 'workspaces_auto_register_owner_domain']) {
    await db.exec(fn(name));
  }
  await db.exec(statement('ALTER TABLE public.workspace_domains ADD COLUMN IF NOT EXISTS normalized_domain'));
  await db.exec(statement('CREATE UNIQUE INDEX IF NOT EXISTS workspace_domains_verified_domain_uniq'));
  await db.exec(statement('CREATE OR REPLACE TRIGGER trg_workspace_domains_normalize'));
  await db.exec(statement('CREATE OR REPLACE TRIGGER trg_workspaces_auto_register_owner_domain'));
}, 60_000);

afterAll(async () => { await db?.close(); });

describe('before 288 (239 as shipped)', () => {
  it('an account\'s second workspace fails on the unique index', async () => {
    const account = await owner('shop-239.example');
    await workspace(account);
    await expect(workspace(account)).rejects.toThrow(/workspace_domains_verified_domain_uniq/);
  });
});

describe('288', () => {
  beforeAll(async () => {
    await db.exec(M288);
  });

  it('verifies the website as the primary domain of the account\'s first workspace, as before', async () => {
    const first = await workspace(await owner('shop.example'));
    expect(await domainsOf(first)).toEqual([{ domain: 'shop.example', verified: true, is_primary: true }]);
    expect(await allowListOf(first)).toEqual(['shop.example']);
  });

  it('creates the account\'s later workspaces without claiming the website again', async () => {
    const account = await owner('second.example');
    const first = await workspace(account);
    const second = await workspace(account);
    const third = await workspace(account);
    expect(await domainsOf(first)).toEqual([{ domain: 'second.example', verified: true, is_primary: true }]);
    expect(await domainsOf(second)).toEqual([]);
    expect(await domainsOf(third)).toEqual([]);
    expect(await allowListOf(second)).toBeNull();
  });

  it('reads the website as the row stores it (scheme, case, www., path)', async () => {
    const account = await owner('https://WWW.Spelled.example/fa');
    const first = await workspace(account);
    expect(await domainsOf(first)).toEqual([{ domain: 'spelled.example', verified: true, is_primary: true }]);
    expect(await domainsOf(await workspace(account))).toEqual([]);
  });

  it('still refuses another account\'s claim on a verified website', async () => {
    await workspace(await owner('taken.example'));
    await expect(workspace(await owner('TAKEN.example'))).rejects.toThrow(/workspace_domains_verified_domain_uniq/);
  });

  it('registers nothing for an owner without a website', async () => {
    expect(await domainsOf(await workspace(await owner(null)))).toEqual([]);
    expect(await domainsOf(await workspace(await owner('  ')))).toEqual([]);
  });

  it('is safe to run twice', async () => {
    await db.exec(M288);
    const account = await owner('twice.example');
    await workspace(account);
    expect(await domainsOf(await workspace(account))).toEqual([]);
  });
});
