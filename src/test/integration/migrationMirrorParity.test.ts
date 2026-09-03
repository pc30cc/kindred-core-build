/**
 * Phase 6-S5-R7.5 §10 — migration mirror parity.
 *
 * The self-host chain (database/migrations) and the hosted Supabase chain
 * (supabase/migrations) must stay functionally identical for the migrations
 * that exist in both. Only filenames and comments/whitespace may differ; any
 * functional SQL difference fails CI.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';

const MIRRORS: Array<{ label: string; selfHost: string; hosted: string }> = [
  {
    label: '008 — fan-out generation semantics',
    selfHost: 'database/migrations/008_entitlement_fanout_generations.sql',
    hosted: 'supabase/migrations/20260803060000_entitlement_fanout_generations.sql',
  },
  {
    label: '009 — fan-out cursor generation + AI-KB transactions',
    selfHost: 'database/migrations/009_fanout_cursor_generation_and_ai_kb_tx.sql',
    hosted: 'supabase/migrations/20260803070000_fanout_cursor_generation_and_ai_kb_tx.sql',
  },
  {
    label: '011 — AI-KB slug namespace lock',
    selfHost: 'database/migrations/011_ai_kb_slug_namespace_lock.sql',
    hosted: 'supabase/migrations/20260803090000_ai_kb_slug_namespace_lock.sql',
  },
  {
    label: '012 — AI-KB ACL re-assertion',
    selfHost: 'database/migrations/012_ai_kb_acl_reassert_guarded.sql',
    hosted: 'supabase/migrations/20260803120000_ai_kb_acl_reassert_guarded.sql',
  },
  {
    label: '010 — fan-out RPC security + KB state machine',
    selfHost: 'database/migrations/010_fanout_rpc_security_and_kb_state_machine.sql',
    hosted: 'supabase/migrations/20260803080000_fanout_rpc_security_and_kb_state_machine.sql',
  },
  {
    label: '013 — public schema CREATE lockdown',
    selfHost: 'database/migrations/013_public_schema_create_lockdown.sql',
    hosted: 'supabase/migrations/20260803130000_public_schema_create_lockdown.sql',
  },
  {
    label: '014 — core SECURITY DEFINER ACL lockdown',
    selfHost: 'database/migrations/014_core_security_definer_acl_lockdown.sql',
    hosted: 'supabase/migrations/20260803150000_core_security_definer_acl_lockdown.sql',
  },
  {
    label: '024 — first-party user_credentials table (auth migration Phase 3/4)',
    selfHost: 'database/migrations/024_user_credentials.sql',
    hosted: 'supabase/migrations/20260819120000_user_credentials.sql',
  },
  {
    label: '027 — profiles.phone column (auth migration account.ts follow-up)',
    selfHost: 'database/migrations/027_profiles_phone.sql',
    hosted: 'supabase/migrations/20260819140000_profiles_phone.sql',
  },
  {
    label: '028 — admin_impersonation_tokens table (auth migration admin impersonation)',
    selfHost: 'database/migrations/028_admin_impersonation_tokens.sql',
    hosted: 'supabase/migrations/20260819150000_admin_impersonation_tokens.sql',
  },
  {
    label: '029 — legacy email-verification backfill (GoTrue cutover closure)',
    selfHost: 'database/migrations/029_backfill_legacy_email_verification.sql',
    hosted: 'supabase/migrations/20260819160000_backfill_legacy_email_verification.sql',
  },
  {
    label: '073 — AI usage billing core (pricing, runs, wallet, ledger)',
    selfHost: 'database/migrations/073_ai_usage_billing.sql',
    hosted: 'supabase/migrations/20260901094824_28a01e28-0db2-446d-9ca2-424187cd82dc.sql',
  },
  {
    label: '074 — AI billing pricing append-only',
    selfHost: 'database/migrations/074_ai_billing_pricing_append_only.sql',
    hosted: 'supabase/migrations/20260901103902_7a77e604-f85d-42c2-b0d9-94e51cff0dfb.sql',
  },
  {
    label: '075 — AI billing cluster-wide recovery lease',
    selfHost: 'database/migrations/075_ai_billing_recovery_lease.sql',
    hosted: 'supabase/migrations/20260901105630_5ba30ba4-19b7-4cc7-85fc-9aeb4a6bedc6.sql',
  },
  {
    label: '092 — offboarding idempotency (executor gains the offboard operation)',
    selfHost: 'database/migrations/092_workspace_invitations_v51_offboard_idempotency.sql',
    hosted: 'supabase/migrations/20260902151219_87793458-f50c-4bfd-8162-91611730b306.sql',
  },
  {
    label: '093 — D.3 invitation schema parity (backend-only ACL, no RLS policies)',
    selfHost: 'database/migrations/093_workspace_invitations_v51_schema_parity.sql',
    hosted: 'supabase/migrations/20260902155705_31043af0-bc77-47e0-ba22-8115bef292f3.sql',
  },
  {
    label: '094 — invitation preview context (inviter name + department names)',
    selfHost: 'database/migrations/094_workspace_invitations_v51_preview_context.sql',
    hosted: 'supabase/migrations/20260902161824_bddd59bc-c326-443e-bcbe-6982fdc3f8ad.sql',
  },
  {
    label: '095 — persisted invitation notification locale (fa/tr/en)',
    selfHost: 'database/migrations/095_workspace_invitations_v51_notification_locale.sql',
    hosted: 'supabase/migrations/20260902165446_fbbfe1b1-eaa3-487c-bf16-3b7e1497222e.sql',
  },
  {
    label: '098 — Generic Verification Core v1 (dormant, no consumer wired)',
    selfHost: 'database/migrations/098_generic_verification_core.sql',
    hosted: 'supabase/migrations/20260902185146_generic_verification_core.sql',
  },
  {
    label: '099 — Generic Verification Core Super Admin settings (dormant, multi-gate activation)',
    selfHost: 'database/migrations/099_generic_verification_admin_settings.sql',
    hosted: 'supabase/migrations/20260903000000_generic_verification_admin_settings.sql',
  },

  // NOTE: 025 (auth_sessions/auth_reset_tokens/auth_verify_tokens) and 026
  // (repoint identity-root FKs to profiles) are deliberately NOT registered
  // here: the two chains' starting schemas differ (self-host creates 3 tables from
  // scratch for 025 vs. hosted's single ADD COLUMN; self-host covers 6
  // FK-bearing tables for 026 vs. hosted's 11, since hosted has later
  // features self-host's bootstrap chain never received), so the SQL is
  // intentionally asymmetric, not a drift bug.
];

/** Strips line comments, block comments and collapses whitespace. */
function functionalSql(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('migration mirror parity', () => {
  for (const { label, selfHost, hosted } of MIRRORS) {
    it(`${label} is functionally identical in both chains`, () => {
      expect(functionalSql(hosted)).toBe(functionalSql(selfHost));
    });
  }
});

/**
 * Chain completeness: every canonical self-host migration from 008 onward must
 * have its hosted mirror present. A gap (as with the missing 009 mirror) is a
 * hard failure even when the later mirrors are all there.
 */
const CANONICAL_ORDER = [
  'database/migrations/008_entitlement_fanout_generations.sql',
  'database/migrations/009_fanout_cursor_generation_and_ai_kb_tx.sql',
  'database/migrations/010_fanout_rpc_security_and_kb_state_machine.sql',
  'database/migrations/011_ai_kb_slug_namespace_lock.sql',
  'database/migrations/012_ai_kb_acl_reassert_guarded.sql',
  'database/migrations/013_public_schema_create_lockdown.sql',
  'database/migrations/014_core_security_definer_acl_lockdown.sql',
];

describe('hosted mirror chain completeness', () => {
  const bySelfHost = new Map(MIRRORS.map((m) => [m.selfHost, m.hosted]));

  it('declares a hosted mirror for every canonical migration 008 → 014', () => {
    const missing = CANONICAL_ORDER.filter((p) => !bySelfHost.has(p));
    expect(missing).toEqual([]);
  });

  it('every declared hosted mirror file exists on disk', () => {
    const absent = MIRRORS.filter((m) => !existsSync(m.hosted) || !existsSync(m.selfHost));
    expect(absent.map((m) => m.label)).toEqual([]);
  });

  it('hosted mirror timestamps sort in canonical migration order', () => {
    const stamps = CANONICAL_ORDER.map((p) => {
      const hosted = bySelfHost.get(p);
      return hosted ? hosted.split('/').pop()!.split('_')[0] : '';
    });
    expect(stamps).toEqual([...stamps].sort());
    expect(new Set(stamps).size).toBe(stamps.length);
  });
});
/**
 * Executor parity: the two chains must agree on WHAT the idempotent executor
 * can do, not merely on its signature. A hosted mirror that kept the old
 * operation list would pass a signature check and still be functionally
 * divergent, so the operation allow-list and every dispatch target are
 * compared directly.
 */
const EXECUTOR_MIRROR = MIRRORS.find((m) => m.label.startsWith('092'))!;

function executorOperations(path: string): string[] {
  const sql = functionalSql(path);
  return [...new Set([...sql.matchAll(/WHEN '([a-z_]+)' THEN/g)].map((m) => m[1]))].sort();
}
function dispatchTargets(path: string): string[] {
  const sql = functionalSql(path);
  const body = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION public.wi_execute_idempotent'));
  return [...new Set([...body.matchAll(/public\.([a-z0-9_]+)\s*\(/g)].map((m) => m[1]))].sort();
}

describe('idempotent executor operation parity', () => {
  it('both chains expose the SAME operation allow-list, including offboard', () => {
    const selfHost = executorOperations(EXECUTOR_MIRROR.selfHost);
    expect(selfHost).toContain('offboard');
    expect(executorOperations(EXECUTOR_MIRROR.hosted)).toEqual(selfHost);
  });

  it('both chains dispatch each operation to the SAME target functions', () => {
    const selfHost = dispatchTargets(EXECUTOR_MIRROR.selfHost);
    expect(selfHost).toContain('offboard_workspace_member');
    expect(dispatchTargets(EXECUTOR_MIRROR.hosted)).toEqual(selfHost);
  });
});
