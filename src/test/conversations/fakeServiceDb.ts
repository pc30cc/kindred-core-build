/**
 * An in-memory stand-in for the service client (the PostgREST-style chain the
 * server code calls), for the late features' tests: the closed line, the
 * rating, the transcript by email, reactions, the queue and the away thread.
 * Enough of the chain for those services and the widget routes around them:
 * select (with a head count), eq / neq / in / gte / lte / is / contains /
 * not(…, 'is', null) / filter('col->>key', 'eq', v) filters, order, limit,
 * single / maybeSingle, insert (… select().single()), update (through
 * `db.beforeUpdate`, a trigger's stand-in), upsert, delete (… select()) and
 * rpc (answered by `db.rpc`).
 *
 * `missing` tables answer 42P01 (a database before migration 276), `failing`
 * ones a plain error; `conversation_ratings.closed_message_id` and a
 * reaction's (message_id, actor_type, actor_id, emoji) are unique (23505), as
 * in 276.
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
  /** Runs before each matching row is updated (a BEFORE UPDATE trigger): the patch to apply, or none for the asked one. */
  beforeUpdate?: (table: string, row: Row, patch: Row) => Row | void;
  /** Answers `rpc(fn, args)`; none: `{ data: null, error: null }`. */
  rpc?: (fn: string, args: Record<string, unknown>) => { data: unknown; error: unknown };
  /** Every rpc call, in order. */
  rpcs: Array<{ fn: string; args: Record<string, unknown> }>;
  /** Rows a delete removed, per table. */
  deletes: Array<{ table: string; row: Row }>;
}

/** Unique keys (each a list of columns, NULLs equal as in 276's NULLS NOT DISTINCT). */
const UNIQUE: Record<string, string[][]> = {
  conversation_ratings: [['closed_message_id']],
  conversation_message_reactions: [['message_id', 'actor_type', 'actor_id', 'emoji']],
};

export function createFakeServiceDb(): FakeServiceDb {
  return {
    tables: {}, missing: new Set(), failing: new Set(), inserts: [], reads: [], rpcs: [], deletes: [],
    now: () => new Date().toISOString(),
  };
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
    let mode: 'select' | 'insert' | 'update' | 'upsert' | 'delete' = 'select';
    let payload: Row[] = [];
    let patch: Row = {};
    let returning = false;
    /** `alias:col->>key` projections of the select (every column is returned too). */
    let aliases: Array<[string, string, string]> = [];

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
        const project = (r: Row): Row => {
          const out: Row = { ...r };
          for (const [alias, col, key] of aliases) {
            const doc = r[col];
            const v = doc && typeof doc === 'object' ? (doc as Row)[key] : undefined;
            out[alias] = v === undefined || v === null ? null : String(v);
          }
          return out;
        };
        return { data: rows.map(project), error: null, count: counting ? rows.length : null };
      }
      if (mode === 'insert' || mode === 'upsert') {
        const list = (db.tables[table] ||= []);
        const out: Row[] = [];
        for (const raw of payload) {
          db.beforeInsert?.(table, raw);
          for (const cols of UNIQUE[table] || []) {
            if (list.some((r) => cols.every((col) => (r[col] ?? null) === (raw[col] ?? null)))) {
              return {
                data: null,
                error: { code: '23505', message: `duplicate key value violates unique constraint "${table}_${cols.join('_')}"`, details: null },
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
      if (mode === 'delete') {
        const gone = new Set(rows);
        db.tables[table] = (db.tables[table] || []).filter((r) => !gone.has(r));
        for (const row of rows) db.deletes.push({ table, row });
        return { data: returning ? rows.map((r) => ({ ...r })) : null, error: null };
      }
      for (const r of rows) Object.assign(r, db.beforeUpdate?.(table, r, patch) ?? patch);
      return { data: returning ? rows.map((r) => ({ ...r })) : null, error: null };
    }

    const b: Record<string, unknown> = {
      select: (cols?: string, opts?: { count?: string; head?: boolean }) => {
        if (mode !== 'select') returning = true;
        aliases = String(cols || '').split(',').map((c) => /^\s*(\w+):(\w+)->>(\w+)\s*$/.exec(c))
          .filter((m): m is RegExpExecArray => !!m).map((m) => [m[1], m[2], m[3]]);
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
      // Only `not(col, 'is', null)` filters; any other form is ignored, as before.
      not: (c?: string, op?: string, v?: unknown) => {
        if (c && op === 'is' && v === null) filters.push((r) => (r[c] ?? null) !== null);
        return b;
      },
      // `filter('metadata->>key', 'eq', v)`: a jsonb text field.
      filter: (c: string, op: string, v: unknown) => {
        const m = /^(\w+)->>(\w+)$/.exec(c);
        if (m && op === 'eq') {
          filters.push((r) => {
            const doc = r[m[1]];
            const field = doc && typeof doc === 'object' ? (doc as Row)[m[2]] : undefined;
            return field !== undefined && field !== null && String(field) === String(v);
          });
        }
        return b;
      },
      or: () => b,
      order: (col: string, opts?: { ascending?: boolean }) => { sort = { col, asc: opts?.ascending !== false }; return b; },
      limit: (n: number) => { max = n; return b; },
      insert: (rows: Row | Row[]) => { mode = 'insert'; payload = Array.isArray(rows) ? rows : [rows]; return b; },
      upsert: (rows: Row | Row[]) => { mode = 'upsert'; payload = Array.isArray(rows) ? rows : [rows]; return b; },
      update: (p: Row) => { mode = 'update'; patch = p; return b; },
      delete: () => { mode = 'delete'; return b; },
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
    rpc: async (fn: string, args: Record<string, unknown> = {}) => {
      db.rpcs.push({ fn, args });
      return db.rpc ? db.rpc(fn, args) : { data: null, error: null };
    },
  };
}
