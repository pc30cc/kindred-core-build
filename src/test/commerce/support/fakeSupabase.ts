/**
 * In-memory stand-in for the Supabase/PostgREST client, for the WHMCS tests.
 *
 * It implements the query-builder subset the commerce code uses and — the
 * point of it — COUNTS every round trip by table and verb. One awaited
 * builder chain is one PostgREST request against the real database, so these
 * counts are the number of database requests the code under test issues
 * (not their cost).
 */

export type Row = Record<string, unknown>;
type Verb = 'select' | 'insert' | 'update' | 'upsert' | 'delete' | 'rpc';
type Filter = (row: Row) => boolean;
function column(row: Row, name: string): unknown {
  const [key, path] = name.split('->>');
  return path ? (row[key] as Row | undefined)?.[path] : row[key];
}

export interface OpLog {
  table: string;
  verb: Verb;
}

export interface FakeDb {
  tables: Record<string, Row[]>;
  ops: OpLog[];
  /** Unique constraints: table → list of column tuples. */
  unique: Record<string, string[][]>;
  client: { from: (table: string) => Builder; rpc: (fn: string, args?: unknown) => Promise<{ data: unknown; error: unknown }> };
  count(verb?: Verb, table?: string): number;
  reset(): void;
}

class Builder implements PromiseLike<{ data: unknown; error: unknown; count?: number }> {
  private filters: Filter[] = [];
  private verb: Verb = 'select';
  private payload: Row | Row[] | null = null;
  private orderBy: Array<{ col: string; asc: boolean }> = [];
  private max: number | null = null;
  private returning = false;
  private onConflict: string[] | null = null;

  constructor(private readonly db: FakeDb, private readonly table: string) {}

  select(_cols?: string, _opts?: unknown): this {
    if (this.verb !== 'select') this.returning = true;
    return this;
  }
  insert(rows: Row | Row[]): this { this.verb = 'insert'; this.payload = rows; return this; }
  update(patch: Row): this { this.verb = 'update'; this.payload = patch; return this; }
  upsert(rows: Row | Row[], opts?: { onConflict?: string }): this {
    this.verb = 'upsert';
    this.payload = rows;
    this.onConflict = opts?.onConflict ? opts.onConflict.split(',').map((c) => c.trim()) : null;
    return this;
  }
  delete(): this { this.verb = 'delete'; return this; }

  eq(col: string, val: unknown): this { this.filters.push((r) => column(r, col) === val); return this; }
  neq(col: string, val: unknown): this { this.filters.push((r) => r[col] !== val); return this; }
  is(col: string, val: unknown): this { this.filters.push((r) => (column(r, col) ?? null) === val); return this; }
  in(col: string, vals: unknown[]): this { this.filters.push((r) => vals.includes(r[col])); return this; }
  gte(col: string, val: unknown): this { this.filters.push((r) => String(r[col]) >= String(val)); return this; }
  lt(col: string, val: unknown): this { this.filters.push((r) => String(r[col]) < String(val)); return this; }
  not(col: string, op: string, val: unknown): this {
    if (op === 'is' && val === null) this.filters.push((r) => (r[col] ?? null) !== null);
    else this.filters.push((r) => r[col] !== val);
    return this;
  }
  contains(col: string, val: Row): this {
    this.filters.push((r) => {
      const v = r[col] as Row | undefined;
      return !!v && Object.entries(val).every(([k, x]) => v[k] === x);
    });
    return this;
  }
  order(col: string, opts?: { ascending?: boolean }): this { this.orderBy.push({ col, asc: opts?.ascending !== false }); return this; }
  limit(n: number): this { this.max = n; return this; }

  private rows(): Row[] {
    return (this.db.tables[this.table] ??= []);
  }

