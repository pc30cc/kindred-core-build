/**
 * The schema cache's loading rules (2026-11-08), over a fake Queryable:
 *
 *   · the first load is awaited, and a failed one is retried by the next get;
 *   · an old snapshot is served at once while ONE refresh runs in the
 *     background (it used to make the first request of every five minutes
 *     wait, and fail every waiting request when the catalog read failed);
 *   · a failed age refresh is logged, the old snapshot keeps serving, and the
 *     next try waits the retry gap;
 *   · a miss's reload is awaited, single-flight, at most once per gap, a
 *     failed one included; and the engine answers a miss whose reload failed
 *     with its own error, not the catalog read's;
 *   · the catalog is read in one statement (one snapshot, one connection).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CATALOG_SQL, SchemaCache, loadSchema, tableKey } from './schemaCache.js';
import { PostgrestEngine } from './engine.js';
import type { Queryable } from './types.js';

type Catalog = {
  tables: unknown[];
  columns: unknown[];
  constraints: unknown[];
  functions: unknown[];
};

const col = (oid: number, name: string, type = 'text', typname = 'text') =>
  ({ oid, name, type, typname, generated: false, default_expr: null });

/** A catalog with `widgets` (id pk, name), and `parts` (id pk, widget_id fk unique when `oneToOne`). */
function catalog(opts: { extraTable?: string; oneToOne?: boolean } = {}): Catalog {
  const tables: unknown[] = [
    { oid: 101, schema: 'public', name: 'widgets', kind: 'r' },
    { oid: 102, schema: 'public', name: 'parts', kind: 'r' },
  ];
  const columns: unknown[] = [
    col(101, 'id', 'uuid', 'uuid'), col(101, 'name'),
    col(102, 'id', 'uuid', 'uuid'), col(102, 'widget_id', 'uuid', 'uuid'),
  ];
  if (opts.extraTable) {
    tables.push({ oid: 103, schema: 'public', name: opts.extraTable, kind: 'r' });
    columns.push(col(103, 'id', 'uuid', 'uuid'));
  }
  const constraints: unknown[] = [
    { name: 'widgets_pkey', type: 'p', rel: 101, frel: 0, cols: ['id'], fcols: [] },
    { name: 'parts_pkey', type: 'p', rel: 102, frel: 0, cols: ['id'], fcols: [] },
    { name: 'parts_widget_id_fkey', type: 'f', rel: 102, frel: 101, cols: ['widget_id'], fcols: ['id'] },
  ];
  if (opts.oneToOne) constraints.push({ name: 'parts_widget_key', type: 'u', rel: 102, frel: 0, cols: ['widget_id'], fcols: [] });
  const functions: unknown[] = [{
    schema: 'public', name: 'ping', nargs: 1, ndefaults: 0, argnames: ['p_x'], argmodes: null,
    argtypes: ['integer'], retset: false, rettype: 'integer', rettyptype: 'b', retrecord: false, retvoid: false,
  }];
  return { tables, columns, constraints, functions };
}

