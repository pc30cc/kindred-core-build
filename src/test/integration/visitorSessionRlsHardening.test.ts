/**
 * Regression test for the visitor_sessions/visitor_presence RLS drift found
 * during the auth-migration audit (RLS_AUTHORIZATION_AUDIT.md finding VS-1).
 *
 * Both chains started from byte-identical wide-open anon policies
 * (`USING (true)` / `WITH CHECK (true)`), the hosted chain tightened them on
 * 2026-04-15 (supabase/migrations/20260415082424_*, 20260415082519_*), and
 * the self-host chain never received the equivalent fix until
 * database/migrations/022_visitor_session_anon_rls_hardening.sql. This test
 * proves BOTH chains are hardened, so the drift cannot silently return via a
 * future edit to either chain.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');

function concatChain(dir: string): string {
  const files = readdirSync(join(ROOT, dir))
    .filter((f) => f.endsWith('.sql'))
    .sort();
  return files.map((f) => readFileSync(join(ROOT, dir, f), 'utf8')).join('\n');
}

const HOSTED = concatChain('supabase/migrations');
const SELF_HOST = concatChain('database/migrations');

/**
 * Returns the body text of the LAST (i.e. currently active, in file-order)
 * `CREATE POLICY "name" ...` statement for the given policy name in `sql`,
 * up to its terminating semicolon — or null if no CREATE POLICY with that
 * exact name exists at all. Mirrors the "last CREATE wins" resolution used
 * throughout the RLS audit.
 */
function lastPolicyBody(sql: string, policyName: string): string | null {
  const marker = `CREATE POLICY "${policyName}"`;
  const idx = sql.lastIndexOf(marker);
  if (idx === -1) return null;
  const end = sql.indexOf(';', idx);
  return sql.slice(idx, end === -1 ? undefined : end + 1);
}

/** True if this policy name's CURRENT definition exists and is wide-open (USING/WITH CHECK true). */
function isActivelyWideOpen(sql: string, policyName: string): boolean {
  const body = lastPolicyBody(sql, policyName);
  if (!body) return false;
  return /USING\s*\(\s*true\s*\)/i.test(body) || /WITH CHECK\s*\(\s*true\s*\)/i.test(body);
}

/** True if a DROP POLICY for this exact name appears anywhere after its last CREATE (i.e. it's been removed and nothing re-created it). */
function isDropped(sql: string, policyName: string): boolean {
  const createIdx = sql.lastIndexOf(`CREATE POLICY "${policyName}"`);
  const dropIdx = sql.lastIndexOf(`DROP POLICY IF EXISTS "${policyName}"`);
  if (dropIdx === -1) return false;
  return dropIdx > createIdx;
}

describe('visitor_sessions/visitor_presence anon RLS — VS-1 regression guard', () => {
  it('self-host: "Anon can insert visitor sessions" is no longer bare WITH CHECK(true)', () => {
    const body = lastPolicyBody(SELF_HOST, 'Anon can insert visitor sessions');
    expect(body).not.toBeNull();
    expect(isActivelyWideOpen(SELF_HOST, 'Anon can insert visitor sessions')).toBe(false);
    expect(body).toContain('widget_settings');
    expect(body).toContain('visitor_tracking_enabled');
  });

  it('self-host: the old wide-open "Anon can update visitor sessions" (USING true) policy is dropped, not just superseded', () => {
    expect(isDropped(SELF_HOST, 'Anon can update visitor sessions')).toBe(true);
  });

  it('self-host: "Anon can update own visitor sessions" (header-matched) exists and is not wide-open', () => {
    expect(isActivelyWideOpen(SELF_HOST, 'Anon can update own visitor sessions')).toBe(false);
    const body = lastPolicyBody(SELF_HOST, 'Anon can update own visitor sessions');
    expect(body).toContain("current_setting('request.headers', true)::json->>'x-visitor-id'");
  });

  it('self-host: the old wide-open "Anon can manage presence" (FOR ALL USING true) policy is dropped', () => {
    expect(isDropped(SELF_HOST, 'Anon can manage presence')).toBe(true);
  });

  it('self-host: scoped presence policies (insert/update/read) exist and are not wide-open', () => {
    for (const name of ['Anon can insert own presence', 'Anon can update own presence', 'Anon can read own presence']) {
      expect(lastPolicyBody(SELF_HOST, name)).not.toBeNull();
      expect(isActivelyWideOpen(SELF_HOST, name)).toBe(false);
    }
  });

  it('hosted: the old wide-open "Anon can update visitor sessions" (USING true) policy is dropped, not just superseded', () => {
    expect(isDropped(HOSTED, 'Anon can update visitor sessions')).toBe(true);
  });

  it('hosted: the old wide-open "Anon can manage presence" (FOR ALL USING true) policy is dropped', () => {
    expect(isDropped(HOSTED, 'Anon can manage presence')).toBe(true);
  });

  it('hosted: scoped visitor_sessions/visitor_presence policies exist and are not wide-open', () => {
    expect(isActivelyWideOpen(HOSTED, 'Anon can update own visitor sessions')).toBe(false);
    expect(lastPolicyBody(HOSTED, 'Anon can update own visitor sessions')).not.toBeNull();
    for (const name of ['Anon can insert own presence', 'Anon can update own presence', 'Anon can read own presence']) {
      expect(lastPolicyBody(HOSTED, name)).not.toBeNull();
      expect(isActivelyWideOpen(HOSTED, name)).toBe(false);
    }
  });
});
