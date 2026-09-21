/**
 * Are the billing_v2 tables reachable from the running product, and may
 * either migration chain drop them?
 *
 * The question was raised because `supabase/migrations` never creates the
 * billing_v2 substrate, so a from-scratch hosted replay dies on
 * `relation "public.billing_v2_rollout" does not exist`. The tempting reading
 * is that the substrate is scaffolding nobody uses. It is not:
 *
 *   * Production runs on it. `billing_v2_rollout` holds one workspace in state
 *     `v2_active` — billing v2 is the live engine for it, not a shadow — and
 *     all five scheduler workers write `billing_v2_worker_health` heartbeats
 *     continuously.
 *   * A customer reaches it. /app/:workspace/billing is the only customer
 *     billing experience the frontend has, and its read model queries
 *     `billing_v2_policy` and `billing_v2_policy_for` on every load.
 *
 * So the substrate stays. What this file locks down is the reachability that
 * makes that true, and the exact size of the hosted chain's debt, so nobody
 * concludes "unused" from a grep again and so the debt cannot quietly grow.
 *
 * It is deliberately static: the pg suites (billingEngineV2, billingV2Phase*)
 * already prove the engine's behaviour against a real database. What was
 * missing is the question those suites cannot ask, because they apply only
 * one of the two chains.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const SELF_HOST = join(ROOT, 'database', 'migrations');
const HOSTED = join(ROOT, 'supabase', 'migrations');

function read(...parts: string[]): string {
  return readFileSync(join(ROOT, ...parts), 'utf8');
}

/** Every .ts under server/, so a new call site is picked up without editing this file. */
function serverSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(dir, entry.name));
      else if (entry.name.endsWith('.ts')) out.push(join(dir, entry.name));
    }
  };
  walk('server');
  return out;
}

function chain(dir: string): Array<{ file: string; sql: string }> {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((file) => ({ file, sql: readFileSync(join(dir, file), 'utf8') }));
}

