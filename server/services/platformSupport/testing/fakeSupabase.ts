/**
 * An in-memory stand-in for the service-role Supabase client, covering just
 * the query surface platform support uses: filters, ordering, counting,
 * inserts, updates and upserts with the unique rules that matter to it, and
 * the two RPCs it calls (`is_workspace_member`, `ensure_active_conversation`).
 *
 * Test-only. Rows are plain objects; a column may be read as `metadata->>key`.
 */
import { randomUUID } from 'node:crypto';

type Row = Record<string, unknown>;
type Result = { data: unknown; error: { message: string; code?: string } | null; count?: number | null };
/** What the filters compare: text, numbers and timestamps as ISO text. */
type Scalar = string | number;

/** A key of a JSON column, or undefined when the column holds no object. */
function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
}

const UNIQUE: Record<string, (a: Row, b: Row) => boolean> = {
  contacts: (a, b) => a.workspace_id === b.workspace_id && !!a.email && a.email === b.email,
  conversation_messages: (a, b) =>
    a.conversation_id === b.conversation_id &&
    !!field(a.metadata, 'client_message_id') &&
    field(a.metadata, 'client_message_id') === field(b.metadata, 'client_message_id'),
  platform_support_threads: (a, b) => a.conversation_id === b.conversation_id,
  platform_support_settings: (a, b) => a.id === b.id,
};

export class FakeDb {
  tables: Record<string, Row[]> = {};
  private clock = Date.parse('2026-09-30T10:00:00.000Z');
  private threadNumber = 1000;

  table(name: string): Row[] {
    return (this.tables[name] ??= []);
  }

  /** Strictly increasing timestamps, so ordering by time is deterministic. */
  now(): string {
    this.clock += 1000;
    return new Date(this.clock).toISOString();
  }

  withDefaults(table: string, row: Row): Row {
    const out: Row = { ...row };
    if (out.id === undefined && table !== 'platform_support_threads' && table !== 'platform_support_settings') {
      out.id = randomUUID();
    }
    if (out.created_at === undefined) out.created_at = this.now();
    if (table === 'conversations') {
      out.status ??= 'open';
      out.metadata ??= {};
      out.updated_at ??= out.created_at;
    }
    if (table === 'platform_support_threads' && out.number === undefined) out.number = ++this.threadNumber;
    return out;
  }
}

function read(row: Row, column: string): unknown {
  const arrow = column.indexOf('->>');
  if (arrow > 0) {
    const value = field(row[column.slice(0, arrow)], column.slice(arrow + 3));
    return value === undefined || value === null ? null : String(value);
  }
  return row[column];
}

function contains(value: unknown, subset: Record<string, unknown>): boolean {
  return Object.entries(subset).every(([k, v]) => field(value, k) === v);
}

class Query implements PromiseLike<Result> {
  private op: 'select' | 'insert' | 'update' | 'upsert' | 'delete' = 'select';
  private payload: Row | Row[] = [];
  private upsertOpts: { onConflict?: string; ignoreDuplicates?: boolean } = {};
  private filters: Array<(row: Row) => boolean> = [];
  private orders: Array<{ column: string; ascending: boolean }> = [];
  private max: number | null = null;
  private returning = false;
  private head = false;
  private counting = false;
  private mode: 'many' | 'single' | 'maybe' = 'many';

  constructor(private readonly db: FakeDb, private readonly name: string) {}

  select(_columns?: string, opts?: { count?: string; head?: boolean }) {
    if (this.op === 'select') {
      this.head = Boolean(opts?.head);
      this.counting = Boolean(opts?.count);
    } else {
      this.returning = true;
    }
    return this;
  }
  insert(payload: Row | Row[]) { this.op = 'insert'; this.payload = payload; return this; }
  update(payload: Row) { this.op = 'update'; this.payload = payload; return this; }
  upsert(payload: Row | Row[], opts: { onConflict?: string; ignoreDuplicates?: boolean } = {}) {
    this.op = 'upsert';
    this.payload = payload;
    this.upsertOpts = opts;
    return this;
  }
  delete() { this.op = 'delete'; return this; }
  eq(column: string, value: unknown) { this.filters.push((r) => read(r, column) === value); return this; }
  neq(column: string, value: unknown) { this.filters.push((r) => read(r, column) !== value); return this; }
  in(column: string, values: unknown[]) { this.filters.push((r) => values.includes(read(r, column))); return this; }
  gt(column: string, value: Scalar) { this.filters.push((r) => (read(r, column) as Scalar) > value); return this; }
  is(column: string, value: null) { this.filters.push((r) => (read(r, column) ?? null) === value); return this; }
  contains(column: string, subset: Record<string, unknown>) {
    this.filters.push((r) => contains(r[column], subset));
    return this;
  }
  filter(column: string, operator: string, value: unknown) {
    if (operator !== 'eq') throw new Error(`fake filter ${operator}`);
    return this.eq(column, value);
  }
  or(_expression: string) { return this; }
  ilike(column: string, pattern: string) {
    const re = new RegExp(`^${pattern.replace(/%/g, '.*')}$`, 'i');
    this.filters.push((r) => re.test(String(read(r, column) ?? '')));
    return this;
  }
  order(column: string, opts: { ascending?: boolean } = {}) {
    this.orders.push({ column, ascending: opts.ascending !== false });
    return this;
  }
  limit(n: number) { this.max = n; return this; }
  single() { this.mode = 'single'; return this; }
  maybeSingle() { this.mode = 'maybe'; return this; }

