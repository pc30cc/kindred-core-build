/**
 * An in-memory stand-in for the service client (the PostgREST-style chain the
 * server code calls), for the after-chat features' tests: the closed line,
 * the rating and the transcript by email. Enough of the chain for those
 * services and the widget routes around them: select (with a head count),
 * eq / neq / in / gte / lte / is / contains filters, order, limit, single /
 * maybeSingle, insert (… select().single()), update and upsert.
 *
 * `missing` tables answer 42P01 (a database before migration 276), `failing`
 * ones a plain error; `conversation_ratings.closed_message_id` is unique
 * (23505), as in 276.
 */
import { randomUUID } from 'node:crypto';

export type Row = Record<string, unknown>;

export interface FakeServiceDb {
  tables: Record<string, Row[]>;
  missing: Set<string>;
  failing: Set<string>;
  inserts: Array<{ table: string; row: Row }>;
  reads: string[];
  /** The clock rows are stamped with (ISO). */
  now: () => string;
  /** Runs before each inserted row is checked and stored (a racing writer). */
  beforeInsert?: (table: string, row: Row) => void;
}

const UNIQUE: Record<string, string[]> = { conversation_ratings: ['closed_message_id'] };

export function createFakeServiceDb(): FakeServiceDb {
  return { tables: {}, missing: new Set(), failing: new Set(), inserts: [], reads: [], now: () => new Date().toISOString() };
}

function contains(value: unknown, subset: Record<string, unknown>): boolean {
  if (!value || typeof value !== 'object') return false;
  return Object.entries(subset).every(([k, v]) => (value as Row)[k] === v);
}

function missingError(table: string) {
  return { code: '42P01', message: `relation "public.${table}" does not exist`, details: null };
}

export function fakeServiceClient(db: FakeServiceDb) {
  function builder(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let sort: { col: string; asc: boolean } | null = null;
    let max = Infinity;
    let head = false;
    let counting = false;
    let mode: 'select' | 'insert' | 'update' | 'upsert' = 'select';
    let payload: Row[] = [];
    let patch: Row = {};
    let returning = false;

    const error = () => (db.missing.has(table) ? missingError(table)
      : db.failing.has(table) ? { code: 'XX000', message: `${table} unavailable`, details: null } : null);
    const matching = () => {
      let rows = (db.tables[table] || []).filter((r) => filters.every((f) => f(r)));
      if (sort) {
        const { col, asc } = sort;
        rows = rows.slice().sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : String(a[col]) > String(b[col]) ? 1 : 0) * (asc ? 1 : -1));
      }
      return rows.slice(0, max);
    };

    function run(): { data: unknown; error: unknown; count?: number | null } {
      const err = error();
      if (err) return { data: null, error: err, count: null };
      if (mode === 'select') {
        db.reads.push(table);
        if (head) return { data: null, error: null, count: matching().length };
        const rows = matching();
        return { data: rows.map((r) => ({ ...r })), error: null, count: counting ? rows.length : null };
      }
      if (mode === 'insert' || mode === 'upsert') {
        const list = (db.tables[table] ||= []);
        const out: Row[] = [];
        for (const raw of payload) {
          db.beforeInsert?.(table, raw);
          for (const col of UNIQUE[table] || []) {
            if (list.some((r) => r[col] === raw[col])) {
              return {
                data: null,
                error: { code: '23505', message: `duplicate key value violates unique constraint "${table}_${col}"`, details: null },
              };
            }
          }
          const row: Row = { id: randomUUID(), created_at: db.now(), ...raw };
          list.push(row);
          db.inserts.push({ table, row });
          out.push({ ...row });
        }
        return { data: returning ? out : null, error: null };
      }
      const rows = matching();
      for (const r of rows) Object.assign(r, patch);
      return { data: returning ? rows.map((r) => ({ ...r })) : null, error: null };
    }

    const b: Record<string, unknown> = {
      select: (_cols?: string, opts?: { count?: string; head?: boolean }) => {
        if (mode !== 'select') returning = true;
        if (opts?.head) head = true;
        if (opts?.count) counting = true;
        return b;
      },
      eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return b; },
      neq: (c: string, v: unknown) => { filters.push((r) => r[c] !== v); return b; },
      in: (c: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[c])); return b; },
      gte: (c: string, v: unknown) => { filters.push((r) => String(r[c]) >= String(v)); return b; },
      lte: (c: string, v: unknown) => { filters.push((r) => String(r[c]) <= String(v)); return b; },
      is: (c: string, v: unknown) => { filters.push((r) => (r[c] ?? null) === v); return b; },
      contains: (c: string, v: Record<string, unknown>) => { filters.push((r) => contains(r[c], v)); return b; },
      not: () => b,
      or: () => b,
      order: (col: string, opts?: { ascending?: boolean }) => { sort = { col, asc: opts?.ascending !== false }; return b; },
      limit: (n: number) => { max = n; return b; },
      insert: (rows: Row | Row[]) => { mode = 'insert'; payload = Array.isArray(rows) ? rows : [rows]; return b; },
      upsert: (rows: Row | Row[]) => { mode = 'upsert'; payload = Array.isArray(rows) ? rows : [rows]; return b; },
      update: (p: Row) => { mode = 'update'; patch = p; return b; },
      maybeSingle: async () => {
        const r = run();
        return { data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data, error: r.error };
      },
      single: async () => {
        const r = run();
        const first = Array.isArray(r.data) ? r.data[0] : r.data;
        return first || r.error ? { data: first ?? null, error: r.error } : { data: null, error: { code: 'PGRST116', message: 'no rows' } };
      },
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve().then(run).then(resolve, reject),
    };
    return b;
  }
  return {
    from: (table: string) => builder(table),
    rpc: async () => ({ data: null, error: null }),
  };
}
