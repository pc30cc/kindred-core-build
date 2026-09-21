/**
 * No migration may destroy financial data on its way past.
 *
 * 126_billing_unified.sql (and its hosted mirror 20260904112112) opened with a
 * loop that TRUNCATE ... CASCADE'd thirty-one financial tables — invoices and
 * their lines, payments, allocations, payment intents, wallet accounts and
 * ledger, subscription periods, entitlement cycles, allowance grants, the plan
 * change log, and the whole AI usage and settlement history. It was a one-time
 * development reset from a period when the install had no real customers, and
 * it stayed in the chain after that stopped being true.
 *
 * It was harmless where it ran and harmless on a fresh replay — applying the
 * 124 migrations before it to a pristine database leaves every one of those
 * tables empty, measured at zero rows — which is exactly why nobody noticed.
 * The only database it could ever affect is one holding real money: a restore,
 * a new environment seeded from a dump, a `db reset` pointed at the wrong
 * target. And TRUNCATE bypasses the append-only triggers on
 * billing_invoice_applications, billing_payment_allocations and
 * billing_wallet_ledger, so it would take the audit trail with it.
 *
 * Both blocks are gone. This keeps them gone, and keeps the next one out.
 *
 * A reset is still possible on purpose: admin_reset_billing_data() is
 * service_role-only, takes a confirmation argument and is called by an
 * operator, not by a migration. That is the distinction this file draws —
 * DEFINING such a function is fine, RUNNING the destruction as a migration
 * step is not.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const CHAINS = {
  'self-host (database/migrations)': join(process.cwd(), 'database', 'migrations'),
  'hosted (supabase/migrations)': join(process.cwd(), 'supabase', 'migrations'),
} as const;

/** Tables whose rows are money, or the audit trail of money. */
const FINANCIAL = [
  'billing_invoices',
  'billing_invoice_lines',
  'billing_invoice_applications',
  'billing_invoice_collections',
  'billing_payments',
  'billing_payment_intents',
  'billing_payment_allocations',
  'billing_wallet_accounts',
  'billing_wallet_deposits',
  'billing_wallet_ledger',
  'billing_subscription_periods',
  'billing_subscription_applications',
  'billing_entitlement_cycles',
  'billing_period_allowance_grants',
  'billing_notification_jobs',
  'billing_retention_signals',
  'billing_events',
  'plan_change_log',
  'workspace_ai_balance_lots',
  'ai_usage_events',
  'ai_runs',
  'ai_run_steps',
  'ai_run_settlements',
  'ai_billing_adjustments',
  'ai_billing_audit_log',
] as const;

function sqlFiles(dir: string): Array<{ file: string; sql: string }> {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((file) => ({ file, sql: readFileSync(join(dir, file), 'utf8') }));
}

/** Drop -- line comments, so prose about TRUNCATE is not mistaken for one. */
function code(sql: string): string {
  return sql
    .split('\n')
    .map((line) => {
      const i = line.indexOf('--');
      return i === -1 ? line : line.slice(0, i);
    })
    .join('\n');
}

/**
 * Split a migration into the SQL a bare `psql -f` would execute and the SQL
 * that only lives inside a function body. A CREATE FUNCTION whose body
 * truncates does nothing until somebody calls it; a statement at the top level
 * runs the moment the chain reaches the file. Only the latter is the hazard.
 */
function topLevel(sql: string): string {
  const body = code(sql);
  const out: string[] = [];
  let rest = body;
  // Remove every dollar-quoted block, named or bare, innermost-first.
  for (;;) {
    const open = /\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(rest);
    if (!open) break;
    const tag = open[0];
    const close = rest.indexOf(tag, open.index + tag.length);
    if (close === -1) break;
    out.push(rest.slice(0, open.index));
    rest = rest.slice(close + tag.length);
  }
  out.push(rest);
  return out.join('\n');
}

describe('no migration destroys financial data as it applies', () => {
  for (const [label, dir] of Object.entries(CHAINS)) {
    describe(label, () => {
      const files = sqlFiles(dir);

      it('reads a chain at all (an empty sweep would pass everything below)', () => {
        expect(files.length).toBeGreaterThan(100);
      });

      it('no top-level TRUNCATE, anywhere', () => {
        const offenders = files
          .filter((f) => /\bTRUNCATE\b/i.test(topLevel(f.sql)))
          .map((f) => f.file);
        expect(offenders).toEqual([]);
      });

      it('no top-level DELETE FROM a financial table', () => {
        const re = new RegExp(
          String.raw`\bDELETE\s+FROM\s+(?:public\.)?(${FINANCIAL.join('|')})\b`,
          'i',
        );
        const offenders = files.filter((f) => re.test(topLevel(f.sql))).map((f) => f.file);
        expect(offenders).toEqual([]);
      });

      it('no top-level DROP of a financial table', () => {
        const re = new RegExp(
          String.raw`\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:public\.)?(${FINANCIAL.join('|')})\b`,
          'i',
        );
        const offenders = files.filter((f) => re.test(topLevel(f.sql))).map((f) => f.file);
        expect(offenders).toEqual([]);
      });
    });
  }

  it('the deliberate reset still exists, and is still service_role-only', () => {
    const dir = CHAINS['hosted (supabase/migrations)'];
    const owner = sqlFiles(dir).find((f) =>
      /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.admin_reset_billing_data\s*\(/i.test(f.sql),
    );
    expect(owner, 'admin_reset_billing_data must survive this rule').toBeDefined();
    // Defined inside a function body, so the sweep above leaves it alone.
    expect(/\bTRUNCATE\b/i.test(topLevel(owner!.sql))).toBe(false);
    expect(owner!.sql).toMatch(
      /REVOKE\s+ALL\s+ON\s+FUNCTION\s+public\.admin_reset_billing_data\([^)]*\)\s+FROM\s+PUBLIC/i,
    );
    expect(owner!.sql).toMatch(
      /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.admin_reset_billing_data\([^)]*\)\s+TO\s+service_role/i,
    );
  });

  it('126 and its hosted mirror still do the work that was not destructive', () => {
    const selfHost = readFileSync(
      join(CHAINS['self-host (database/migrations)'], '126_billing_unified.sql'),
      'utf8',
    );
    const hosted = readFileSync(
      join(
        CHAINS['hosted (supabase/migrations)'],
        '20260904112112_f725a3bf-ff10-4de6-a2ff-36b65f5be182.sql',
      ),
      'utf8',
    );
    for (const [name, sql] of [
      ['126', selfHost],
      ['20260904112112', hosted],
    ] as const) {
      // Enrolment is the point of the migration and must not have been lost
      // along with the truncate that used to sit above it.
      expect(sql, name).toMatch(/INSERT INTO public\.billing_v2_rollout \(workspace_id, state\)/);
      expect(sql, name).toMatch(/CREATE TRIGGER trg_billing_enroll_workspace/);
      // And the removal is explained where the next reader will look.
      expect(sql, name).toMatch(/\(removed\) Reset all financial data/);
    }
  });
});
