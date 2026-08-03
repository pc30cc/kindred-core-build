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
import { readFileSync, readdirSync } from 'node:fs';

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

describe('supabase migration chain — dependency order', () => {
  const dir = 'supabase/migrations';
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

  /** Table name → first migration that creates it. */
  const created = new Map<string, string>();
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
    expect(origin! < '20260414134641').toBe(true);
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
    const sql = readFileSync(`${dir}/${file}`, 'utf8').replace(/--[^\n]*/g, '');

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

      for (const c of cols) {
        if (!state.has(c)) {
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
      const state = tables.get(m[1].toLowerCase());
      if (state && !state.has(m[2].toLowerCase())) {
        problems.push(`${file}: UPDATE ${m[1]} sets missing column "${m[2]}"`);
      }
    }
  }

  return { tables, problems, snapshots };
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

  // Negative control: the analyzer must genuinely detect the defect it was
  // written for. Without the pre-seed compatibility migration the chain is the
  // exact sequence that failed in CI (`column "is_active" ... does not exist`).
  it('detects the original email_templates defect when the compat step is absent', () => {
    const withoutCompat = files.filter(
      (f) => f !== '20260414134600_baseline_remote_only_tables.sql',
    );
    const broken = analyzeChain(dir, withoutCompat).problems;
    expect(
      broken.some((p) => p.includes('email_templates references missing column "is_active"')),
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
