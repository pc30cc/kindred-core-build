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
 * A reset was possible on purpose: admin_reset_billing_data() was
 * service_role-only, took a confirmation argument and was called by an
 * operator, not by a migration (268 removed it from the self-host chain with
 * the rest of billing v2; the hosted chain still defines it). That is the
 * distinction this file draws — DEFINING such a function is fine, RUNNING the
 * destruction as a migration step is not.
 *
 * Billing v2's records outlive billing v2. 267 moved what they still held
 * into simple billing (accounts and ledger); 268 moved the v2 tables
 * themselves, intact, into the schema billing_v2_archive (ALTER TABLE …
 * SET SCHEMA: nothing copied, nothing deleted) — invoices and tax, payments,
 * wallets, periods, and the log of the move. They are kept indefinitely: the
 * archive is the in-database backup, next to the dumps taken off the server
 * before 267 and 268 (docs/billing/SIMPLE_BILLING.md, phase 7). So:
 *
 *   - simple billing's tables (billing_accounts, billing_account_ledger,
 *     billing_account_payments, billing_account_cards) are financial too;
 *   - the rules match a financial table in billing_v2_archive as well as in
 *     public;
 *   - no migration, at the top level or inside a function body, drops the
 *     archive or a table in it, empties one (TRUNCATE, DELETE) or moves one
 *     out of it — removing it needs its own deliberate decision, not a line
 *     in a migration, and this rule then has to change with it;
 *   - a financial table leaves public only for billing_v2_archive.
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
  'billing_accounts',
  'billing_account_ledger',
  'billing_account_payments',
  'billing_account_cards',
  'billing_card_transfers',
  'billing_revenue_archive',
  'billing_ledger_archive',
] as const;

/**
 * 269's archives of the payments and ledger rows of deleted workspaces: what
 * keeps a closed month of the revenue report from changing. Append-only, and
 * written by their triggers alone; no migration drops, empties or renames
 * them, at the top level or inside a function body.
 */
const REVENUE_ARCHIVES = ['billing_revenue_archive', 'billing_ledger_archive'] as const;
const REVENUE_ARCHIVE_TABLE = String.raw`(?:"?public"?\.)?"?(?:${REVENUE_ARCHIVES.join('|')})"?\b`;
const REVENUE_ARCHIVE_DESTRUCTION = new RegExp(
  [
    String.raw`\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:[\w."%]+\s*,\s*)*${REVENUE_ARCHIVE_TABLE}`,
    String.raw`\bTRUNCATE\s+(?:TABLE\s+)?(?:ONLY\s+)?(?:[\w."%]+\s*,\s*)*${REVENUE_ARCHIVE_TABLE}`,
    String.raw`\bDELETE\s+FROM\s+(?:ONLY\s+)?${REVENUE_ARCHIVE_TABLE}`,
    String.raw`\bUPDATE\s+(?:ONLY\s+)?${REVENUE_ARCHIVE_TABLE}\s+SET\b`,
    String.raw`\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?${REVENUE_ARCHIVE_TABLE}\s+(?:SET\s+SCHEMA|RENAME|DROP\s+COLUMN|DISABLE\s+TRIGGER)\b`,
    String.raw`\bDROP\s+TRIGGER\s+(?:IF\s+EXISTS\s+)?trg_billing_(?:revenue|ledger)_archive_immutable\s+ON\s+${REVENUE_ARCHIVE_TABLE}(?![\s\S]{0,40}CREATE\s+TRIGGER\s+trg_billing_(?:revenue|ledger)_archive_immutable)`,
  ].join('|'),
  'i',
);

/** The schema 268 moved billing v2's tables into (kept indefinitely). */
const ARCHIVE = 'billing_v2_archive';
/** A table name as a migration writes it: bare, public., or the archive's, optionally quoted. */
const TABLE_PREFIX = String.raw`(?:"?(?:public|${ARCHIVE})"?\.)?"?`;

const ARCHIVE_SCHEMA = String.raw`"?${ARCHIVE}"?`;
/** Dropping, emptying or moving out the archive or a table in it. */
const ARCHIVE_DESTRUCTION = new RegExp(
  [
    String.raw`\bDROP\s+SCHEMA\s+(?:IF\s+EXISTS\s+)?(?:[\w"]+\s*,\s*)*${ARCHIVE_SCHEMA}\b`,
    String.raw`\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:[\w."%]+\s*,\s*)*${ARCHIVE_SCHEMA}\.`,
    String.raw`\bTRUNCATE\s+(?:TABLE\s+)?(?:ONLY\s+)?(?:[\w."%]+\s*,\s*)*${ARCHIVE_SCHEMA}\.`,
    String.raw`\bDELETE\s+FROM\s+(?:ONLY\s+)?${ARCHIVE_SCHEMA}\.`,
    String.raw`\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?${ARCHIVE_SCHEMA}\.[\w"%]+\s+(?:SET\s+SCHEMA|RENAME|DROP\s+COLUMN)\b`,
    String.raw`\bALTER\s+SCHEMA\s+${ARCHIVE_SCHEMA}\s+RENAME\b`,
  ].join('|'),
  'i',
);

