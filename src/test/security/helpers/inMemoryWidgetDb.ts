/**
 * Small in-memory stand-in for the Supabase/PostgREST query builder, covering
 * the calls the widget identity paths make (contacts, visitor_sessions,
 * conversations, conversation_messages, contact_verifications, ...), plus the
 * two RPCs they rely on with their real SQL semantics:
 *   - merge_visitor_into_contact (migration 20260418170914)
 *   - ensure_active_conversation (simplified: thread key → session → contact)
 * It also enforces the workspace email/phone unique indexes on contacts so an
 * "adopt the other contact on conflict" bug is observable.
 */
import { randomUUID } from 'node:crypto';

export type Row = Record<string, unknown>;
type Pred = (r: Row) => boolean;
type Result = { data: unknown; error: { code?: string; message: string } | null };

export interface QueryBuilder extends PromiseLike<Result> {
  select(...args: unknown[]): QueryBuilder;
  eq(col: string, val: unknown): QueryBuilder;
  neq(col: string, val: unknown): QueryBuilder;
  is(col: string, val: unknown): QueryBuilder;
  not(col: string, op: string, val: unknown): QueryBuilder;
  in(col: string, vals: unknown[]): QueryBuilder;
  gte(col: string, val: string): QueryBuilder;
  lte(col: string, val: string): QueryBuilder;
  contains(col: string, obj: Row): QueryBuilder;
  filter(col: string, op: string, val: unknown): QueryBuilder;
  or(...args: unknown[]): QueryBuilder;
  order(col: string, opts?: { ascending?: boolean }): QueryBuilder;
  limit(n: number): QueryBuilder;
  range(...args: unknown[]): QueryBuilder;
  insert(rows: Row | Row[]): QueryBuilder;
  upsert(rows: Row | Row[], opts?: unknown): QueryBuilder;
  update(patch: Row): QueryBuilder;
  delete(): QueryBuilder;
  maybeSingle(): Promise<Result>;
  single(): Promise<Result>;
}

export interface FakeClient {
  from(table: string): QueryBuilder;
  rpc(fn: string, args: Row): Promise<Result>;
}

export interface InMemoryWidgetDb {
  tables: Record<string, Row[]>;
  rpcCalls: Array<{ fn: string; args: Row }>;
  client: FakeClient;
  rows(table: string): Row[];
  reset(): void;
}

function readPath(row: Row, col: string): unknown {
  const m = /^(\w+)->>(\w+)$/.exec(col);
  if (m) {
    const v = (row[m[1]] as Row | undefined)?.[m[2]];
    return v == null ? null : String(v);
  }
  return row[col];
}

function str(v: unknown): string {
  return v == null ? '' : String(v);
}

function uniqueViolation(table: string, rows: Row[], candidate: Row, selfId: unknown): Result['error'] {
  if (table !== 'contacts') return null;
  for (const col of ['email', 'phone'] as const) {
    const v = candidate[col];
    if (v == null || v === '') continue;
    const clash = rows.find((r) => r.id !== selfId && r.workspace_id === candidate.workspace_id && r[col] === v);
    if (clash) {
      return { code: '23505', message: `duplicate key value violates unique constraint "contacts_workspace_${col}_unique_not_blank"` };
    }
  }
  if (candidate.visitor_code) {
    const clash = rows.find((r) => r.id !== selfId && r.workspace_id === candidate.workspace_id && r.visitor_code === candidate.visitor_code);
    if (clash) return { code: '23505', message: 'duplicate key value violates unique constraint "contacts_workspace_visitor_code_idx" on visitor_code' };
  }
  return null;
}

