/**
 * An in-memory stand-in for the PostgREST client, for the colleague-call
 * suites (route, ticker, webhook): enough of the query builder to run the
 * real reads and compare-and-set writes of teamCallLifecycle.ts against
 * rows a test can inspect afterwards.
 *
 * Filters (`eq`, `neq`, `in`, `is`, `not … is null`, `gt`, `gte`, `lt`,
 * `lte`, and `or` of `eq`s and `and(…)`s as the team chat reads) read JSON
 * paths too (`metadata->team_call->>callee_user_id`), as PostgREST does; an
 * update returns the rows it changed, so a compare-and-set that matched
 * nothing resolves to no row; and the unique keys the code relies on refuse
 * a second row (23505) — the one push dispatch claims under, and a call's
 * one line in the team chat (294, NULLs distinct), which an upsert with
 * `ignoreDuplicates` skips instead, answering only the rows it wrote.
 *
 * `rpc('is_workspace_member')` reads `tables.workspace_members`.
 *
 * `rpc('team_call_place')` is migration 293's function as these suites need
 * it: the same busy rule over the rows here, then the insert. JavaScript runs
 * it to the end without a pause, which is what the function's locks make of
 * it in PostgreSQL; the locks themselves are proven against a real database
 * (src/test/integration/teamCalls293.pg.test.ts).
 */
import { randomUUID } from 'node:crypto';

export type Row = Record<string, unknown>;
type Result = { data: unknown; error: { code?: string; message: string } | null; count?: number };

export interface FakeDb {
  tables: Record<string, Row[]>;
  rpc: (name: string, args?: Record<string, unknown>) => Promise<Result>;
  from: (table: string) => unknown;
  /**
   * Make the next query of [table] fail (`rpc:<name>`: the next call of that
   * function), with [error] (by default one without a code).
   */
  failNext(table: string, error?: { code?: string; message: string }): void;
}

/** Defaults a `call_sessions` insert gets from the table, as far as these tests read them. */
const DEFAULTS: Record<string, () => Row> = {
  call_sessions: () => ({
    id: randomUUID(),
    provider_room_id: null,
    state: 'pending',
    connected_at: null,
    started_at: null,
    ended_at: null,
    ended_by: null,
    ended_by_user_id: null,
    end_reason: null,
    duration_seconds: null,
    assigned_agent_id: null,
    entry_source: 'chat',
    metadata: {},
    created_at: new Date().toISOString(),
  }),
  team_messages: () => ({
    id: randomUUID(),
    body: '',
    attachment_id: null,
    reply_to_id: null,
    read_at: null,
    call_session_id: null,
    created_at: new Date().toISOString(),
  }),
};

/** Unique indexes the code relies on to stay idempotent. */
const UNIQUE: Record<string, string[]> = {
  push_dispatch_log: ['workspace_id', 'user_id', 'dedupe_key'],
  team_messages: ['call_session_id'],
};

/** A row that a unique key already holds (a NULL in the key never collides, as in PostgreSQL). */
function collides(existing: Row[], key: string[], v: Row): boolean {
  return key.every((c) => v[c] !== null && v[c] !== undefined)
    && existing.some((r) => key.every((c) => r[c] === v[c]));
}

/** Top-level comma split of a PostgREST `or=(…)` list. */
function splitTop(expr: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of expr) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current) parts.push(current);
  return parts;
}

