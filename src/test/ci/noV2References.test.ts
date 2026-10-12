/**
 * Billing v2 is gone from the code (simple billing phase 7A).
 *
 * Migration 267 moves billing v2's money and subscriptions into simple
 * billing; migration 268 (phase 7B) then moves the 28 v2 tables into the
 * `billing_v2_archive` schema and drops 9 columns of workspace_subscriptions
 * and the v2 functions. That is only safe if no running code still names
 * them, so this scans the code every app runs (server/, shared/, src/,
 * worker/, ai-runtime/, channels/, plugins/) — comments included, since a
 * comment naming a table is how a reader is sent back to it — for:
 *
 *   - the 28 v2 table names;
 *   - the 9 dropped workspace_subscriptions columns;
 *   - the removed RPCs (every `billing_v2_*` function, the v2 engine, wallet,
 *     enrolment and notification functions, billing_account_v2_next_period);
 *     the schema name `billing_v2_archive` itself is allowed: Super Admin's
 *     exports read the archive by it (server/services/database/archiveExport.ts);
 *   - the removed client and flag modules (`billingApi`, `billingMode`,
 *     `LEGACY_BILLING_ENABLED`);
 *   - the removed v2 API paths (in app code; a test may use an old URL as a
 *     provider fixture).
 *
 * Left out on purpose:
 *   - src/integrations/supabase/types.ts: generated; it lists the v2 objects
 *     until 268 removes them and the file is regenerated (7B);
 *   - src/test/integration/: the pg suites replay the migration chain (the
 *     history that created v2 is part of it) and seed v2 rows on purpose,
 *     billingV2Retirement.pg.test.ts above all;
 *   - src/test/ci/: static checks over the migration files themselves;
 *   - this file and v2Removed.test.ts, which name what must stay gone.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const SCAN_DIRS = ['server', 'shared', 'src', 'worker', 'ai-runtime', 'channels', 'plugins'];
const EXCLUDE_DIRS = new Set(['node_modules', 'dist', 'build', '.git', 'coverage']);
const EXCLUDE_PATHS = [
  'src/integrations/supabase/types.ts',
  'src/test/integration/',
  'src/test/ci/',
  'src/test/billing/simple/v2Removed.test.ts',
];

/** The 28 tables 268 moves into billing_v2_archive (billing_gateways, billing_provider_credentials and billing_events stay). */
const V2_TABLES = [
  'billing_payments',
  'billing_payment_intents',
  'billing_subscription_applications',
  'billing_invoices',
  'billing_invoice_lines',
  'billing_subscription_periods',
  'billing_invoice_applications',
  'billing_invoice_collections',
  'billing_wallet_accounts',
  'billing_wallet_ledger',
  'billing_wallet_deposits',
  'billing_payment_allocations',
  'billing_v2_audit',
  'billing_v2_rollout',
  'billing_v2_policy',
  'billing_v2_workspace_policy',
  'billing_v2_jobs',
  'billing_v2_worker_health',
  'billing_period_allowance_grants',
  'billing_entitlement_cycles',
  'billing_notification_jobs',
  'billing_retention_signals',
  'billing_currencies',
  'billing_exchange_rates',
  'billing_tax_rates',
  'billing_coupons',
  'billing_coupon_redemptions',
  'billing_usage_items',
] as const;

/** The workspace_subscriptions columns 268 drops (design D11). */
const V2_COLUMNS = [
  'current_period_id',
  'v2_allowance_effective_period_id',
  'billing_engine_version',
  'billing_v2_effective_at',
  'billing_anchor_at',
  'next_invoice_at',
  'next_plan_id',
  'pending_change_type',
  'pending_change_currency',
] as const;

/** Removed SQL functions (every `billing_v2_*` one is matched by its prefix). */
const V2_FUNCTIONS = [
  'billing_activate_due_periods',
  'billing_activate_period',
  'billing_apply_invoice_effects',
  'billing_apply_subscription_payment',
  'billing_begin_collection',
  'billing_expire_stale_collections',
  'billing_recover_unapplied_invoices',
  'billing_release_collection',
  'billing_settle_invoice',
  'billing_wallet_admin_adjust',
  'billing_wallet_append',
  'billing_wallet_apply_deposit',
  'billing_wallet_lock',
  'billing_wallet_reconcile',
  'billing_wallet_refund',
  'billing_wallet_pay_invoice',
  'billing_legacy_allowance_active',
  'billing_retire_legacy_allowance',
  'billing_notify_payment_recorded',
  'billing_notify_subscription_lifecycle',
  'billing_notify_trial_ending',
  'billing_enroll_workspace',
  'admin_reset_billing_data',
  'billing_account_v2_next_period',
];