export function createInMemoryWidgetDb(): InMemoryWidgetDb {
  const tables: Record<string, Row[]> = {};
  const rpcCalls: Array<{ fn: string; args: Row }> = [];
  const t = (name: string): Row[] => (tables[name] ||= []);

  function builder(table: string): QueryBuilder {
    const preds: Pred[] = [];
    let orderBy: { col: string; asc: boolean } | null = null;
    let limitN: number | null = null;
    let mode: 'select' | 'insert' | 'update' | 'delete' = 'select';
    let payload: Row[] = [];
    let patch: Row = {};
    let returning = false;

    const execute = (): Result => {
      if (mode === 'insert') {
        const inserted: Row[] = [];
        for (const p of payload) {
          const now = new Date().toISOString();
          const row: Row = { id: p.id ?? randomUUID(), created_at: now, updated_at: now, ...p };
          const err = uniqueViolation(table, [...t(table), ...inserted], row, null);
          if (err) return { data: null, error: err };
          inserted.push(row);
        }
        t(table).push(...inserted);
        return { data: returning ? inserted.map((r) => ({ ...r })) : null, error: null };
      }
      if (mode === 'update') {
        const rows = t(table).filter((r) => preds.every((p) => p(r)));
        for (const r of rows) {
          const err = uniqueViolation(table, t(table), { ...r, ...patch }, r.id);
          if (err) return { data: null, error: err };
        }
        for (const r of rows) Object.assign(r, patch);
        return { data: returning ? rows.map((r) => ({ ...r })) : null, error: null };
      }
      if (mode === 'delete') {
        tables[table] = t(table).filter((r) => !preds.every((p) => p(r)));
        return { data: null, error: null };
      }
      let rows = t(table).filter((r) => preds.every((p) => p(r)));
      if (orderBy) {
        const { col, asc } = orderBy;
        rows = [...rows].sort((a, b) => {
          const x = str(a[col]);
          const y = str(b[col]);
          if (x === y) return 0;
          return (x < y ? -1 : 1) * (asc ? 1 : -1);
        });
      }
      if (limitN != null) rows = rows.slice(0, limitN);
      return { data: rows.map((r) => ({ ...r })), error: null };
    };

    const first = (): Result => {
      const { data, error } = execute();
      if (error) return { data: null, error };
      const rows = Array.isArray(data) ? data : data ? [data] : [];
      return { data: rows[0] ?? null, error: null };
    };

    const b: QueryBuilder = {
      select: () => { if (mode !== 'select') returning = true; return b; },
      eq: (col, val) => { preds.push((r) => readPath(r, col) === val); return b; },
      neq: (col, val) => { preds.push((r) => readPath(r, col) !== val); return b; },
      is: (col, val) => { preds.push((r) => (val === null ? r[col] == null : r[col] === val)); return b; },
      not: (col, op, val) => {
        preds.push(op === 'is' && val === null ? (r) => r[col] != null : (r) => r[col] !== val);
        return b;
      },
      in: (col, vals) => { preds.push((r) => vals.includes(r[col])); return b; },
      gte: (col, val) => { preds.push((r) => str(r[col]) >= val); return b; },
      lte: (col, val) => { preds.push((r) => str(r[col]) <= val); return b; },
      contains: (col, obj) => {
        preds.push((r) => Object.entries(obj).every(([k, v]) => ((r[col] as Row | undefined) ?? {})[k] === v));
        return b;
      },
      filter: (col, op, val) => { if (op === 'eq') preds.push((r) => readPath(r, col) === val); return b; },
      or: () => b,
      order: (col, opts) => { orderBy = { col, asc: opts?.ascending !== false }; return b; },
      limit: (n) => { limitN = n; return b; },
      range: () => b,
      insert: (rows) => { mode = 'insert'; payload = Array.isArray(rows) ? rows : [rows]; return b; },
      upsert: (rows) => { mode = 'insert'; payload = Array.isArray(rows) ? rows : [rows]; return b; },
      update: (p) => { mode = 'update'; patch = p; return b; },
      delete: () => { mode = 'delete'; return b; },
      maybeSingle: async () => first(),
      single: async () => {
        const r = first();
        return r.error || r.data ? r : { data: null, error: { message: 'no rows' } };
      },
      then: (resolve, reject) => Promise.resolve(execute()).then(resolve, reject),
    };
    return b;
  }

  async function rpc(fn: string, args: Row): Promise<Result> {
    rpcCalls.push({ fn, args });
    if (fn === 'merge_visitor_into_contact') {
      const sessions = t('visitor_sessions').filter((s) => s.workspace_id === args._workspace_id && s.visitor_id === args._visitor_id);
      for (const s of sessions) {
        if (s.contact_id == null || s.contact_id === args._contact_id) {
          s.contact_id = args._contact_id;
          s.identity_state = 'identified';
        }
      }
      const sessionIds = new Set(sessions.map((s) => s.id));
      let merged = 0;
      for (const c of t('conversations')) {
        if (c.workspace_id === args._workspace_id && sessionIds.has(c.visitor_session_id)
          && (c.contact_id == null || c.contact_id === args._contact_id)) {
          c.contact_id = args._contact_id;
          merged++;
        }
      }
      t('identity_merges').push({ ...args, conversations_merged: merged });
      return { data: { success: true, contact_id: args._contact_id, conversations_merged: merged }, error: null };
    }
    if (fn === 'ensure_active_conversation') {
      const live = (c: Row) => c.workspace_id === args.p_workspace_id && c.status !== 'closed';
      const meta = (c: Row) => (c.metadata as Row | undefined) ?? {};
      const found = (args.p_match_thread_key && t('conversations').find((c) => live(c) && meta(c).channel_thread_key === args.p_match_thread_key))
        || (args.p_match_session_id && t('conversations').find((c) => live(c) && c.visitor_session_id === args.p_match_session_id))
        || (args.p_match_contact_id && t('conversations').find((c) => live(c) && c.contact_id === args.p_match_contact_id));
      if (found) return { data: [{ id: found.id, created: false }], error: null };
      const now = new Date().toISOString();
      const row: Row = {
        id: randomUUID(),
        workspace_id: args.p_workspace_id,
        status: 'open',
        contact_id: args.p_contact_id,
        visitor_session_id: args.p_visitor_session_id,
        subject: args.p_subject,
        metadata: args.p_metadata || {},
        created_at: now,
        updated_at: now,
      };
      t('conversations').push(row);
      return { data: [{ id: row.id, created: true }], error: null };
    }
    return { data: null, error: null };
  }

  return {
    tables,
    rpcCalls,
    client: { from: (table: string) => builder(table), rpc },
    rows: t,
    reset() {
      for (const k of Object.keys(tables)) delete tables[k];
      rpcCalls.length = 0;
    },
  };
}