  private matching(): Row[] {
    let out = this.rows().filter((r) => this.filters.every((f) => f(r)));
    for (const { col, asc } of [...this.orderBy].reverse()) {
      out = [...out].sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : String(a[col]) > String(b[col]) ? 1 : 0) * (asc ? 1 : -1));
    }
    return this.max !== null ? out.slice(0, this.max) : out;
  }

  private violates(row: Row, except?: Row): boolean {
    for (const cols of this.db.unique[this.table] ?? []) {
      if (this.rows().some((r) => r !== except && cols.every((c) => r[c] !== undefined && r[c] === row[c]))) return true;
    }
    return false;
  }

  private execute(): { data: unknown; error: unknown; count?: number } {
    this.db.ops.push({ table: this.table, verb: this.verb });
    switch (this.verb) {
      case 'select': {
        const rows = this.matching();
        return { data: rows.map((r) => ({ ...r })), error: null, count: rows.length };
      }
      case 'insert': {
        const list = Array.isArray(this.payload) ? this.payload : [this.payload as Row];
        const inserted: Row[] = [];
        for (const row of list) {
          const full = { id: `id-${this.rows().length + 1}-${Math.random().toString(16).slice(2, 8)}`, ...row };
          if (this.violates(full)) return { data: null, error: { code: '23505', message: 'duplicate key' } };
          this.rows().push(full);
          inserted.push(full);
        }
        return { data: this.returning ? inserted : null, error: null };
      }
      case 'upsert': {
        const list = Array.isArray(this.payload) ? this.payload : [this.payload as Row];
        const out: Row[] = [];
        for (const row of list) {
          const existing = this.onConflict ? this.rows().find((r) => this.onConflict!.every((c) => r[c] === row[c])) : undefined;
          if (existing) { Object.assign(existing, row); out.push(existing); }
          else { const full = { id: `id-${this.rows().length + 1}`, ...row }; this.rows().push(full); out.push(full); }
        }
        return { data: out, error: null };
      }
      case 'update': {
        const rows = this.matching();
        for (const r of rows) Object.assign(r, this.payload as Row);
        return { data: this.returning ? rows : null, error: null };
      }
      case 'delete': {
        const doomed = new Set(this.matching());
        this.db.tables[this.table] = this.rows().filter((r) => !doomed.has(r));
        return { data: null, error: null };
      }
      default:
        return { data: null, error: null };
    }
  }

  maybeSingle(): Promise<{ data: unknown; error: unknown }> {
    const res = this.execute();
    if (res.error) return Promise.resolve(res);
    const data = Array.isArray(res.data) ? (res.data[0] ?? null) : res.data;
    return Promise.resolve({ data, error: null });
  }

  single(): Promise<{ data: unknown; error: unknown }> {
    return this.maybeSingle();
  }

  then<A = { data: unknown; error: unknown; count?: number }, B = never>(
    onfulfilled?: ((value: { data: unknown; error: unknown; count?: number }) => A | PromiseLike<A>) | null,
    onrejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): Promise<A | B> {
    return Promise.resolve(this.execute()).then(onfulfilled, onrejected);
  }
}

export function createFakeDb(seed: Record<string, Row[]> = {}): FakeDb {
  const db: FakeDb = {
    tables: Object.fromEntries(Object.entries(seed).map(([k, v]) => [k, v.map((r) => ({ ...r }))])),
    ops: [],
    unique: {
      commerce_nonce_cache: [['installation_id', 'direction', 'nonce']],
      commerce_customer_links: [],
    },
    client: {
      from: (table: string) => new Builder(db, table),
      rpc: async () => {
        db.ops.push({ table: 'rpc', verb: 'rpc' });
        return { data: null, error: null };
      },
    },
    count(verb?: Verb, table?: string) {
      return db.ops.filter((o) => (!verb || o.verb === verb) && (!table || o.table === table)).length;
    },
    reset() {
      db.ops.length = 0;
    },
  };
  return db;
}

/** Summary used by the resource report: requests per verb. */
export function opSummary(db: FakeDb): { select: number; insert: number; update: number; upsert: number; delete: number } {
  return {
    select: db.count('select'),
    insert: db.count('insert'),
    update: db.count('update'),
    upsert: db.count('upsert'),
    delete: db.count('delete'),
  };
}