function valueAt(row: Row, column: string): unknown {
  if (!column.includes('->')) return row[column];
  const [head, ...path] = column.split(/->>?/);
  let value: unknown = row[head];
  for (const key of path) value = value && typeof value === 'object' ? (value as Row)[key] : undefined;
  return value;
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** One condition of an `or` list: `column.eq.value`, or `and(…)` of them. */
function orCondition(part: string): (r: Row) => boolean {
  const and = /^and\((.*)\)$/.exec(part);
  if (and) {
    const all = splitTop(and[1]).map(orCondition);
    return (r) => all.every((f) => f(r));
  }
  const eq = /^([^.]+)\.eq\.(.*)$/.exec(part);
  if (!eq) throw new Error(`fake db: or() condition not supported: ${part}`);
  return (r) => String(valueAt(r, eq[1]) ?? '') === eq[2];
}

export function createFakeDb(): FakeDb {
  const tables: Record<string, Row[]> = {};
  const failing = new Map<string, { code?: string; message: string } | null>();

  function from(table: string) {
    const rows = () => (tables[table] ||= []);
    const filters: Array<(r: Row) => boolean> = [];
    let op: 'select' | 'insert' | 'update' | 'delete' | 'upsert' = 'select';
    let values: Row | Row[] | null = null;
    let order: { column: string; ascending: boolean } | null = null;
    let limit: number | null = null;
    let head = false;
    let ignoreDuplicates = false;
    const fail = failing.has(table);
    const failure = failing.get(table) ?? null;
    if (fail) failing.delete(table);

    const run = (): Result => {
      if (fail) return { data: null, error: failure ?? { message: `${table} unavailable` } };
      if (op === 'insert' || op === 'upsert') {
        const list = (Array.isArray(values) ? values : [values]) as Row[];
        const key = UNIQUE[table];
        const fresh = key && ignoreDuplicates ? list.filter((v) => !collides(rows(), key, v)) : list;
        if (key && fresh.some((v) => collides(rows(), key, v))) {
          return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } };
        }
        const out = fresh.map((v) => ({ ...(DEFAULTS[table]?.() ?? {}), ...clone(v) }));
        rows().push(...out);
        return { data: clone(out), error: null };
      }
      const matched = rows().filter((r) => filters.every((f) => f(r)));
      if (op === 'update') {
        for (const r of matched) Object.assign(r, clone(values as Row));
        return { data: clone(matched), error: null };
      }
      if (op === 'delete') {
        tables[table] = rows().filter((r) => !matched.includes(r));
        return { data: clone(matched), error: null };
      }
      let out = [...matched];
      if (order) {
        const { column, ascending } = order;
        out.sort((a, b) => (String(a[column]) < String(b[column]) ? -1 : 1) * (ascending ? 1 : -1));
      }
      if (limit !== null) out = out.slice(0, limit);
      return head ? { data: null, error: null, count: out.length } : { data: clone(out), error: null, count: out.length };
    };

    const builder: Record<string, unknown> = {
      select(_columns?: string, opts?: { head?: boolean }) { head = !!opts?.head; return builder; },
      insert(v: Row | Row[]) { op = 'insert'; values = v; return builder; },
      upsert(v: Row | Row[], opts?: { ignoreDuplicates?: boolean }) {
        op = 'upsert'; values = v; ignoreDuplicates = !!opts?.ignoreDuplicates; return builder;
      },
      update(v: Row) { op = 'update'; values = v; return builder; },
      delete() { op = 'delete'; return builder; },
      eq(c: string, v: unknown) { filters.push((r) => valueAt(r, c) === v); return builder; },
      neq(c: string, v: unknown) { filters.push((r) => valueAt(r, c) !== v); return builder; },
      in(c: string, vs: unknown[]) { filters.push((r) => vs.includes(valueAt(r, c))); return builder; },
      is(c: string, v: null) { filters.push((r) => (valueAt(r, c) ?? null) === v); return builder; },
      not(c: string, opName: string, v: unknown) {
        if (opName === 'is' && v === null) filters.push((r) => (valueAt(r, c) ?? null) !== null);
        return builder;
      },
      gt(c: string, v: string) { filters.push((r) => String(valueAt(r, c)) > v); return builder; },
      gte(c: string, v: string) { filters.push((r) => String(valueAt(r, c)) >= v); return builder; },
      lt(c: string, v: string) { filters.push((r) => String(valueAt(r, c)) < v); return builder; },
      lte(c: string, v: string) { filters.push((r) => String(valueAt(r, c)) <= v); return builder; },
      or(expr: string) {
        const any = splitTop(expr).map(orCondition);
        filters.push((r) => any.some((f) => f(r)));
        return builder;
      },
      order(column: string, opts?: { ascending?: boolean }) { order = { column, ascending: opts?.ascending !== false }; return builder; },
      limit(n: number) { limit = n; return builder; },
      maybeSingle: async () => {
        const r = run();
        return { ...r, data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data };
      },
      single: async () => {
        const r = run();
        const first = Array.isArray(r.data) ? r.data[0] : r.data;
        return first || r.error ? { ...r, data: first ?? null } : { data: null, error: { code: 'PGRST116', message: 'no rows' } };
      },
      then(resolve: (v: Result) => void, reject?: (e: unknown) => void) {
        try { resolve(run()); } catch (e) { reject?.(e); }
      },
    };
    return builder;
  }

  /** 293's public.team_call_place, over `tables.call_sessions`. */
  function placeTeamCall(args: Record<string, unknown>): Result {
    if (failing.has('rpc:team_call_place')) {
      failing.delete('rpc:team_call_place');
      return { data: null, error: { message: 'team_call_place unavailable' } };
    }
    const caller = String(args.p_caller_id);
    const callee = String(args.p_callee_id);
    const ringCutoff = String(args.p_ring_cutoff);
    const liveSince = String(args.p_live_since);
    const live = (tables.call_sessions ||= []).filter((r) => {
      if (r.entry_source !== 'team_call' || !['ringing', 'connecting', 'active'].includes(String(r.state))) return false;
      if (String(r.created_at) <= liveSince) return false;
      return r.state !== 'ringing' || String(r.created_at) > ringCutoff;
    });
    const holds = (userId: string) => live.some((r) => [
      r.initiated_by,
      valueAt(r, 'metadata->team_call->>caller_user_id'),
      valueAt(r, 'metadata->team_call->>callee_user_id'),
    ].includes(userId));
    if (holds(caller)) return { data: { verdict: 'caller_busy' }, error: null };
    if (holds(callee)) return { data: { verdict: 'callee_busy' }, error: null };
    const row: Row = {
      ...DEFAULTS.call_sessions(),
      workspace_id: args.p_workspace_id,
      provider: args.p_provider,
      call_type: args.p_channel,
      context_type: 'internal',
      context_id: null,
      entry_source: 'team_call',
      state: 'ringing',
      initiated_by: caller,
      initiated_by_type: 'internal',
      recording_enabled: false,
      recording_state: 'disabled',
      metadata: clone(args.p_metadata ?? {}),
    };
    tables.call_sessions.push(row);
    return { data: { verdict: 'placed', call: clone(row) }, error: null };
  }

  return {
    tables,
    from,
    rpc: async (name: string, args: Record<string, unknown> = {}) => {
      if (name === 'observability_try_acquire_ticker_lease') return { data: true, error: null };
      if (name === 'team_call_place') return placeTeamCall(args);
      if (name === 'is_workspace_member') {
        const member = (tables.workspace_members ||= [])
          .some((m) => m.workspace_id === args._workspace_id && m.user_id === args._user_id);
        return { data: member, error: null };
      }
      return { data: null, error: null };
    },
    failNext(table: string, error?: { code?: string; message: string }) { failing.set(table, error ?? null); },
  };
}
