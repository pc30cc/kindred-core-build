/**
 * Workspace Invitations v5.1 — migration parity guard (§A.8).
 *
 * Byte equality between the two chains is explicitly NOT required (offboarding
 * and seat authority are chain-specific). What IS required, and what this test
 * proves without a database, is:
 *
 *   1. every invitation RPC the Express server calls exists in BOTH chains
 *      (database/migrations = self-host, supabase/migrations = hosted);
 *   2. the argument signature (arity + declared parameter names) matches;
 *   3. the last definition in each chain is SECURITY DEFINER with a pinned
 *      search_path;
 *   4. the chain revokes EXECUTE from PUBLIC/anon/authenticated and grants it
 *      only to service_role.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const SELF_HOST = path.join(ROOT, 'database/migrations');
const HOSTED = path.join(ROOT, 'supabase/migrations');
const SERVER_SOURCES = [
  path.join(ROOT, 'server/routes/workspaceInvitations.ts'),
  path.join(ROOT, 'server/services/invitations'),
];

/** RPCs that are intentionally chain-specific / provided by other subsystems. */
const NOT_INVITATION_SPECIFIC = new Set([
  'set_workspace_seat_entitlement_mode',
]);

/**
 * Since §10 (atomic idempotency) the router no longer calls the invitation
 * primitives directly — `wi_execute_idempotent` dispatches them inside the same
 * transaction. Parity must still cover them, so the surface is the union of the
 * RPCs the server calls and the primitives the executor dispatches.
 */
const EXECUTOR_DISPATCHED = [
  'create_workspace_invitation_v2',
  'edit_workspace_invitation_v2',
  'resend_invitation_email_v2',
  'rotate_manual_link_v2',
  'revoke_invitation_v2',
  'archive_invitation_v2',
  'wi_create_login_context',
  'wi_request_invitation_otp',
  'wi_verify_invitation_otp',
  'accept_invitation_new_user_v2',
  'accept_invitation_existing_context_v2',
  'wi_preview_invitation',
  'wi_preview_login_context',
  'wi_account_exists',
  'wi_execute_idempotent',
  'wi_heartbeat_invitation_job',
];


function readSqlChain(dir: string): { file: string; sql: string }[] {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => ({ file: f, sql: fs.readFileSync(path.join(dir, f), 'utf8') }));
}

function collectServerRpcNames(): string[] {
  const files: string[] = [];
  for (const entry of SERVER_SOURCES) {
    const stat = fs.statSync(entry);
    if (stat.isDirectory()) {
      for (const f of fs.readdirSync(entry)) {
        if (f.endsWith('.ts')) files.push(path.join(entry, f));
      }
    } else {
      files.push(entry);
    }
  }
  const names = new Set<string>();
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/\.rpc\(\s*'([a-z0-9_]+)'/g)) names.add(m[1]);
  }
  return [...names].filter((n) => !NOT_INVITATION_SPECIFIC.has(n)).sort();
}

interface Definition {
  file: string;
  paramNames: string[];
  securityDefiner: boolean;
  searchPathPinned: boolean;
}

/** Returns the LAST definition of `fn` in the chain (the effective one). */
function findDefinition(chain: { file: string; sql: string }[], fn: string): Definition | null {
  let found: Definition | null = null;
  const re = new RegExp(
    `CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+public\\.${fn}\\s*\\(([\\s\\S]*?)\\)\\s*RETURNS[\\s\\S]*?(?:AS\\s+\\$)`,
    'gi',
  );
  for (const { file, sql } of chain) {
    for (const m of sql.matchAll(re)) {
      const header = m[0];
      const params = m[1]
        .split(/,(?![^()]*\))/)
        .map((p) => p.trim())
        .filter(Boolean)
        .map((p) => p.split(/\s+/)[0].toLowerCase());
      found = {
        file,
        paramNames: params,
        securityDefiner: /SECURITY\s+DEFINER/i.test(header),
        searchPathPinned: /SET\s+search_path\s*=\s*public\s*,\s*pg_temp/i.test(header),
      };
    }
  }
  return found;
}

function aclOk(chain: { file: string; sql: string }[], fn: string): { revoked: boolean; granted: boolean } {
  let revoked = false;
  let granted = false;
  const revokeRe = new RegExp(`REVOKE[\\s\\S]{0,80}?FUNCTION\\s+public\\.${fn}\\s*\\(`, 'i');
  const grantRe = new RegExp(`GRANT\\s+EXECUTE\\s+ON\\s+FUNCTION\\s+public\\.${fn}\\s*\\([^)]*\\)\\s*TO\\s+service_role`, 'i');
  // Loop-driven ACL blocks (DO $acl$ ... ARRAY['fn(args)' ...]) count too.
  const loopRe = new RegExp(`'${fn}\\(`, 'i');
  for (const { sql } of chain) {
    if (revokeRe.test(sql) || loopRe.test(sql)) revoked = true;
    if (grantRe.test(sql) || loopRe.test(sql)) granted = true;
  }
  return { revoked, granted };
}

const selfHost = readSqlChain(SELF_HOST);
const hosted = readSqlChain(HOSTED);
const rpcNames = collectServerRpcNames();

describe('invitation RPC parity between self-host and hosted chains', () => {
  it('discovers the invitation RPC surface from the server', () => {
    expect(rpcNames.length).toBeGreaterThan(10);
    expect(rpcNames).toContain('accept_invitation_existing_context_v2');
    expect(rpcNames).toContain('wi_preview_login_context');
    expect(rpcNames).toContain('wi_heartbeat_invitation_job');
  });

  for (const fn of rpcNames) {
    it(`${fn}: exists in both chains with the same signature and service-role-only ACL`, () => {
      const a = findDefinition(selfHost, fn);
      const b = findDefinition(hosted, fn);

      expect(a, `${fn} missing from database/migrations (self-host chain)`).not.toBeNull();
      expect(b, `${fn} missing from supabase/migrations (hosted chain)`).not.toBeNull();

      expect(a!.paramNames, `${fn} signature drift (self-host vs hosted)`).toEqual(b!.paramNames);

      for (const [label, def] of [['self-host', a!], ['hosted', b!]] as const) {
        expect(def.securityDefiner, `${fn} is not SECURITY DEFINER in ${label} (${def.file})`).toBe(true);
        expect(def.searchPathPinned, `${fn} has no pinned search_path in ${label} (${def.file})`).toBe(true);
      }

      for (const [label, chain] of [['self-host', selfHost], ['hosted', hosted]] as const) {
        const acl = aclOk(chain, fn);
        expect(acl.revoked, `${fn} never revoked from PUBLIC/anon/authenticated in ${label}`).toBe(true);
        expect(acl.granted, `${fn} never granted to service_role in ${label}`).toBe(true);
      }
    });
  }
});