/** `tests: false`: the rule applies to app code only (a test may use an old URL as a fixture string). */
const RULES: Array<{ name: string; re: RegExp; tests?: false }> = [
  { name: 'v2 table', re: new RegExp(`\\b(${V2_TABLES.join('|')})\\b`) },
  { name: 'dropped column', re: new RegExp(`\\b(${V2_COLUMNS.join('|')})\\b`) },
  { name: 'removed RPC', re: new RegExp(`\\b(billing_v2_(?!archive\\b)[a-z0-9_]+|${V2_FUNCTIONS.join('|')})\\b`) },
  { name: 'removed module or flag', re: /\bLEGACY_BILLING_ENABLED\b|\bbillingApi\b|\bbillingMode\b|billing-i18n|billingV2Retired|billingCustomer|adminBillingV2/ },
  {
    name: 'removed v2 API path',
    tests: false,
    re: /\/api\/billing\/(status|checkout|invoice|verify-callback|payment-intent|providers|subscription\/|portal|events|entitlement|admin\/|workspaces\/|return\b)|\/api\/admin\/billing-v2|\/api\/admin\/billing\/(currencies|exchange-rates|tax-rates|coupons|usage-items|overview|invoices|payments|customers|audit|reset)|\/billing\/pay\//,
  },
];

function walk(dir: string, out: string[]): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    if (EXCLUDE_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|js|mjs|cjs)$/.test(entry)) out.push(full);
  }
}

function scannedFiles(): string[] {
  const files: string[] = [];
  for (const dir of SCAN_DIRS) walk(join(REPO_ROOT, dir), files);
  return files
    .map((f) => relative(REPO_ROOT, f).split('\\').join('/'))
    .filter((f) => !EXCLUDE_PATHS.some((p) => (p.endsWith('/') ? f.startsWith(p) : f === p)));
}

describe('billing v2 is gone from the code (phase 7A)', () => {
  const files = scannedFiles();

  it('scans the apps, so a silent zero-match cannot pass', () => {
    expect(files.length).toBeGreaterThan(500);
    expect(files).toContain('server/routes/billing.ts');
    expect(files).toContain('server/services/billing/account/card.ts');
    expect(files).toContain('src/pages/app/BillingPage.tsx');
  });

  it('the rules catch what they are meant to', () => {
    const hit = (s: string) => RULES.filter((r) => r.re.test(s)).map((r) => r.name);
    expect(hit(".from('billing_payment_intents')")).toEqual(['v2 table']);
    expect(hit('s.next_plan_id')).toEqual(['dropped column']);
    expect(hit("rpc('billing_v2_admin_grant_plan')")).toEqual(['removed RPC']);
    expect(hit("import { LEGACY_BILLING_ENABLED } from '../shared/billingMode'")).toEqual(['removed module or flag']);
    expect(hit("fetch('/api/billing/checkout')")).toEqual(['removed v2 API path']);
    // What stays is not caught.
    expect(hit(".from('billing_account_payments'); 'billing_payment_receipt'; /api/billing/account-return; /api/billing/plans")).toEqual([]);
    expect(hit(".from('billing_gateways'); .from('billing_events'); .from('billing_provider_credentials')")).toEqual([]);
    // The archive's schema is named by the exports that read it (268); its tables are not.
    expect(hit("const ARCHIVE_SCHEMA = 'billing_v2_archive'; rpc('admin_export_archive_tables')")).toEqual([]);
    expect(hit("'billing_v2_archive_x'")).toEqual(['removed RPC']);
  });

  it('no file names a v2 table, a dropped column, a removed RPC, module or API path', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const lines = readFileSync(join(REPO_ROOT, file), 'utf8').split('\n');
      const isTest = /\.test\.(ts|tsx)$/.test(file) || file.startsWith('src/test/');
      lines.forEach((line, i) => {
        for (const rule of RULES) {
          if (isTest && rule.tests === false) continue;
          const m = rule.re.exec(line);
          if (m) offenders.push(`${file}:${i + 1} ${rule.name}: ${m[0]}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