/** What the server actually asks PostgREST for, by name. */
function whatTheServerTouches(): { tables: string[]; rpcs: string[] } {
  const tables = new Set<string>();
  const rpcs = new Set<string>();
  for (const file of serverSources()) {
    const sql = readFileSync(join(ROOT, file), 'utf8');
    for (const m of sql.matchAll(/\.from\(\s*['"]([a-z0-9_]*billing_v2[a-z0-9_]*)['"]/g)) {
      tables.add(m[1]);
    }
    for (const m of sql.matchAll(/\.rpc\(\s*['"](billing_v2[a-z0-9_]*)['"]/g)) {
      rpcs.add(m[1]);
    }
  }
  return { tables: [...tables].sort(), rpcs: [...rpcs].sort() };
}

function createsTable(files: Array<{ file: string; sql: string }>, name: string): string[] {
  const re = new RegExp(
    String.raw`CREATE\s+(?:UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?${name}\b`,
    'i',
  );
  return files.filter((f) => re.test(f.sql)).map((f) => f.file);
}

function createsFunction(files: Array<{ file: string; sql: string }>, name: string): string[] {
  const re = new RegExp(
    String.raw`CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?${name}\s*\(`,
    'i',
  );
  return files.filter((f) => re.test(f.sql)).map((f) => f.file);
}

/**
 * The hosted chain's debt, pinned.
 *
 * Every name here is an object the server calls at runtime that
 * supabase/migrations never creates. The list is exact on purpose: add a
 * billing_v2 call the hosted chain cannot satisfy and this test fails; mirror
 * the substrate across and it fails too, telling you to delete the list. It is
 * a ratchet, not a permission slip.
 *
 * Fixing it is not a forward-only migration. The break is mid-chain — the
 * hosted file that first needs billing_v2_rollout is 20260904112112, and 118
 * files still follow it — so the repair has to sort before that, which means
 * back-dating a file into a history the production database has already
 * recorded as applied. That is a decision about production, not a refactor.
 */
const HOSTED_CHAIN_CANNOT_CREATE = [
  'billing_v2_activate',
  'billing_v2_audit',
  'billing_v2_claim_notification_jobs',
  'billing_v2_complete_notification_job',
  'billing_v2_current_entitlement_cycle',
  'billing_v2_dunning_metrics',
  'billing_v2_evaluate_cutover',
  'billing_v2_fail_notification_job',
  'billing_v2_issue_renewal_invoice',
  'billing_v2_policy',
  'billing_v2_policy_for',
  'billing_v2_rollout',
  'billing_v2_scheduler_health',
  'billing_v2_set_state',
  'billing_v2_wallet_deposit_config',
] as const;

describe('billing_v2 is reachable from the product, so neither chain may drop it', () => {
  describe('a customer reaches billing_v2_policy in six hops', () => {
    it('1. the router mounts the workspace billing page behind an admin guard', () => {
      const app = read('src', 'App.tsx');
      expect(app).toMatch(
        /<Route\s+path="billing"\s+element=\{<RequireWorkspaceAdmin><BillingPage\s*\/><\/RequireWorkspaceAdmin>\}\s*\/>/,
      );
      expect(app).toContain('import BillingPage from "@/pages/app/BillingPage"');
    });

    it('2. that page is the only customer billing experience, with no frontend fallback', () => {
      const page = read('src', 'pages', 'app', 'BillingPage.tsx');
      expect(page).toContain("import WorkspaceBillingPage from './billing/WorkspaceBillingPage'");
      // If a legacy/v1 branch ever reappears here, the claim below stops holding.
      expect(page).toMatch(/only customer-facing billing experience/i);
      expect(page).not.toMatch(/rollout_state|legacyBilling|billingV1/i);
    });

    it('3. its tabs fetch through one API client, rooted at /api/billing/workspaces', () => {
      const api = read('src', 'lib', 'billingApi.ts');
      expect(api).toContain('`/api/billing/workspaces/${workspaceId}`');
      for (const tab of ['WorkspaceBillingPage', 'OverviewTab', 'InvoicesTab', 'WalletTab']) {
        expect(read('src', 'pages', 'app', 'billing', `${tab}.tsx`), tab).toContain(
          "from '@/lib/billingApi'",
        );
      }
    });

    it('4. the server mounts billingCustomerRouter at exactly that prefix', () => {
      const index = read('server', 'index.ts');
      expect(index).toContain("app.use('/api/billing', billingCustomerRouter);");
      expect(index).toContain("import { billingCustomerRouter } from './routes/billingCustomer.js';");
    });

    it('5. that router builds its responses from the billing_v2 read model', () => {
      const route = read('server', 'routes', 'billingCustomer.ts');
      expect(route).toContain("from '../services/billing/customer/readModels.js'");
      expect(route).toMatch(/billingCustomerRouter\.get\('\/workspaces\/:workspaceId\/overview'/);
    });

    it('6. and the read model queries billing_v2_policy and billing_v2_policy_for', () => {
      const model = read('server', 'services', 'billing', 'customer', 'readModels.ts');
      expect(model).toContain(".from('billing_v2_policy')");
      expect(model).toContain("sb.rpc('billing_v2_policy_for'");
    });
  });

  describe('the schedulers and the rollout state machine reach it too', () => {
    it('rollout state is read from the table, never from the client', () => {
      const rollout = read('server', 'services', 'billing', 'rollout.ts');
      expect(rollout).toContain(".from('billing_v2_rollout')");
      expect(rollout).toContain(".from('billing_v2_audit')");
      // The comment at the top of the module states the invariant; assert the
      // code still matches it rather than trusting the prose.
      expect(rollout).toMatch(/SERVER-AUTHORITATIVE/);
    });

    it('all five workers report health through the scheduler RPCs', () => {
      const scheduler = read('server', 'services', 'billing', 'scheduler', 'index.ts');
      expect(scheduler).toContain("sb.rpc('billing_v2_scheduler_health')");
      for (const fn of [
        'billing_v2_run_invoice_scheduler',
        'billing_v2_run_wallet_autopay',
        'billing_v2_run_period_activation',
      ]) {
        expect(scheduler, fn).toContain(fn);
      }
    });

    it('the notification dispatcher claims and completes jobs through billing_v2 RPCs', () => {
      const dispatcher = read('server', 'services', 'billing', 'notifications', 'dispatcher.ts');
      expect(dispatcher).toContain("sb.rpc('billing_v2_claim_notification_jobs'");
      expect(dispatcher).toContain("sb.rpc('billing_v2_complete_notification_job'");
    });
  });

  describe('every billing_v2 object the server calls exists in the self-host chain', () => {
    const { tables, rpcs } = whatTheServerTouches();
    const files = chain(SELF_HOST);

    it('the scan finds the call sites at all (a silent zero would pass everything below)', () => {
      expect(tables.length).toBeGreaterThanOrEqual(3);
      expect(rpcs.length).toBeGreaterThanOrEqual(13);
    });

    it('every table', () => {
      const missing = tables.filter((t) => createsTable(files, t).length === 0);
      expect(missing).toEqual([]);
    });

    it('every RPC', () => {
      const missing = rpcs.filter((r) => createsFunction(files, r).length === 0);
      expect(missing).toEqual([]);
    });
  });

  describe('the hosted chain cannot, and its debt is pinned to this exact list', () => {
    const { tables, rpcs } = whatTheServerTouches();
    const files = chain(HOSTED);

    it('no more than the known gap — a new one is new debt', () => {
      const missing = [
        ...tables.filter((t) => createsTable(files, t).length === 0),
        ...rpcs.filter((r) => createsFunction(files, r).length === 0),
      ].sort();
      expect(missing).toEqual([...HOSTED_CHAIN_CANNOT_CREATE]);
    });

    it('the one it does create still creates it', () => {
      // billing_v2_resolve_billing_recipient is the single billing_v2 object
      // that reached supabase/migrations. It is the proof that the rest were
      // an omission rather than a deliberate hosted/self-host split.
      expect(createsFunction(files, 'billing_v2_resolve_billing_recipient').length).toBeGreaterThan(0);
      expect(HOSTED_CHAIN_CANNOT_CREATE).not.toContain('billing_v2_resolve_billing_recipient');
    });

    it('the break is mid-chain, which is why no forward-only migration fixes it', () => {
      const first = readdirSync(HOSTED)
        .filter((f) => f.endsWith('.sql'))
        .sort()
        .find((f) => /public\.billing_v2_rollout/i.test(readFileSync(join(HOSTED, f), 'utf8')));
      expect(first).toBe('20260904112112_f725a3bf-ff10-4de6-a2ff-36b65f5be182.sql');
      const after = readdirSync(HOSTED).filter((f) => f.endsWith('.sql') && f > first!);
      expect(after.length).toBeGreaterThan(100);
    });
  });
});
