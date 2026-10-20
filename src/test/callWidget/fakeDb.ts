/**
 * In-memory stand-in for the Supabase/PostgREST client the server uses
 * (getServiceClient): every from()/rpc() round trip is logged as
 * "<op> <table>" or "rpc <fn>", so a test can count the database work a
 * request does. Filters are applied for real (ranges too: timestamps by
 * instant, as PostgreSQL compares timestamptz); ordering is not; `or()` is
 * not.
 */
export type Row = Record<string, unknown>;
export const db: Record<string, Row[]> = {};
export const log: string[] = [];
export function resetLog() { log.length = 0; }
let seq = 0;

/**
 * a <op> b as PostgreSQL would: NULL never matches; two timestamps (ISO
 * strings, any offset) by instant; numbers by value; other text by code point.
 */
function compare(a: unknown, b: unknown): number | null {
  if (a == null || b == null) return null;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const sa = String(a);
  const sb = String(b);
  const iso = /^\d{4}-\d{2}-\d{2}T/;
  if (iso.test(sa) && iso.test(sb)) {
    const ta = Date.parse(sa);
    const tb = Date.parse(sb);
    if (Number.isFinite(ta) && Number.isFinite(tb)) return ta - tb;
  }
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

/** A column, or `col->>key` (a JSON field). */
function get(row: Row, col: string): unknown {
  const m = /^(\w+)->>(\w+)$/.exec(col);
  if (m) return (row[m[1]] as Row | null | undefined)?.[m[2]];
  return row[col];
}

type Op = 'select' | 'insert' | 'update' | 'upsert' | 'delete';
type Result = { data: Row[]; error: null };
type One = { data: Row | null; error: null };
export interface FakeQuery extends PromiseLike<Result> {
  select(columns?: string): FakeQuery;
  insert(payload: Row | Row[]): FakeQuery;
  upsert(payload: Row | Row[]): FakeQuery;
  update(payload: Row): FakeQuery;
  delete(): FakeQuery;
  eq(col: string, value: unknown): FakeQuery;
  neq(col: string, value: unknown): FakeQuery;
  is(col: string, value: unknown): FakeQuery;
  not(col: string, op: string, value: unknown): FakeQuery;
  in(col: string, values: unknown[]): FakeQuery;
  contains(col: string, value: Row): FakeQuery;
  or(filter?: string): FakeQuery;
  order(col?: string, opts?: unknown): FakeQuery;
  gte(col?: string, value?: unknown): FakeQuery;
  lte(col?: string, value?: unknown): FakeQuery;
  gt(col?: string, value?: unknown): FakeQuery;
  lt(col?: string, value?: unknown): FakeQuery;
  limit(n: number): FakeQuery;
  maybeSingle(): Promise<One>;
  single(): Promise<One>;
}

function builder(table: string): FakeQuery {
  const filters: Array<(r: Row) => boolean> = [];
  let op: Op = 'select';
  let payload: Row | Row[] | null = null;
  let limitN: number | null = null;
  const rows = () => (db[table] ||= []);
  const exec = (): Result => {
    log.push(`${op} ${table}`);
    if (op === 'insert' || op === 'upsert') {
      const now = new Date().toISOString();
      const list = (Array.isArray(payload) ? payload : [payload ?? {}])
        .map((p) => ({ id: `${table}-${++seq}`, created_at: now, updated_at: now, last_seen_at: now, ...p }));
      rows().push(...list);
      return { data: list, error: null };
    }
    let matched = rows().filter((r) => filters.every((f) => f(r)));
    if (op === 'update') { matched.forEach((r) => Object.assign(r, payload)); return { data: matched, error: null }; }
    if (op === 'delete') { db[table] = rows().filter((r) => !matched.includes(r)); return { data: matched, error: null }; }
    if (limitN != null) matched = matched.slice(0, limitN);
    return { data: matched, error: null };
  };
  const filter = (f: (r: Row) => boolean) => { filters.push(f); return b; };
  const b: FakeQuery = {
    select: () => b,
    insert: (p) => { op = 'insert'; payload = p; return b; },
    upsert: (p) => { op = 'upsert'; payload = p; return b; },
    update: (p) => { op = 'update'; payload = p; return b; },
    delete: () => { op = 'delete'; return b; },
    eq: (c, v) => filter((r) => get(r, c) === v),
    neq: (c, v) => filter((r) => get(r, c) !== v),
    is: (c, v) => filter((r) => (get(r, c) ?? null) === v),
    not: (c, _o, v) => filter((r) => (get(r, c) ?? null) !== v),
    in: (c, vs) => filter((r) => vs.includes(get(r, c))),
    contains: (c, v) => filter((r) => Object.entries(v).every(([k, x]) => (r[c] as Row | undefined)?.[k] === x)),
    or: () => b, order: () => b,
    gte: (c, v) => filter((r) => { const d = compare(get(r, c as string), v); return d != null && d >= 0; }),
    lte: (c, v) => filter((r) => { const d = compare(get(r, c as string), v); return d != null && d <= 0; }),
    gt: (c, v) => filter((r) => { const d = compare(get(r, c as string), v); return d != null && d > 0; }),
    lt: (c, v) => filter((r) => { const d = compare(get(r, c as string), v); return d != null && d < 0; }),
    limit: (n) => { limitN = n; return b; },
    maybeSingle: async () => ({ data: exec().data[0] ?? null, error: null }),
    single: async () => ({ data: exec().data[0] ?? null, error: null }),
    // Runs when awaited, like a PostgREST builder.
    then: (onfulfilled, onrejected) => Promise.resolve(exec()).then(onfulfilled, onrejected),
  };
  return b;
}

export const fakeClient = {
  from: (table: string) => builder(table),
  rpc: async (fn: string) => {
    log.push(`rpc ${fn}`);
    return { data: fn === 'check_workspace_entitlement' ? { allowed: true } : null, error: null };
  },
};
