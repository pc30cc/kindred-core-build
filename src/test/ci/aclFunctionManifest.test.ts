import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS_DIR = join(process.cwd(), 'supabase', 'migrations');
const ACL_MIGRATION = '20260731160434_20d5ab8b-38fb-4e6d-b9a2-3994ec5d5415.sql';
const ACL_PREFIX = ACL_MIGRATION.slice(0, 14);

type Classification =
  | 'REQUIRED_BEFORE_ACL'
  | 'OPTIONAL_ENVIRONMENT_SPECIFIC'
  | 'CREATED_LATER'
  | 'OBSOLETE';

/**
 * Provenance audit result for the service-only ACL manifest in section 5b of
 * the historical ACL migration. Every signature in the migration must appear
 * here with an explicit classification — an unclassified raw string fails.
 */
const AUDIT: Record<string, Classification> = {
  'public.activate_auto_actions()': 'REQUIRED_BEFORE_ACL',
  'public.business_metrics_rollup_and_prune()': 'REQUIRED_BEFORE_ACL',
  'public.cleanup_expired_auth_tokens()': 'REQUIRED_BEFORE_ACL',
  'public.cleanup_expired_widget_identity()': 'REQUIRED_BEFORE_ACL',
  'public.evaluate_alert_rules()': 'REQUIRED_BEFORE_ACL',
  'public.expire_stale_trials()': 'REQUIRED_BEFORE_ACL',
  'public.perf_metrics_rollup_and_prune()': 'REQUIRED_BEFORE_ACL',
  'public.realtime_metrics_rollup_and_prune()': 'REQUIRED_BEFORE_ACL',
  'public.sla_reliability_rollup_and_prune()': 'REQUIRED_BEFORE_ACL',
  'public.workspace_health_snapshot_compute()': 'REQUIRED_BEFORE_ACL',
  'public.admin_list_realtime_audit(integer)': 'REQUIRED_BEFORE_ACL',
  'public.count_recent_login_failures(text, text, integer)': 'REQUIRED_BEFORE_ACL',
  'public.is_ip_blocked(text)': 'REQUIRED_BEFORE_ACL',
  'public.deduct_ai_credits(uuid, integer, text)': 'REQUIRED_BEFORE_ACL',
  'public.increment_usage_counter(uuid, text, integer)': 'REQUIRED_BEFORE_ACL',
  'public.merge_visitor_into_contact(uuid, text, uuid, text, jsonb)': 'REQUIRED_BEFORE_ACL',
  'public.resolve_privacy_subject(uuid, text, text)': 'REQUIRED_BEFORE_ACL',
  'public.register_workspace_domain(uuid, text, boolean)': 'REQUIRED_BEFORE_ACL',
  'public.bulk_create_contacts(uuid, jsonb)': 'REQUIRED_BEFORE_ACL',
  'public.create_contact(uuid, text, text, text, text, text[], text, jsonb)':
    'REQUIRED_BEFORE_ACL',
  'public.check_channel_access(uuid, text)': 'REQUIRED_BEFORE_ACL',
  'public.kb_search_articles(uuid, text, text, integer)': 'REQUIRED_BEFORE_ACL',
};

function read(file: string): string {
  return readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
}

const aclSql = read(ACL_MIGRATION);

/** Section 5b — the service-role-only manifest block. */
function serviceOnlyBlock(): string {
  const start = aclSql.indexOf('DO $service_acl$');
  const end = aclSql.indexOf('$service_acl$;', start);
  expect(start, 'service-only ACL block not found').toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return aclSql.slice(start, end);
}

/** Every ('signature', 'CLASSIFICATION') pair declared in the manifest. */
function manifestEntries(): Array<[string, string]> {
  const pairRe = new RegExp("\\('(public\\.[^']+)',\\s*'([A-Z_]+)'\\)", 'g');
  const out: Array<[string, string]> = [];
  for (const m of serviceOnlyBlock().matchAll(pairRe)) out.push([m[1], m[2]]);
  return out;
}

function migrationsBeforeAcl(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql') && f.slice(0, 14) < ACL_PREFIX)
    .sort();
}

/** `public.name(arg, arg)` → bare function name. */
function fnName(signature: string): string {
  return signature.replace(/^public\./, '').replace(/\(.*$/, '');
}

describe('service-only ACL function manifest', () => {
  const entries = manifestEntries();

  it('declares every signature with an explicit classification', () => {
    expect(entries.length).toBe(Object.keys(AUDIT).length);
    for (const [signature, classification] of entries) {
      expect(AUDIT[signature], `unclassified ACL signature: ${signature}`).toBeDefined();
      expect(classification).toBe(AUDIT[signature]);
    }
  });

  it('has no unclassified raw signature strings left in the block', () => {
    const block = serviceOnlyBlock();
    const rawRe = new RegExp("'(public\\.[A-Za-z0-9_]+\\([^']*\\))'", 'g');
    for (const m of block.matchAll(rawRe)) {
      expect(AUDIT[m[1]], `raw ACL string without classification: ${m[1]}`).toBeDefined();
    }
  });

  it('resolves signatures through to_regprocedure and fails hard on required gaps', () => {
    const block = serviceOnlyBlock();
    expect(block).toMatch(/to_regprocedure\(item\.signature\)/);
    expect(block).toMatch(/RAISE EXCEPTION\s*\n?\s*'required function missing before ACL migration/);
    // No silent-skip escape hatches.
    expect(block).not.toMatch(/EXCEPTION\s+WHEN\s+undefined_function/i);
    expect(block).not.toMatch(/WHEN\s+OTHERS\s+THEN/i);
    // ACL is applied to the resolved OID, not to the raw text.
    expect(block).toMatch(/REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn_oid/);
    expect(block).toMatch(/GRANT EXECUTE ON FUNCTION %s TO service_role', fn_oid/);
  });

  it('creates every REQUIRED_BEFORE_ACL function in a migration before the ACL migration', () => {
    const earlier = migrationsBeforeAcl().map((f) => read(f));
    const missing: string[] = [];
    for (const [signature, classification] of Object.entries(AUDIT)) {
      if (classification !== 'REQUIRED_BEFORE_ACL') continue;
      const re = new RegExp(
        `CREATE\\s+(OR\\s+REPLACE\\s+)?FUNCTION\\s+(public\\.)?${fnName(signature)}\\s*\\(`,
        'i',
      );
      if (!earlier.some((sql) => re.test(sql))) missing.push(signature);
    }
    expect(missing).toEqual([]);
  });

  it('restores cleanup_expired_auth_tokens from an ordered baseline migration', () => {
    const baseline = '20260414134700_baseline_cleanup_expired_auth_tokens.sql';
    expect(readdirSync(MIGRATIONS_DIR)).toContain(baseline);
    const sql = read(baseline);
    expect(baseline.slice(0, 14) < ACL_PREFIX).toBe(true);
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.cleanup_expired_auth_tokens\(\)/);
    expect(sql).toMatch(/RETURNS void/);
    expect(sql).toMatch(/LANGUAGE plpgsql/);
    expect(sql).toMatch(/SECURITY DEFINER/);
    expect(sql).toMatch(/SET search_path TO 'public'/);
    // Real hosted behaviour, not a NULL stub.
    expect(sql).toMatch(/DELETE FROM auth_sessions/);
    expect(sql).toMatch(/DELETE FROM auth_reset_tokens/);
    expect(sql).toMatch(/DELETE FROM auth_verify_tokens/);
  });
});
