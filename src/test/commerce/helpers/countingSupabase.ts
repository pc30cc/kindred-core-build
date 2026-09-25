/**
 * In-memory stand-in for the Supabase service client that COUNTS every
 * operation per table (select / insert / update / delete / rpc). Used by the
 * OpenCart tests to measure exactly how many Web Yar database operations a
 * scenario adds — the numbers in docs/commerce/OPENCART_RESOURCE_REPORT.md.
 *
 * Supports the query-builder surface the commerce code uses: select, insert
 * (object or array), update, delete, eq, neq, is, in, gt, gte, lt, lte,
 * order, limit, maybeSingle, single and awaiting the builder itself.
 */
export type Row = Record<string, unknown>;

export interface OpCounts {
  select: number;
  insert: number;
  update: number;
  delete: number;
  rpc: number;
  /** rows written by inserts (a multi-row insert is ONE statement, many rows). */
  insertedRows: number;
}

export function createCountingSupabase(seed: Record<string, Row[]> = {}) {
  const db: Record<string, Row[]> = {};
  for (const [t, rows] of Object.entries(seed)) db[t] = rows.map((r) => ({ ...r }));
  const counts: Record<string, OpCounts> = {};
  const uniques: Record<string, string[][]> = {
    commerce_nonce_cache: [['installation_id', 'direction', 'nonce']],
  };
  let seq = 0;

  const bump = (table: string, op: keyof OpCounts, n = 1) => {
    counts[table] ||= { select: 0, insert: 0, update: 0, delete: 0, rpc: 0, insertedRows: 0 };
    counts[table][op] += n;
  };

  type Result = { data: unknown; error: { code?: string; message: string } | null };

  function from(table: string) {
    db[table] ||= [];
    const filters: Array<(r: Row) => boolean> = [];
    let mode: 'select' | 'insert' | 'update' | 'delete' = 'select';
    let payload: Row | Row[] | null = null;
    let orderBy: { col: string; asc: boolean } | null = null;
    let limitN: number | null = null;
    let returning = false;

    const cmp = (a: unknown, b: unknown) => (String(a) > String(b) ? 1 : String(a) < String(b) ? -1 : 0);

    const matches = () => {
      let rows = db[table].filter((r) => filters.every((f) => f(r)));
      if (orderBy) {
        const { col, asc } = orderBy;
        rows = [...rows].sort((a, b) => cmp(a[col], b[col]) * (asc ? 1 : -1));
      }
      if (limitN !== null) rows = rows.slice(0, limitN);
      return rows;
    };

    const execute = (): Result => {
      if (mode === 'select') {
        bump(table, 'select');
        return { data: matches().map((r) => ({ ...r })), error: null };
      }
      if (mode === 'insert') {
        bump(table, 'insert');
        const items = Array.isArray(payload) ? payload : [payload ?? {}];
        const inserted: Row[] = [];
        for (const item of items) {
          for (const cols of uniques[table] ?? []) {
            if (db[table].some((r) => cols.every((c) => r[c] === item[c]))) {
              return { data: null, error: { code: '23505', message: 'duplicate key' } };
            }
          }
          const stamp = new Date(Date.now() + (seq += 1)).toISOString();
          const row: Row = { id: item.id ?? `row-${seq}`, created_at: stamp, verified_at: stamp, ...item };
          db[table].push(row);
          inserted.push(row);
        }
        bump(table, 'insertedRows', inserted.length);
        return { data: returning ? inserted : null, error: null };
      }
      if (mode === 'update') {
        bump(table, 'update');
        const rows = db[table].filter((r) => filters.every((f) => f(r)));
        for (const r of rows) Object.assign(r, payload);
        return { data: returning ? rows.map((r) => ({ ...r })) : null, error: null };
      }
      bump(table, 'delete');
      db[table] = db[table].filter((r) => !filters.every((f) => f(r)));
      return { data: null, error: null };
    };

    const first = (r: Result): Result => (r.error ? r : { data: Array.isArray(r.data) ? r.data[0] ?? null : r.data, error: null });

    const builder = {
      select(_cols?: string) { if (mode !== 'select') returning = true; return builder; },
      insert(p: Row | Row[]) { mode = 'insert'; payload = p; return builder; },
      upsert(p: Row | Row[]) { mode = 'insert'; payload = p; return builder; },
      update(p: Row) { mode = 'update'; payload = p; return builder; },
      delete() { mode = 'delete'; return builder; },
      eq(c: string, v: unknown) { filters.push((r) => r[c] === v); return builder; },
      neq(c: string, v: unknown) { filters.push((r) => r[c] !== v); return builder; },
      is(c: string, v: unknown) { filters.push((r) => (r[c] ?? null) === v); return builder; },
      in(c: string, vs: unknown[]) { filters.push((r) => vs.includes(r[c])); return builder; },
      gt(c: string, v: unknown) { filters.push((r) => cmp(r[c], v) > 0); return builder; },
      gte(c: string, v: unknown) { filters.push((r) => cmp(r[c], v) >= 0); return builder; },
      lt(c: string, v: unknown) { filters.push((r) => cmp(r[c], v) < 0); return builder; },
      lte(c: string, v: unknown) { filters.push((r) => cmp(r[c], v) <= 0); return builder; },
      contains(c: string, v: Row) { filters.push((r) => Object.entries(v).every(([k, value]) => (r[c] as Row)?.[k] === value)); return builder; },
      not(c: string, op: string, v: unknown) { if (op === 'is') filters.push((r) => (r[c] ?? null) !== v); return builder; },
      order(col: string, o?: { ascending?: boolean }) { orderBy = { col, asc: o?.ascending !== false }; return builder; },
      limit(n: number) { limitN = n; return builder; },
      async maybeSingle(): Promise<Result> { return first(execute()); },
      async single(): Promise<Result> { const r = first(execute()); return r.error || r.data ? r : { data: null, error: { message: 'no rows' } }; },
      then(resolve: (r: Result) => unknown, reject: (e: unknown) => unknown) { try { return resolve(execute()); } catch (e) { return reject(e); } },
    };
    return builder;
  }

  const client = {
    from,
    async rpc(fn: string) { bump(`rpc:${fn}`, 'rpc'); return { data: null, error: null }; },
  };

  return {
    client,
    db,
    counts,
    reset() { for (const k of Object.keys(counts)) delete counts[k]; },
    total(): OpCounts {
      const t: OpCounts = { select: 0, insert: 0, update: 0, delete: 0, rpc: 0, insertedRows: 0 };
      for (const c of Object.values(counts)) for (const k of Object.keys(t) as Array<keyof OpCounts>) t[k] += c[k];
      return t;
    },
  };
}
