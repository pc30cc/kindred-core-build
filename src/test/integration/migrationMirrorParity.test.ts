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
  {
    label: '100 — Generic Verification Core Super Admin settings hardening (policy-tightening, concurrency-safe idempotency, retention)',
    selfHost: 'database/migrations/100_generic_verification_admin_settings_hardening.sql',
    hosted: 'supabase/migrations/20260904000000_generic_verification_admin_settings_hardening.sql',
  },
  {
    label: '108 — SEO / Website Audit core schema (generic job queue + seo_* tables)',
    selfHost: 'database/migrations/121_seo_audit_core.sql',
    hosted: 'supabase/migrations/20260906000000_seo_audit_core.sql',
  },
  {
    label: '140 — SEO Backlinks module (platform provider config + seo_backlink_scans/seo_backlinks)',
    selfHost: 'database/migrations/140_seo_backlinks.sql',
    hosted: 'supabase/migrations/20260909130000_seo_backlinks.sql',
  },
  {
    label: '141 — SEO Keyword Research + Rank Tracking modules',
    selfHost: 'database/migrations/141_seo_keywords_and_rank_tracking.sql',
    hosted: 'supabase/migrations/20260909140000_seo_keywords_and_rank_tracking.sql',
  },
  {
    label: '142 — SEO Performance module',
    selfHost: 'database/migrations/142_seo_performance_module.sql',
    hosted: 'supabase/migrations/20260909150000_seo_performance_module.sql',
  },
  {
    label: '143 — SEO GSC Insights module',
    selfHost: 'database/migrations/143_seo_gsc_insights.sql',
    hosted: 'supabase/migrations/20260909160000_seo_gsc_insights.sql',
  },
  {
    label: '144 — SEO Site Explorer arbitrary-domain lookups',
    selfHost: 'database/migrations/144_seo_site_explorer.sql',
    hosted: 'supabase/migrations/20260909170000_seo_site_explorer.sql',
  },
  {
    label: '145 — SEO Web Analytics',
    selfHost: 'database/migrations/145_web_analytics.sql',
    hosted: 'supabase/migrations/20260909180000_web_analytics.sql',
  },
  {
    label: '146 — SEO Bot Analytics',
    selfHost: 'database/migrations/146_bot_analytics.sql',
    hosted: 'supabase/migrations/20260910090000_bot_analytics.sql',
  },
  {
    label: '147 — SEO Brand Radar',
    selfHost: 'database/migrations/147_brand_radar.sql',
    hosted: 'supabase/migrations/20260910120000_brand_radar.sql',
  },
  {
    label: '161 — SEO Rank Tracking Competitors',
    selfHost: 'database/migrations/161_rank_tracking_competitors.sql',
    hosted: 'supabase/migrations/20260912090000_rank_tracking_competitors.sql',
  },
  {
    label: '162 — SEO Site Explorer Competing Domains',
    selfHost: 'database/migrations/162_seo_explorer_competing_domains.sql',
    hosted: 'supabase/migrations/20260912100000_seo_explorer_competing_domains.sql',
  },
  {
    label: '163 — Email Inbox',
    selfHost: 'database/migrations/163_email_inbox.sql',
    hosted: 'supabase/migrations/20260912110000_email_inbox.sql',
  },
  {
    label: '164 — Channel OAuth States',
    selfHost: 'database/migrations/164_channel_oauth_states.sql',
    hosted: 'supabase/migrations/20260912120000_channel_oauth_states.sql',
  },
  {
    label: '165 — Email Messages Delivery Status',
    selfHost: 'database/migrations/165_email_messages_delivery_status.sql',
    hosted: 'supabase/migrations/20260912130000_email_messages_delivery_status.sql',
  },
  {
    label: '177 — Account avatar ownership (profiles.avatar_storage_key)',
    selfHost: 'database/migrations/177_profiles_avatar_storage_key.sql',
    hosted: 'supabase/migrations/20260915073000_profiles_avatar_storage_key.sql',
  },
  {
    label: '178 — Email attachment storage-key workspace scoping',
    selfHost: 'database/migrations/178_email_attachments_workspace_scope.sql',
    hosted: 'supabase/migrations/20260915090000_email_attachments_workspace_scope.sql',
  },
  {
    label: '179 — profiles.avatar_storage_key user-scope guard',
    selfHost: 'database/migrations/179_profiles_avatar_storage_key_scope_check.sql',
    hosted: 'supabase/migrations/20260915090500_profiles_avatar_storage_key_scope_check.sql',
  },
  {
    label: '180 — Workspace deletion storage-aware lifecycle',
    selfHost: 'database/migrations/180_workspace_deletion_lifecycle.sql',
    hosted: 'supabase/migrations/20260915093000_workspace_deletion_lifecycle.sql',
  },
  {
    label: '181 — Workspace deletion: multi-provider scopes, atomic enqueue, retry, leased claim',
    selfHost: 'database/migrations/181_workspace_deletion_multi_provider.sql',
    hosted: 'supabase/migrations/20260915094000_workspace_deletion_multi_provider.sql',
  },
  {
    label: '183 — User deletion storage-aware lifecycle',
    selfHost: 'database/migrations/183_user_deletion_lifecycle.sql',
    hosted: 'supabase/migrations/20260915095000_user_deletion_lifecycle.sql',
  },
  {
    label: '184 — Workspace branding ownership (workspace_branding.logo_storage_key)',
    selfHost: 'database/migrations/184_workspace_branding_storage_key.sql',
    hosted: 'supabase/migrations/20260915100000_workspace_branding_storage_key.sql',
  },
  {
    label: '185 — Deletion lease fencing (lease_token + renew RPCs)',
    selfHost: 'database/migrations/185_deletion_lease_fencing.sql',
    hosted: 'supabase/migrations/20260916083000_deletion_lease_fencing.sql',
  },
  {
    label: '186 — User deletion multi-provider storage scopes',
    selfHost: 'database/migrations/186_user_deletion_multi_provider.sql',
    hosted: 'supabase/migrations/20260916084000_user_deletion_multi_provider.sql',
  },
  {
    label: '187 — Owner write leases (TOCTOU write barrier)',
    selfHost: 'database/migrations/187_owner_write_leases.sql',
    hosted: 'supabase/migrations/20260916090000_owner_write_leases.sql',
  },
  {
    label: '188 — Owner write lease hardening (no expired-lease renewal, DB-time-based active check with reconciliation grace)',
    selfHost: 'database/migrations/188_owner_write_lease_hardening.sql',
    hosted: 'supabase/migrations/20260916091000_owner_write_lease_hardening.sql',
  },

  // NOTE: 025 (auth_sessions/auth_reset_tokens/auth_verify_tokens) and 026
  // (repoint identity-root FKs to profiles) are deliberately NOT registered
  // here: the two chains' starting schemas differ (self-host creates 3 tables from
  // scratch for 025 vs. hosted's single ADD COLUMN; self-host covers 6
  // FK-bearing tables for 026 vs. hosted's 11, since hosted has later
  // features self-host's bootstrap chain never received), so the SQL is
  {
    label: '189 — storage provider pool: atomic pool/default write + targeted replica state',
    selfHost: 'database/migrations/189_storage_provider_pool_atomic.sql',
    hosted: 'supabase/migrations/20260916092000_storage_provider_pool_atomic.sql',
  },

  {
    label: '190 — storage-key ownership: contacts.avatar_storage_key + per-owner CHECKs',
    selfHost: 'database/migrations/190_storage_key_ownership.sql',
    hosted: 'supabase/migrations/20260916093000_storage_key_ownership.sql',
  },
  {
    label: '209 — invitation previews share wi_account_exists; atomic wi_delete_invitation',
    selfHost: 'database/migrations/209_workspace_invitations_v51_account_exists_and_delete.sql',
    hosted: 'supabase/migrations/20260923180000_workspace_invitations_v51_account_exists_and_delete.sql',
  },

  // intentionally asymmetric, not a drift bug.

  // NOTE: 182 (database/migrations/182_admin_purge_workspaces_selfhost.sql)
  // is deliberately NOT registered as a mirror pair. It is a self-host-only
  // migration: admin_purge_workspaces/admin_delete_workspace/
  // admin_delete_user already exist on the hosted chain (supabase/
  // migrations/20260910162747_...sql, predating this corrective pass) — 182
  // ports those SAME function bodies to self-host, which never had them, so
  // there is no NEW hosted file to pair it with. See 182's own header
  // comment for why its two admin_delete_* bodies additionally inline
  // `PERFORM set_config('app.billing_purge', 'on', true)` that the hosted
  // originals get from 155's dynamic injection instead (155 already ran,
  // against functions that didn't exist yet, before 182 existed).
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