/** Every `ALTER TABLE <financial> SET SCHEMA x` whose x is not the archive. */
function financialMovedElsewhere(sql: string): string[] {
  const re = new RegExp(
    String.raw`\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?${TABLE_PREFIX}(${FINANCIAL.join('|')})"?\s+SET\s+SCHEMA\s+("?\w+"?)`,
    'gi',
  );
  return [...sql.matchAll(re)].filter((m) => m[2].replace(/"/g, '').toLowerCase() !== ARCHIVE).map((m) => m[0]);
}

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
          String.raw`\bDELETE\s+FROM\s+(?:ONLY\s+)?${TABLE_PREFIX}(${FINANCIAL.join('|')})\b`,
          'i',
        );
        const offenders = files.filter((f) => re.test(topLevel(f.sql))).map((f) => f.file);
        expect(offenders).toEqual([]);
      });

      it('no top-level DROP of a financial table', () => {
        const re = new RegExp(
          String.raw`\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?${TABLE_PREFIX}(${FINANCIAL.join('|')})\b`,
          'i',
        );
        const offenders = files.filter((f) => re.test(topLevel(f.sql))).map((f) => f.file);
        expect(offenders).toEqual([]);
      });

      it('nothing drops, empties or moves out the billing v2 archive — not even inside a function body', () => {
        // code() keeps function bodies: a function that would do it is refused too.
        const offenders = files.filter((f) => ARCHIVE_DESTRUCTION.test(code(f.sql))).map((f) => f.file);
        expect(offenders).toEqual([]);
      });

      it('nothing drops, empties, rewrites or renames the revenue archives (269) — not even inside a function body', () => {
        const offenders = files.filter((f) => REVENUE_ARCHIVE_DESTRUCTION.test(code(f.sql))).map((f) => f.file);
        expect(offenders).toEqual([]);
      });

      it('a financial table leaves public only for the billing v2 archive', () => {
        const offenders = files.flatMap((f) => financialMovedElsewhere(code(f.sql)).map((m) => `${f.file}: ${m}`));
        expect(offenders).toEqual([]);
      });
    });
  }

  it('the archive rules catch what they are for, and leave 268 alone', () => {
    for (const sql of [
      'DROP SCHEMA billing_v2_archive CASCADE;',
      'DROP SCHEMA IF EXISTS other, "billing_v2_archive";',
      'DROP TABLE billing_v2_archive.billing_invoices;',
      'drop table if exists public.x, billing_v2_archive.migration_log;',
      'TRUNCATE billing_v2_archive.billing_payments;',
      'DELETE FROM billing_v2_archive.billing_wallet_ledger WHERE true;',
      'ALTER TABLE billing_v2_archive.billing_invoices SET SCHEMA public;',
      "EXECUTE format('DROP TABLE billing_v2_archive.%I', r.relname);",
      'ALTER SCHEMA billing_v2_archive RENAME TO gone;',
    ]) {
      expect(ARCHIVE_DESTRUCTION.test(sql), sql).toBe(true);
    }
    for (const sql of [
      'CREATE SCHEMA IF NOT EXISTS billing_v2_archive;',
      'ALTER TABLE public.billing_invoices SET SCHEMA billing_v2_archive;',
      'INSERT INTO billing_v2_archive.migration_log (source_table) VALUES ($1);',
      'REVOKE ALL ON TABLE billing_v2_archive.migration_log FROM PUBLIC;',
    ]) {
      expect(ARCHIVE_DESTRUCTION.test(sql), sql).toBe(false);
    }
    expect(financialMovedElsewhere('ALTER TABLE public.billing_invoices SET SCHEMA billing_v2_archive;')).toEqual([]);
    expect(financialMovedElsewhere('ALTER TABLE billing_account_ledger SET SCHEMA scratch;')).toHaveLength(1);
    expect(financialMovedElsewhere('ALTER TABLE IF EXISTS public."billing_payments" SET SCHEMA old;')).toHaveLength(1);
    const sql268 = readFileSync(
      join(CHAINS['self-host (database/migrations)'], '268_billing_v2_archive.sql'),
      'utf8',
    );
    expect(sql268).toMatch(/ALTER TABLE public\.%I SET SCHEMA billing_v2_archive/);
    expect(ARCHIVE_DESTRUCTION.test(code(sql268))).toBe(false);
  });

  it('the revenue archive rule catches what it is for, and leaves 269 alone', () => {
    for (const sql of [
      'DROP TABLE public.billing_revenue_archive;',
      'drop table if exists x, billing_ledger_archive;',
      'TRUNCATE billing_revenue_archive;',
      'TRUNCATE TABLE public.x, public."billing_ledger_archive";',
      'DELETE FROM public.billing_revenue_archive WHERE true;',
      'UPDATE public.billing_ledger_archive SET amount_minor = 0;',
      'ALTER TABLE public.billing_revenue_archive RENAME TO gone;',
      'ALTER TABLE billing_ledger_archive DISABLE TRIGGER ALL;',
      'DROP TRIGGER IF EXISTS trg_billing_revenue_archive_immutable ON public.billing_revenue_archive;',
    ]) {
      expect(REVENUE_ARCHIVE_DESTRUCTION.test(sql), sql).toBe(true);
    }
    for (const sql of [
      'CREATE TABLE IF NOT EXISTS public.billing_revenue_archive (payment_id uuid PRIMARY KEY);',
      'INSERT INTO public.billing_revenue_archive (payment_id) VALUES ($1) ON CONFLICT (payment_id) DO NOTHING;',
      'SELECT a.currency FROM public.billing_ledger_archive a;',
      'REVOKE ALL ON public.billing_revenue_archive FROM service_role;',
      'DELETE FROM public.billing_account_payments WHERE id = $1;',
    ]) {
      expect(REVENUE_ARCHIVE_DESTRUCTION.test(sql), sql).toBe(false);
    }
    const sql269 = readFileSync(
      join(CHAINS['self-host (database/migrations)'], '269_billing_revenue_archive.sql'),
      'utf8',
    );
    expect(sql269).toMatch(/CREATE TRIGGER trg_billing_revenue_archive_immutable/);
    expect(REVENUE_ARCHIVE_DESTRUCTION.test(code(sql269))).toBe(false);
  });

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
