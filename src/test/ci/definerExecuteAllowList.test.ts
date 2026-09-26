/**
 * The anon/authenticated SECURITY DEFINER allow-list has one meaning in three
 * places: the hosted migration, its self-host mirror, and the CI verifier.
 *
 * Hosted Supabase's default privileges grant anon and authenticated EXECUTE
 * on every function the chain creates, so 20260926090000 / 217 revoke both
 * roles from every SECURITY DEFINER function in `public` except a short,
 * audited allow-list, and scripts/ci/verify-migration-security.sql (2b)
 * proves the database really looks like that. If the three lists drift, the
 * migration and the verifier stop agreeing on what "allowed" means — so they
 * are compared here, and the browser's RPC surface is checked against them:
 * an RPC the anon browser client calls that the allow-list does not grant to
 * anon would be refused with "permission denied for function" in production.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const HOSTED = 'supabase/migrations/20260926090000_definer_execute_customer_role_lockdown.sql';
const SELF_HOST = 'database/migrations/217_definer_execute_customer_role_lockdown.sql';
const VERIFIER = 'scripts/ci/verify-migration-security.sql';

const read = (p: string) => readFileSync(p, 'utf8');

type Entry = { sig: string; anon: boolean; auth: boolean };

/** Every `('public.fn(args)', bool, bool)` VALUES list in a file, in order. */
function allowLists(sql: string): Entry[][] {
  const lists: Entry[][] = [];
  for (const block of sql.matchAll(/\(VALUES([\s\S]*?)\)\s*AS\s+a\(sig,\s*anon_ok,\s*auth_ok\)/g)) {
    const entries = [
      ...block[1].matchAll(/\('(public\.[a-z_]+\([^']*\))',\s*(true|false),\s*(true|false)\)/g),
    ].map((m) => ({ sig: m[1], anon: m[2] === 'true', auth: m[3] === 'true' }));
    lists.push(entries);
  }
  return lists;
}

const EXPECTED: Entry[] = [
  { sig: 'public.get_widget_platform_settings()', anon: true, auth: true },
  { sig: 'public.has_role(uuid, public.app_role)', anon: false, auth: true },
  { sig: 'public.is_workspace_member(uuid, uuid)', anon: false, auth: true },
  { sig: 'public.get_workspace_role(uuid, uuid)', anon: false, auth: true },
  { sig: 'public.is_account_member(uuid, uuid)', anon: false, auth: true },
  { sig: 'public.get_account_role(uuid, uuid)', anon: false, auth: true },
  { sig: 'public.workspace_owner_phone_verified(uuid)', anon: false, auth: true },
];

describe('SECURITY DEFINER anon/authenticated allow-list', () => {
  it('the hosted migration carries the audited list in both its revoke and its proof', () => {
    const lists = allowLists(read(HOSTED));
    expect(lists).toHaveLength(2);
    for (const list of lists) expect(list).toEqual(EXPECTED);
  });

  it('the self-host mirror carries the identical list', () => {
    const lists = allowLists(read(SELF_HOST));
    expect(lists).toHaveLength(2);
    for (const list of lists) expect(list).toEqual(EXPECTED);
  });

  it('the CI verifier audits the identical list', () => {
    const lists = allowLists(read(VERIFIER));
    expect(lists).toHaveLength(1);
    expect(lists[0]).toEqual(EXPECTED);
  });

  it('admin_delete_user is made service_role-only explicitly', () => {
    for (const file of [HOSTED, SELF_HOST]) {
      const sql = read(file);
      expect(sql).toContain(
        'REVOKE ALL ON FUNCTION public.admin_delete_user(uuid, uuid) FROM PUBLIC, anon, authenticated;',
      );
      expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.admin_delete_user(uuid, uuid) TO service_role;');
    }
  });

  it('never grants anything to a customer role', () => {
    for (const file of [HOSTED, SELF_HOST]) {
      const sql = read(file).replace(/--[^\n]*/g, '');
      expect(sql).not.toMatch(/GRANT[^;]*\bTO\s+[^;]*\b(anon|authenticated|PUBLIC)\b/i);
    }
  });

  it('every RPC the anon browser/widget client calls is allow-listed for anon', () => {
    const anonOk = new Set(EXPECTED.filter((e) => e.anon).map((e) => e.sig.replace(/^public\.|\(.*$/g, '')));
    const called = new Set<string>();
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          if (entry === 'node_modules' || entry === 'vendor' || full.startsWith(join('src', 'test'))) continue;
          walk(full);
        } else if (/\.(ts|tsx|js|jsx|mjs)$/.test(entry)) {
          for (const m of read(full).matchAll(/\.rpc\(\s*['"`]([a-z0-9_]+)['"`]/g)) called.add(m[1]);
          for (const m of read(full).matchAll(/\/rest\/v1\/rpc\/([a-z0-9_]+)/g)) called.add(m[1]);
        }
      }
    };
    walk('src');
    walk('public');
    expect([...called].filter((fn) => !anonOk.has(fn))).toEqual([]);
  });
});