/** A fake database: each catalog read takes the next scripted answer (a catalog, an Error, or a pending promise). */
class FakeDb implements Queryable {
  calls: string[] = [];
  script: (Catalog | Error | Promise<Catalog>)[] = [];
  fallback: Catalog = catalog();
  async query<R>(text: string): Promise<{ rows: R[]; rowCount: number | null }> {
    this.calls.push(text);
    if (text !== CATALOG_SQL) throw Object.assign(new Error(`unexpected SQL: ${text.slice(0, 60)}`), { code: 'XX000' });
    const next = this.script.length ? this.script.shift()! : this.fallback;
    const value = await next;
    if (value instanceof Error) throw value;
    return { rows: [value as unknown as R], rowCount: 1 };
  }
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('loadSchema', () => {
  it('reads the whole catalog in one statement and builds tables, keys, relationships and functions', async () => {
    const db = new FakeDb();
    const snap = await loadSchema(db, ['public']);
    expect(db.calls).toEqual([CATALOG_SQL]);
    const widgets = snap.tables.get(tableKey('public', 'widgets'))!;
    expect([...widgets.columns.keys()]).toEqual(['id', 'name']);
    expect(widgets.pk).toEqual(['id']);
    const toParts = snap.relationships.find((r) => r.from === widgets && r.to.name === 'parts')!;
    expect(toParts.cardinality).toBe('one-to-many');
    expect(snap.functions.get(tableKey('public', 'ping'))![0].args).toEqual([{ name: 'p_x', type: 'integer', hasDefault: false }]);
  });

  it('a unique key on the foreign key makes the embed one-to-one', async () => {
    const db = new FakeDb();
    db.fallback = catalog({ oneToOne: true });
    const snap = await loadSchema(db, ['public']);
    const widgets = snap.tables.get(tableKey('public', 'widgets'))!;
    expect(snap.relationships.find((r) => r.from === widgets)!.cardinality).toBe('one-to-one');
  });

  it('the statement is one snapshot: every read is a subquery of a single SELECT', () => {
    expect(CATALOG_SQL.match(/json_agg/g)).toHaveLength(4);
    expect(CATALOG_SQL).not.toMatch(/;/);
  });
});

describe('SchemaCache', () => {
  let clock = 1_000_000;
  const now = () => clock;
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    clock = 1_000_000;
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => warn.mockRestore());

  const make = (db: FakeDb) => new SchemaCache(db, ['public'], 300_000, 1_000, 10_000, now);

  it('awaits the first load, then serves it without another read while it is young', async () => {
    const db = new FakeDb();
    const cache = make(db);
    const first = await cache.get();
    clock += 299_000;
    expect(await cache.get()).toBe(first);
    expect(db.calls).toHaveLength(1);
  });

  it('a failed first load fails the request, and the next get tries again', async () => {
    const db = new FakeDb();
    db.script = [new Error('connect timeout')];
    const cache = make(db);
    await expect(cache.get()).rejects.toThrow('connect timeout');
    const snap = await cache.get();
    expect(snap.tables.size).toBe(2);
    expect(db.calls).toHaveLength(2);
  });

  it('concurrent first gets share one read', async () => {
    const db = new FakeDb();
    const cache = make(db);
    const [a, b, c] = await Promise.all([cache.get(), cache.get(), cache.get()]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(db.calls).toHaveLength(1);
  });

  it('an old snapshot is served at once while one refresh runs in the background', async () => {
    const db = new FakeDb();
    const cache = make(db);
    const old = await cache.get();
    clock += 300_000;
    const pending = deferred<Catalog>();
    db.script = [pending.promise];
    // Every request during the refresh gets the old snapshot without waiting.
    expect(await cache.get()).toBe(old);
    expect(await cache.get()).toBe(old);
    expect(await cache.get()).toBe(old);
    expect(db.calls).toHaveLength(2);
    pending.resolve(catalog({ extraTable: 'gadgets' }));
    await flush();
    const fresh = await cache.get();
    expect(fresh).not.toBe(old);
    expect(fresh.tables.has(tableKey('public', 'gadgets'))).toBe(true);
    expect(fresh.loadedAt).toBe(clock);
    expect(db.calls).toHaveLength(2);
  });

  it('a failed age refresh keeps serving the old snapshot, is logged, and waits the retry gap', async () => {
    const db = new FakeDb();
    const cache = make(db);
    const old = await cache.get();
    clock += 300_000;
    db.script = [new Error('too many connections')];
    expect(await cache.get()).toBe(old);
    await flush();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('schema cache reload failed, serving the snapshot loaded 300 s ago'), 'too many connections');
    // Within the gap: no new read, still the old snapshot.
    clock += 9_000;
    expect(await cache.get()).toBe(old);
    await flush();
    expect(db.calls).toHaveLength(2);
    // Past it: one more try, which succeeds.
    clock += 1_000;
    expect(await cache.get()).toBe(old);
    await flush();
    expect(db.calls).toHaveLength(3);
    const fresh = await cache.get();
    expect(fresh).not.toBe(old);
  });

  it('a miss reloads and waits for it, single-flight, at most once per gap', async () => {
    const db = new FakeDb();
    const cache = make(db);
    const seen = await cache.get();
    // Younger than the gap: no reload.
    expect(await cache.refreshAfterMiss(seen)).toBeNull();
    expect(db.calls).toHaveLength(1);
    clock += 1_000;
    db.script = [catalog({ extraTable: 'gadgets' })];
    const [a, b] = await Promise.all([cache.refreshAfterMiss(seen), cache.refreshAfterMiss(seen)]);
    expect(a).not.toBeNull();
    expect(a).toBe(b);
    expect(a!.tables.has(tableKey('public', 'gadgets'))).toBe(true);
    expect(db.calls).toHaveLength(2);
    // Someone else already reloaded: the newer snapshot, no read.
    expect(await cache.refreshAfterMiss(seen)).toBe(a);
    expect(db.calls).toHaveLength(2);
  });

  it('a miss whose reload failed rejects, and a miss right after it does not read again', async () => {
    const db = new FakeDb();
    const cache = make(db);
    const seen = await cache.get();
    clock += 5_000;
    db.script = [new Error('db down')];
    await expect(cache.refreshAfterMiss(seen)).rejects.toThrow('db down');
    clock += 500;
    expect(await cache.refreshAfterMiss(seen)).toBeNull();
    expect(db.calls).toHaveLength(2);
    clock += 500;
    expect(await cache.refreshAfterMiss(seen)).not.toBeNull();
    expect(db.calls).toHaveLength(3);
  });
});

describe('PostgrestEngine with a failing reload', () => {
  it('answers a miss with its own "not in the schema cache" error when the reload fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      let t = 1_000_000;
      const db = new FakeDb();
      const cache = new SchemaCache(db, ['public'], 300_000, 1_000, 10_000, () => t);
      const engine = new PostgrestEngine(db, cache, { maxRows: 1000 });
      await cache.get();
      t += 5_000;
      db.script = [new Error('db down')];
      const res = await engine.handle({
        method: 'GET', path: '/nonexistent', query: new URLSearchParams('select=*'), headers: new Headers(), body: null,
      });
      expect(res.status).toBe(404);
      expect(JSON.parse(res.body).code).toBe('PGRST205');
      expect(db.calls).toHaveLength(2);
    } finally {
      warn.mockRestore();
    }
  });
});
