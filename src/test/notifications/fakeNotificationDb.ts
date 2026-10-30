/**
 * An in-memory stand-in for the service client, for the notification email
 * suites: the filters, orders, limits, counts and writes the producers, the
 * dispatcher and the unsubscribe route use, and the two unique indexes of
 * notification_email_jobs (the dedupe key, and one open digest per operator
 * and workspace, migration 289c). `.or()` filters nothing: a suite that
 * needs one proven runs against PostgreSQL.
 *
 * Use it from a vi.mock factory (`await import('./fakeNotificationDb')`),
 * and read and seed `db` from the suite: both are this module's one copy.
 */
export type Row = Record<string, unknown>;

export const db: Record<string, Row[]> = {};

export function resetDb(): void {
  for (const key of Object.keys(db)) delete db[key];
}

let seq = 0;

function uniqueClash(table: string, rows: Row[], value: Row): boolean {
  if (table === 'notification_email_jobs') {
    if (rows.some((r) => r.dedupe_key === value.dedupe_key)) return true;
    const open = (r: Row) => r.type === 'unread_messages' && ['pending', 'sending'].includes(String(r.status ?? 'pending'));
    if (open(value) && rows.some((r) => open(r) && r.user_id === value.user_id && r.workspace_id === value.workspace_id)) return true;
  }
  if (table === 'notification_email_announcements' && rows.some((r) => r.dedupe_key === value.dedupe_key)) return true;
  return false;
}

function defaults(table: string): Row {
  const base: Row = { id: `row-${++seq}`, created_at: new Date().toISOString() };
  if (table === 'notification_email_jobs') {
    return { ...base, status: 'pending', attempts: 0, conversation_ids: [], covered_through: null, payload: {}, scheduled_for: new Date().toISOString() };
  }
  if (table === 'notification_email_announcements') {
    return { ...base, status: 'sending', recipients_queued: 0, fanout_cursor: null, finished_at: null };
  }
  return base;
}

const cmp = (a: unknown, b: unknown) => (a === b ? 0 : a == null ? -1 : b == null ? 1 : String(a) < String(b) ? -1 : 1);

export function fakeClient() {
  return {
    from(table: string) {
      const rows: Row[] = db[table] || (db[table] = []);
      const filters: Array<(r: Row) => boolean> = [];
      let pending: 'update' | 'insert' | 'upsert' | 'delete' | null = null;
      let payload: Row | Row[] = {};
      type Result = { data: Row[] | null; error: { code?: string; message: string } | null; count: number | null };
      let order: { col: string; asc: boolean } | null = null;
      let limit: number | null = null;
      let countMode = false;
      let head = false;

      const matched = () => {
        let out = rows.filter((r) => filters.every((f) => f(r)));
        if (order) {
          const { col, asc } = order;
          out = [...out].sort((a, b) => (asc ? cmp(a[col], b[col]) : cmp(b[col], a[col])));
        }
        return limit === null ? out : out.slice(0, limit);
      };

      const apply = (): Row[] => {
        if (pending === 'update') {
          const hits = matched();
          for (const r of hits) Object.assign(r, payload);
          return hits;
        }
        if (pending === 'delete') {
          const hits = matched();
          for (const r of hits) rows.splice(rows.indexOf(r), 1);
          return hits;
        }
        if (pending === 'insert' || pending === 'upsert') {
          const out: Row[] = [];
          for (const value of Array.isArray(payload) ? payload : [payload]) {
            if (pending === 'upsert') {
              const existing = rows.find((r) => r.user_id === value.user_id);
              if (existing) {
                Object.assign(existing, value);
                out.push(existing);
                continue;
              }
            }
            const row = { ...defaults(table), ...value };
            if (uniqueClash(table, rows, row)) {
              throw Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
            }
            rows.push(row);
            out.push(row);
          }
          return out;
        }
        return matched();
      };

      const run = (): Result => {
        try {
          const data = apply();
          return { data: head ? null : data, error: null, count: countMode ? data.length : null };
        } catch (err) {
          const e = err as Error & { code?: string };
          return { data: null, error: { code: e.code, message: e.message }, count: null };
        }
      };

      const builder: Record<string, unknown> = {
        select(_cols?: string, opts?: { count?: string; head?: boolean }) {
          if (opts?.count) countMode = true;
          if (opts?.head) head = true;
          return builder;
        },
        eq(col: string, val: unknown) { filters.push((r) => r[col] === val); return builder; },
        neq(col: string, val: unknown) { filters.push((r) => r[col] !== val); return builder; },
        is(col: string, val: null) { filters.push((r) => (r[col] ?? null) === val); return builder; },
        in(col: string, vals: unknown[]) { filters.push((r) => vals.includes(r[col])); return builder; },
        or() { return builder; },
        not() { return builder; },
        lt(col: string, val: unknown) { filters.push((r) => r[col] != null && String(r[col]) < String(val)); return builder; },
        lte(col: string, val: unknown) { filters.push((r) => r[col] != null && String(r[col]) <= String(val)); return builder; },
        gt(col: string, val: unknown) { filters.push((r) => r[col] != null && String(r[col]) > String(val)); return builder; },
        gte(col: string, val: unknown) { filters.push((r) => r[col] != null && String(r[col]) >= String(val)); return builder; },
        overlaps(col: string, vals: unknown[]) {
          filters.push((r) => ((r[col] as unknown[] | null) ?? []).some((v) => vals.includes(v)));
          return builder;
        },
        order(col: string, opts?: { ascending?: boolean }) { order = { col, asc: opts?.ascending !== false }; return builder; },
        limit(n: number) { limit = n; return builder; },
        update(patch: Row) { pending = 'update'; payload = patch; return builder; },
        insert(values: Row | Row[]) { pending = 'insert'; payload = values; return builder; },
        upsert(values: Row | Row[]) { pending = 'upsert'; payload = values; return builder; },
        delete() { pending = 'delete'; return builder; },
        maybeSingle: async () => {
          const result = run();
          return { data: result.data?.[0] ?? null, error: result.error };
        },
        single: async () => {
          const result = run();
          return { data: result.data?.[0] ?? null, error: result.error ?? (result.data?.length ? null : { code: 'PGRST116', message: 'no rows' }) };
        },
        then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
          return Promise.resolve(run()).then(resolve, reject);
        },
      };
      return builder;
    },
    rpc: async () => ({ data: null, error: { code: '42883', message: 'no such function' } }),
  };
}