  then<TResult1 = Result, TResult2 = never>(
    onfulfilled?: ((value: Result) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve().then(() => this.run()).then(onfulfilled, onrejected);
  }

  private matching(): Row[] {
    return this.db.table(this.name).filter((row) => this.filters.every((f) => f(row)));
  }

  private shape(rows: Row[], counted?: number): Result {
    if (this.mode === 'single') {
      return rows.length === 1
        ? { data: { ...rows[0] }, error: null }
        : { data: null, error: { message: rows.length ? 'multiple rows' : 'no rows', code: 'PGRST116' } };
    }
    if (this.mode === 'maybe') {
      if (rows.length > 1) return { data: null, error: { message: 'multiple rows' } };
      return { data: rows[0] ? { ...rows[0] } : null, error: null };
    }
    return { data: this.head ? null : rows.map((r) => ({ ...r })), error: null, count: counted ?? null };
  }

  private run(): Result {
    const table = this.db.table(this.name);
    const unique = UNIQUE[this.name];
    switch (this.op) {
      case 'select': {
        let rows = this.matching();
        const total = rows.length;
        for (const { column, ascending } of [...this.orders].reverse()) {
          rows = [...rows].sort((a, b) => {
            const x = read(a, column) as Scalar;
            const y = read(b, column) as Scalar;
            if (x === y) return 0;
            return (x > y ? 1 : -1) * (ascending ? 1 : -1);
          });
        }
        if (this.max !== null) rows = rows.slice(0, this.max);
        return this.shape(rows, this.counting ? total : undefined);
      }
      case 'insert': {
        const input = Array.isArray(this.payload) ? this.payload : [this.payload];
        const created: Row[] = [];
        for (const raw of input) {
          const row = this.db.withDefaults(this.name, raw);
          if (unique && table.some((existing) => unique(existing, row))) {
            return { data: null, error: { message: 'duplicate key value violates unique constraint', code: '23505' } };
          }
          table.push(row);
          created.push(row);
        }
        return this.returning ? this.shape(created) : { data: null, error: null };
      }
      case 'update': {
        const rows = this.matching();
        for (const row of rows) Object.assign(row, this.payload as Row);
        return this.returning ? this.shape(rows) : { data: null, error: null };
      }
      case 'upsert': {
        const input = Array.isArray(this.payload) ? this.payload : [this.payload];
        const out: Row[] = [];
        for (const raw of input) {
          const probe = this.db.withDefaults(this.name, raw);
          const existing = unique ? table.find((row) => unique(row, probe)) : undefined;
          if (existing) {
            if (!this.upsertOpts.ignoreDuplicates) Object.assign(existing, raw);
            out.push(existing);
          } else {
            table.push(probe);
            out.push(probe);
          }
        }
        return this.returning ? this.shape(out) : { data: null, error: null };
      }
      case 'delete': {
        const doomed = new Set(this.matching());
        this.db.tables[this.name] = table.filter((row) => !doomed.has(row));
        return { data: null, error: null };
      }
    }
  }
}

export function fakeSupabase(db: FakeDb) {
  return {
    from: (name: string) => new Query(db, name),
    rpc: async (name: string, args: Record<string, unknown>): Promise<Result> => {
      if (name === 'is_workspace_member') {
        const member = db
          .table('workspace_members')
          .some((m) => m.workspace_id === args._workspace_id && m.user_id === args._user_id);
        return { data: member, error: null };
      }
      if (name === 'ensure_active_conversation') {
        const found = db
          .table('conversations')
          .find(
            (c) =>
              c.workspace_id === args.p_workspace_id &&
              field(c.metadata, 'channel_thread_key') === args.p_match_thread_key &&
              ['open', 'pending', 'resolved'].includes(String(c.status)),
          );
        if (found) return { data: [{ id: found.id, created: false, matched_by: 'thread_key' }], error: null };
        const row = db.withDefaults('conversations', {
          workspace_id: args.p_workspace_id,
          contact_id: args.p_contact_id,
          subject: args.p_subject,
          metadata: args.p_metadata ?? {},
        });
        db.table('conversations').push(row);
        return { data: [{ id: row.id, created: true, matched_by: null }], error: null };
      }
      return { data: null, error: { message: `unknown rpc ${name}` } };
    },
  };
}
