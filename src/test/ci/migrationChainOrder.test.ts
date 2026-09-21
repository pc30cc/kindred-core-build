/**
 * CI hotfix integrity tests.
 *
 * 1. The self-host Auth bootstrap must pass the UNPREFIXED `API_EXTERNAL_URL`
 *    that the official GoTrue image requires (`GOTRUE_API_EXTERNAL_URL` is
 *    NOT accepted and must never be substituted).
 * 2. `supabase/migrations` must be self-contained in timestamp order: a table
 *    may not be ALTERed, policied, triggered or inserted into before the
 *    migration that first creates it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const WORKFLOW = '.github/workflows/ci.yml';

describe('self-host GoTrue bootstrap', () => {
  const yml = readFileSync(WORKFLOW, 'utf8');

  it('passes the unprefixed API_EXTERNAL_URL', () => {
    expect(yml).toContain('API_EXTERNAL_URL=http://localhost:9999');
  });

  it('never substitutes GOTRUE_API_EXTERNAL_URL', () => {
    expect(yml).not.toContain('GOTRUE_API_EXTERNAL_URL');
  });

  it('keeps the rest of the documented bootstrap environment', () => {
    for (const v of [
      'GOTRUE_API_HOST=localhost',
      'PORT=9999',
      'GOTRUE_SITE_URL=http://localhost:3000',
    ]) {
      expect(yml).toContain(v);
    }
  });
});

/**
 * `supabase/migrations` is not, and has never been, a chain that starts from
 * an empty database. The billing tables it truncates, inserts into and
 * alters — billing_invoices, billing_v2_rollout, billing_v2_audit and the
 * rest — are created in `database/migrations` (113_billing_v2_core.sql and
 * its neighbours) and are already present in the hosted project. No
 * migration in the hosted directory creates them, and none ever did.
 *
 * Read as "self-contained", the guard reported nineteen ordering violations
 * for statements that have all applied cleanly in production. What it can
 * honestly enforce is narrower and still worth having: a hosted migration
 * may not reference a table that NOTHING in this repository creates, and it
 * may not get the order wrong for a table the hosted chain creates itself.
 * So the self-host chain is read first, as the baseline the hosted chain
 * sits on.
 */
const SELF_HOST_DIR = 'database/migrations';

function selfHostSql(): string[] {
  return readdirSync(SELF_HOST_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => readFileSync(`${SELF_HOST_DIR}/${f}`, 'utf8').replace(/--[^\n]*/g, ''));
}

/** Every table the self-host chain creates — the hosted chain's baseline. */
function baselineTables(): Set<string> {
  const out = new Set<string>();
  for (const sql of selfHostSql()) {
    for (const m of sql.matchAll(
      /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?"?([a-z0-9_]+)"?/gi,
    )) {
      out.add(m[1].toLowerCase());
    }
  }
  return out;
}

/**
 * table → columns the self-host chain declares or adds, by any route.
 * Built on first use: the parsing helpers it leans on are declared further
 * down this file, so computing it eagerly would read them before init.
 */
let selfHostColumnsMemo: Map<string, Set<string>> | null = null;
function selfHostColumns(): Map<string, Set<string>> {
  return (selfHostColumnsMemo ??= baselineColumns());
}

