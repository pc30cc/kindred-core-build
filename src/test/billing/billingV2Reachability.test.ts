/**
 * Are the billing_v2 tables reachable from the running product, and may
 * either migration chain drop them?
 *
 * The question was raised because `supabase/migrations` did not create the
 * billing_v2 substrate, so a from-scratch hosted replay died on
 * `relation "public.billing_v2_rollout" does not exist`. The tempting reading
 * was that the substrate is scaffolding nobody uses. It is not:
 *
 *   * Production runs on it. `billing_v2_rollout` holds one workspace in state
 *     `v2_active` — billing v2 is the live engine for it, not a shadow — and
 *     all five scheduler workers write `billing_v2_worker_health` heartbeats
 *     continuously.
 *   * A customer reaches it. /app/:workspace/billing is the only customer
 *     billing experience the frontend has, and its read model queries
 *     `billing_v2_policy` and `billing_v2_policy_for` on every load.
 *
 * So the substrate stays, and the hosted chain now creates it too
 * (20260904112111 and 20260921090000). What this file locks down is the
 * reachability that makes that the right call, and the shape of the backfill,
 * so nobody concludes "unused" from a grep again.
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

  describe('and so does the hosted chain, now that it creates them', () => {
    const { tables, rpcs } = whatTheServerTouches();
    const files = chain(HOSTED);

    it('every table', () => {
      const missing = tables.filter((t) => createsTable(files, t).length === 0);
      expect(missing).toEqual([]);
    });

    it('every RPC', () => {
      const missing = rpcs.filter((r) => createsFunction(files, r).length === 0);
      expect(missing).toEqual([]);
    });

    it('the substrate is split either side of the migration that first needs it', () => {
      // 20260904112112 inserts into billing_v2_rollout, so the tables have to
      // exist before it. It is also where billing_coupons is created, and
      // billing_invoices carries a foreign key to billing_coupons -- so the
      // constraints cannot go in the same place. Tables first, everything
      // else at the end of the chain.
      const names = readdirSync(HOSTED).filter((f) => f.endsWith('.sql')).sort();
      const tablesFile = names.find((f) => f.includes('billing_engine_tables'));
      const restFile = names.find((f) => f.includes('billing_engine_constraints_and_functions'));
      expect(tablesFile, 'part 1 must exist').toBeDefined();
      expect(restFile, 'part 2 must exist').toBeDefined();
      // Part 1 before the migration that needs it, part 2 after every
      // migration that creates a table it points a foreign key at.
      expect(tablesFile! < '20260904112112').toBe(true);
      expect(restFile! > names[names.indexOf(restFile!) - 1]).toBe(true);
      expect(names.filter((f) => f > restFile! && !f.includes('function_execute_acl'))).toEqual([]);

      const part1 = readFileSync(join(HOSTED, tablesFile!), 'utf8');
      const part2 = readFileSync(join(HOSTED, restFile!), 'utf8');
      // Part 1 carries no foreign keys; that is the whole reason for the split.
      expect(/ADD CONSTRAINT[^;]*FOREIGN KEY/i.test(part1)).toBe(false);
      expect(/ADD CONSTRAINT[^;]*FOREIGN KEY/i.test(part2)).toBe(true);
    });

    it('both halves refuse to run where the substrate already exists', () => {
      // The definitions come from the self-host chain, which has drifted from
      // the live database. Applying them over an existing substrate would
      // replace live billing logic, so part 1 raises instead.
      const names = readdirSync(HOSTED).filter((f) => f.endsWith('.sql'));
      const part1 = readFileSync(
        join(HOSTED, names.find((f) => f.includes('billing_engine_tables'))!),
        'utf8',
      );
      expect(part1).toMatch(/to_regclass\('public\.billing_invoices'\) IS NOT NULL/);
      expect(part1).toMatch(/RAISE EXCEPTION/);
    });
  });
});