function baselineColumns(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const put = (table: string, col: string) => {
    const key = table.toLowerCase();
    if (!out.has(key)) out.set(key, new Set());
    out.get(key)!.add(col.toLowerCase());
  };
  for (const sql of selfHostSql()) {
    for (const m of sql.matchAll(
      /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?"?([a-z0-9_]+)"?\s*\(/gi,
    )) {
      const body = balanced(sql, m.index! + m[0].length - 1);
      for (const raw of splitTopLevel(body)) {
        if (CONSTRAINT_START.test(raw)) continue;
        const name = raw.match(/^"?([a-z0-9_]+)"?/i)?.[1];
        if (name) put(m[1], name);
      }
    }
    for (const m of sql.matchAll(
      /ALTER\s+TABLE\s+(?:ONLY\s+)?(?:IF\s+EXISTS\s+)?(?:public\.)?"?([a-z0-9_]+)"?([\s\S]*?);/gi,
    )) {
      for (const a of m[2].matchAll(
        /ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([a-z0-9_]+)"?/gi,
      )) {
        put(m[1], a[1]);
      }
    }
  }
  return out;
}

describe('supabase migration chain — dependency order', () => {
  const dir = 'supabase/migrations';
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

  /** Table name → first migration that creates it. */
  const created = new Map<string, string>();
  // Present before the first file in this directory runs; see baselineTables.
  const BASELINE = '<self-host chain>';
  for (const t of baselineTables()) created.set(t, BASELINE);
  /** Offences: a table used before any migration created it. */
  const violations: string[] = [];

  for (const file of files) {
    const sql = readFileSync(`${dir}/${file}`, 'utf8').replace(/--[^\n]*/g, '');

    for (const m of sql.matchAll(
      /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?"?([a-z0-9_]+)"?/gi,
    )) {
      const t = m[1].toLowerCase();
      if (!created.has(t)) created.set(t, file);
    }

    const refs: Array<[RegExp, string]> = [
      [/ALTER\s+TABLE\s+(?:ONLY\s+)?(?:IF\s+EXISTS\s+)?public\.([a-z0-9_]+)/gi, 'ALTER TABLE'],
      [/CREATE\s+POLICY[^;]*?\sON\s+(?:public\.)?([a-z0-9_"]+)/gi, 'CREATE POLICY'],
      [/CREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER[^;]*?\sON\s+public\.([a-z0-9_]+)/gi, 'CREATE TRIGGER'],
      [/INSERT\s+INTO\s+public\.([a-z0-9_]+)/gi, 'INSERT INTO'],
    ];

    for (const [re, kind] of refs) {
      for (const m of sql.matchAll(re)) {
        const t = m[1].replace(/"/g, '').toLowerCase();
        if (!created.has(t)) violations.push(`${file}: ${kind} public.${t} before its creation`);
      }
    }
  }

  it('creates public.platform_settings before its first ALTER', () => {
    const origin = created.get('platform_settings');
    expect(origin).toBeDefined();
    // Either a hosted migration creates it early enough, or it is already
    // there because the self-host chain did — which is what BASELINE means
    // and, since 100a, is the case.
    expect(origin === BASELINE || origin! < '20260414134641').toBe(true);
  });

  it('creates public.workspace_domains_extended before its first policy', () => {
    const origin = created.get('workspace_domains_extended');
    expect(origin).toBeDefined();
    expect(origin! < '20260415082424').toBe(true);
  });

  it('never references a table before the migration that creates it', () => {
    expect(violations).toEqual([]);
  });
});

describe('self-host migration chain — dependency order', () => {
  // The same walk the hosted chain gets above, over `database/migrations`.
  //
  // It was never run here, and six tables went missing because of it:
  // workspace_usage_counters, call_center_settings, platform_branding,
  // billing_payments, platform_settings and plan_change_log were altered,
  // inserted into and read by this chain and created by none of it. A real
  // install stopped at 101 on `relation "public.call_center_settings" does
  // not exist`; the integration suite did not, because its fixture created
  // three of the six itself.
  //
  // The baseline here is empty on purpose. The hosted chain may lean on this
  // one — that is what `baselineTables()` above is for — but this chain runs
  // against a database holding nothing but the `auth` schema GoTrue brings,
  // so `public` starts bare and every table it touches must be its own.
  const dir = 'database/migrations';
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

  const created = new Map<string, string>();
  const violations: string[] = [];

  for (const file of files) {
    const sql = readFileSync(`${dir}/${file}`, 'utf8').replace(/--[^\n]*/g, '');

    for (const m of sql.matchAll(
      /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?"?([a-z0-9_]+)"?/gi,
    )) {
      const t = m[1].toLowerCase();
      if (!created.has(t)) created.set(t, file);
    }

    // Only the forms that fail at apply time. A reference inside a plpgsql
    // body resolves when the function is called, not when it is created —
    // 016a reaches workspace_usage_counters that way and applied cleanly for
    // as long as nobody ended a call.
    const refs: Array<[RegExp, string]> = [
      [/ALTER\s+TABLE\s+(?:ONLY\s+)?(?:IF\s+EXISTS\s+)?public\.([a-z0-9_]+)/gi, 'ALTER TABLE'],
      [/CREATE\s+POLICY[^;]*?\sON\s+(?:public\.)?([a-z0-9_"]+)/gi, 'CREATE POLICY'],
      [/CREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER[^;]*?\sON\s+public\.([a-z0-9_]+)/gi, 'CREATE TRIGGER'],
    ];

    for (const [re, kind] of refs) {
      for (const m of sql.matchAll(re)) {
        const t = m[1].replace(/"/g, '').toLowerCase();
        if (!created.has(t)) violations.push(`${file}: ${kind} public.${t} before its creation`);
      }
    }
  }

  it('creates the hosted-parity tables before anything alters them', () => {
    for (const [table, firstUser] of [
      ['call_center_settings', '101'],
      ['platform_branding', '104'],
      ['billing_payments', '105'],
      ['user_notification_prefs', '136'],
      ['platform_settings', '152'],
      ['plan_change_log', '154'],
    ] as const) {
      const origin = created.get(table);
      expect(origin, `${table} is created by no migration in this chain`).toBeDefined();
      expect(
        origin! < firstUser,
        `${table} is created by ${origin}, after ${firstUser} already uses it`,
      ).toBe(true);
    }
  });

  it('creates workspace_usage_counters, which only a function body reaches', () => {
    // 016a increments this table from inside plpgsql, so it resolves at call
    // time and the walk above cannot see it. That is precisely why it stayed
    // missing: the chain applied clean and the first operator to end a call
    // got the error instead.
    expect(created.get('workspace_usage_counters')).toBeDefined();
  });

  it('never references a table before the migration that creates it', () => {
    expect(violations).toEqual([]);
  });
});

describe('workspace invitation v5.1 cutover packaging', () => {
  it('keeps fence and irreversible contract ordered outside normal migrations', () => {
    const cutover = readdirSync('database/cutover').filter((f) => f.endsWith('.sql')).sort();
    expect(cutover).toContain('080_workspace_invitations_v51_fence.sql');
    expect(cutover).toContain('081_workspace_invitations_v51_contract.sql');
    expect(cutover.indexOf('080_workspace_invitations_v51_fence.sql'))
      .toBeLessThan(cutover.indexOf('081_workspace_invitations_v51_contract.sql'));
    const normal = readdirSync('database/migrations');
    expect(normal).not.toContain('080_workspace_invitations_v51_fence.sql');
    expect(normal).not.toContain('081_workspace_invitations_v51_contract.sql');
  });

  it('documents the manual fence and contract sequence', () => {
    const deployment = readFileSync('DEPLOYMENT.md', 'utf8');
    expect(deployment).toContain('080_workspace_invitations_v51_fence.sql');
    expect(deployment).toContain('081_workspace_invitations_v51_contract.sql');
  });
});

/* ------------------------------------------------------------------ *
 * Column-level contract analyzer.
 *
 * A table-name-only check cannot catch the class of failure that broke the
 * hosted chain (`column "is_active" of relation "email_templates" does not
 * exist`, then `workspace_id` violating NOT NULL). This walks the chain in
 * timestamp order, tracks each table's columns and nullability, and fails when
 * a later statement references a column that does not exist yet or supplies
 * NULL to a column that is still NOT NULL.
 * ------------------------------------------------------------------ */

interface ColumnState {
  notNull: boolean;
  hasDefault: boolean;
}
type TableState = Map<string, ColumnState>;

/** Splits on top-level commas, honouring nested parens and single quotes. */
function splitTopLevel(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quoted = false;
  let current = '';
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (quoted) {
      current += ch;
      if (ch === "'") quoted = body[i + 1] === "'" ? (current += body[++i], true) : false;
      continue;
    }
    if (ch === "'") {
      quoted = true;
      current += ch;
      continue;
    }
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      out.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

/** Returns the balanced parenthesised block starting at `open`. */
function balanced(sql: string, open: number): string {
  let depth = 0;
  let quoted = false;
  for (let i = open; i < sql.length; i += 1) {
    const ch = sql[i];
    if (quoted) {
      if (ch === "'") quoted = false;
      continue;
    }
    if (ch === "'") quoted = true;
    else if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return sql.slice(open + 1, i);
    }
  }
  return '';
}

const CONSTRAINT_START =
  /^(constraint|primary\s+key|unique|foreign\s+key|check|exclude|like)\b/i;

export function analyzeChain(dir: string, files: string[]) {
  const tables = new Map<string, TableState>();
  const problems: string[] = [];
  /** file → snapshot of email_templates, for the explicit regressions below. */
  const snapshots = new Map<string, TableState>();

  for (const file of files) {
    const sql = withoutDynamicSql(
      readFileSync(`${dir}/${file}`, 'utf8').replace(/--[^\n]*/g, ''),
    );

    // --- CREATE TABLE ---
    for (const m of sql.matchAll(
      /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?"?([a-z0-9_]+)"?\s*\(/gi,
    )) {
      const table = m[1].toLowerCase();
      if (tables.has(table)) continue;
      const body = balanced(sql, m.index! + m[0].length - 1);
      const state: TableState = new Map();
      for (const raw of splitTopLevel(body)) {
        if (CONSTRAINT_START.test(raw)) continue;
        const name = raw.match(/^"?([a-z0-9_]+)"?/i)?.[1]?.toLowerCase();
        if (!name) continue;
        state.set(name, {
          notNull: /\bNOT\s+NULL\b/i.test(raw) || /\bPRIMARY\s+KEY\b/i.test(raw),
          hasDefault: /\bDEFAULT\b/i.test(raw),
        });
      }
      tables.set(table, state);
    }

    // --- ALTER TABLE column operations ---
    for (const m of sql.matchAll(
      /ALTER\s+TABLE\s+(?:ONLY\s+)?(?:IF\s+EXISTS\s+)?(?:public\.)?"?([a-z0-9_]+)"?([\s\S]*?);/gi,
    )) {
      const state = tables.get(m[1].toLowerCase());
      if (!state) continue;
      const actions = m[2];
      for (const a of actions.matchAll(
        /ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([a-z0-9_]+)"?([^,;]*)/gi,
      )) {
        state.set(a[1].toLowerCase(), {
          notNull: /\bNOT\s+NULL\b/i.test(a[2]),
          hasDefault: /\bDEFAULT\b/i.test(a[2]),
        });
      }
      for (const a of actions.matchAll(
        /DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?"?([a-z0-9_]+)"?/gi,
      )) {
        state.delete(a[1].toLowerCase());
      }
      for (const a of actions.matchAll(
        /RENAME\s+COLUMN\s+"?([a-z0-9_]+)"?\s+TO\s+"?([a-z0-9_]+)"?/gi,
      )) {
        const prev = state.get(a[1].toLowerCase());
        if (prev) {
          state.delete(a[1].toLowerCase());
          state.set(a[2].toLowerCase(), prev);
        }
      }
      for (const a of actions.matchAll(
        /ALTER\s+(?:COLUMN\s+)?"?([a-z0-9_]+)"?\s+(SET|DROP)\s+NOT\s+NULL/gi,
      )) {
        const col = state.get(a[1].toLowerCase());
        if (col) col.notNull = a[2].toUpperCase() === 'SET';
      }
      for (const a of actions.matchAll(
        /ALTER\s+(?:COLUMN\s+)?"?([a-z0-9_]+)"?\s+(SET|DROP)\s+DEFAULT/gi,
      )) {
        const col = state.get(a[1].toLowerCase());
        if (col) col.hasDefault = a[2].toUpperCase() === 'SET';
      }
    }

    snapshots.set(file, new Map([...(tables.get('email_templates') ?? new Map())]));

    // --- INSERT column lists (+ NULL vs NOT NULL on the first VALUES row) ---
    for (const m of sql.matchAll(
      /INSERT\s+INTO\s+(?:public\.)?"?([a-z0-9_]+)"?\s*\(/gi,
    )) {
      const table = m[1].toLowerCase();
      const state = tables.get(table);
      if (!state) continue;
      const listStart = m.index! + m[0].length - 1;
      const cols = splitTopLevel(balanced(sql, listStart)).map((c) =>
        c.replace(/"/g, '').trim().toLowerCase(),
      );
      if (cols.some((c) => !/^[a-z0-9_]+$/.test(c))) continue; // not a column list

      // A column the hosted chain never declared is only a problem if the
      // self-host chain does not declare it either — workspace_subscriptions
      // is created here but gains current_period_id, next_invoice_at and
      // billing_engine_version over there. Nullability below stays purely
      // hosted-chain-driven, since that is the only side whose declarations
      // this scanner has read.
      const alsoInSelfHost = selfHostColumns().get(table);
      for (const c of cols) {
        if (!state.has(c) && !alsoInSelfHost?.has(c)) {
          problems.push(`${file}: INSERT INTO ${table} references missing column "${c}"`);
        }
      }

      const rest = sql.slice(listStart);
      const valuesAt = rest.search(/\bVALUES\s*\(/i);
      if (valuesAt === -1) continue;
      const tupleOpen = listStart + rest.indexOf('(', valuesAt);
      const values = splitTopLevel(balanced(sql, tupleOpen));
      if (values.length !== cols.length) continue;
      cols.forEach((c, i) => {
        const col = state.get(c);
        if (col?.notNull && /^null$/i.test(values[i].trim())) {
          problems.push(`${file}: INSERT INTO ${table} supplies NULL to NOT NULL column "${c}"`);
        }
      });
    }

    // --- UPDATE ... SET column names ---
    for (const m of sql.matchAll(
      /UPDATE\s+(?:public\.)?"?([a-z0-9_]+)"?\s+SET\s+([a-z0-9_]+)\s*=/gi,
    )) {
      const table = m[1].toLowerCase();
      const state = tables.get(table);
      const col = m[2].toLowerCase();
      if (state && !state.has(col) && !selfHostColumns().get(table)?.has(col)) {
        problems.push(`${file}: UPDATE ${m[1]} sets missing column "${m[2]}"`);
      }
    }
  }

  return { tables, problems, snapshots };
}


/**
 * Blank out the inside of `EXECUTE '...'` strings.
 *
 * A statement built at runtime is not a static reference to a column, and in
 * this chain it is usually the opposite: the one place that deliberately
 * tolerates a column being absent. billing_v2_grant_cycle_allowance checks
 * information_schema for workspace_ai_balance_lots.metadata and only then
 * EXECUTEs an UPDATE naming it, precisely because the column exists in the
 * self-host chain and not in the hosted one. Reading that quoted text as a
 * real UPDATE reports a break that cannot happen.
 *
 * Only the string contents go; the quotes and the surrounding statement stay,
 * so offsets and the rest of the scan are unaffected.
 */
function withoutDynamicSql(sql: string): string {
  return sql.replace(/\bEXECUTE\s+'((?:[^']|'')*)'/gi, (whole, body: string) =>
    whole.replace(body, ' '.repeat(body.length)),
  );
}

describe('supabase migration chain — column contract', () => {
  const dir = 'supabase/migrations';
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const { problems, snapshots } = analyzeChain(dir, files);

  const preSeed = files.filter((f) => f < '20260414135136').at(-1)!;

  it('has email_templates.is_active before the seed migration', () => {
    expect(snapshots.get(preSeed)?.has('is_active')).toBe(true);
  });

  it('has a nullable email_templates.workspace_id before the seed migration', () => {
    expect(snapshots.get(preSeed)?.get('workspace_id')?.notNull).toBe(false);
  });

  it('never references a column, or violates nullability, before it is valid', () => {
    expect(problems).toEqual([]);
  });

  // Negative control, first half: the compat migration is what puts
  // email_templates.is_active into THIS chain. Remove it and the column is
  // absent from every snapshot the hosted chain produces — which is the
  // defect that failed in CI (`column "is_active" ... does not exist`).
  //
  // This used to assert through `problems`, and can't any more: the column
  // is also declared in database/migrations/015, so the seed is not in fact
  // reaching for something no migration in the repository declares. The
  // analyzer's detection of that shape is proved below on a chain where the
  // column really is declared nowhere.
  it('the compat step is what puts email_templates.is_active in this chain', () => {
    const withoutCompat = files.filter(
      (f) => f !== '20260414134600_baseline_remote_only_tables.sql',
    );
    const broken = analyzeChain(dir, withoutCompat);
    const seen = [...broken.snapshots.values()].some((snap) => snap.has('is_active'));
    expect(seen).toBe(false);
    // …and with it, the column is there.
    expect(snapshots.get(preSeed)?.has('is_active')).toBe(true);
  });

  // Negative control, second half: the same defect shape on a chain of its
  // own, where the column is declared in neither chain, so nothing can
  // excuse it.
  it('detects an INSERT naming a column no migration declares', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'chain-col-'));
    writeFileSync(
      join(tmp, '0001_create.sql'),
      'CREATE TABLE public.demo_templates (id uuid PRIMARY KEY, slug text);',
    );
    writeFileSync(
      join(tmp, '0002_seed.sql'),
      "INSERT INTO public.demo_templates (slug, is_active) VALUES ('a', true);",
    );
    const { problems: bad } = analyzeChain(tmp, ['0001_create.sql', '0002_seed.sql']);
    expect(
      bad.some((p) => p.includes('demo_templates references missing column "is_active"')),
    ).toBe(true);
  });

  // Second negative control: a seed supplying NULL to a still-NOT NULL column
  // must fail too, proving the nullability tracking is not vacuous.
  it('detects NULL supplied to a NOT NULL column', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'chain-'));
    writeFileSync(
      join(tmp, '0001_create.sql'),
      'CREATE TABLE public.demo (id uuid PRIMARY KEY, workspace_id uuid NOT NULL, slug text NOT NULL);',
    );
    writeFileSync(
      join(tmp, '0002_seed.sql'),
      "INSERT INTO public.demo (workspace_id, slug) VALUES (NULL, 'a');",
    );
    const { problems: bad } = analyzeChain(tmp, ['0001_create.sql', '0002_seed.sql']);
    expect(
      bad.some((p) => p.includes('demo supplies NULL to NOT NULL column "workspace_id"')),
    ).toBe(true);
  });
});
