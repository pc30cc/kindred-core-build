/**
 * What PostgREST calls its schema cache: the tables, columns, keys, foreign
 * keys and functions of the exposed schemas, read from the catalog.
 *
 * The engine needs it for exactly the decisions PostgREST makes from it —
 * resolving an embed to a foreign key, deciding to-one versus to-many, the
 * default upsert conflict target, the RPC overload that matches a payload, and
 * PostgREST's own "not found in the schema cache" errors.
 *
 * It is loaded on first use and reloaded (a) on a miss — a table, column,
 * function or relationship the request names but the cache does not have, so
 * a migration applied while the process runs is picked up on the next request
 * that needs it — and (b) every few minutes as a safety net, for the changes
 * that raise no miss (a new unique key turning an embed to-one, a new primary
 * key moving the upsert target, a default under `missing=default`, a type
 * change, a new overload). Reloads are single-flight.
 *
 * The first load and a miss's reload are awaited: the request needs them.
 * The age refresh (b) is not (2026-11-08): the request is answered from the
 * snapshot it has, the refresh runs once in the background, and a failure is
 * logged and retried after a gap — it used to make the first request of
 * every five minutes (and everyone arriving meanwhile) wait for the catalog,
 * and fail every one of them when the read failed, the IP blocklist's read
 * included, although a usable snapshot was in memory.
 *
 * The catalog is read in ONE statement, so it is one snapshot: four separate
 * autocommit reads could straddle a migration's commit (its table read
 * before, its columns after), and took up to four pool connections.
 */
import { fuzzyBest } from './fuzzy.js';
import type { Queryable } from './types.js';

export interface ColumnInfo {
  name: string;
  /** format_type(): `uuid`, `text[]`, `timestamp with time zone`, `public.my_enum`. */
  type: string;
  /** pg_type.typname of the column's type (e.g. `tsvector`, `_text`). */
  typname: string;
  generated: boolean;
  /**
   * The SQL a missing value takes under `Prefer: missing=default`: the
   * column's DEFAULT expression, nextval() of an identity column's sequence,
   * or null when it has neither (the value is then NULL).
   */
  defaultExpr: string | null;
}

export interface TableInfo {
  schema: string;
  name: string;
  /** pg_class.relkind: r, p, v, m, f. */
  kind: string;
  columns: Map<string, ColumnInfo>;
  pk: string[];
  /** Primary key and unique constraints, each as its column list. */
  uniqueKeys: string[][];
}

/** A foreign key seen from one side. Every FK yields two of these. */
export interface Relationship {
  constraint: string;
  /** The table the embed starts from. */
  from: TableInfo;
  /** The table being embedded. */
  to: TableInfo;
  /** Columns on `from`, paired index-by-index with `toCols`. */
  fromCols: string[];
  toCols: string[];
  /** True when `from` is the referencing side (holds the FK). */
  forward: boolean;
  /** many-to-one / one-to-one embeds return an object; one-to-many an array. */
  toOne: boolean;
  cardinality: 'many-to-one' | 'one-to-many' | 'one-to-one';
  /** The referencing (FK) columns, whichever side they are on. */
  fkCols: string[];
}

export interface FunctionArg {
  name: string;
  type: string;
  hasDefault: boolean;
}

export type ReturnShape = 'void' | 'scalar' | 'composite' | 'setof-scalar' | 'setof-composite';

export interface FunctionInfo {
  schema: string;
  name: string;
  /** IN / INOUT / VARIADIC parameters in declaration order. */
  args: FunctionArg[];
  returnShape: ReturnShape;
  returnType: string;
  /** Every IN parameter is named (PostgREST can only call those by name). */
  allNamed: boolean;
}

export interface SchemaSnapshot {
  schemas: string[];
  tables: Map<string, TableInfo>;
  relationships: Relationship[];
  functions: Map<string, FunctionInfo[]>;
  loadedAt: number;
}

export function tableKey(schema: string, name: string): string {
  return `${schema}\u0000${name}`;
}

const TABLES_SQL = `
  SELECT c.oid::int8 AS oid, n.nspname AS schema, c.relname AS name, c.relkind::text AS kind
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
     AND n.nspname = ANY($1::text[])`;

const COLUMNS_SQL = `
  SELECT a.attrelid::int8 AS oid, a.attname AS name,
         pg_catalog.format_type(a.atttypid, a.atttypmod) AS type,
         t.typname AS typname,
         (a.attgenerated <> '') AS generated,
         CASE WHEN a.attidentity <> ''
              THEN pg_catalog.format('nextval(%L::regclass)',
                     pg_catalog.pg_get_serial_sequence(pg_catalog.format('%I.%I', n.nspname, c.relname), a.attname))
              ELSE pg_catalog.pg_get_expr(d.adbin, d.adrelid) END AS default_expr
    FROM pg_catalog.pg_attribute a
    JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_catalog.pg_type t ON t.oid = a.atttypid
    LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum AND a.attgenerated = ''
   WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
     AND n.nspname = ANY($1::text[])
     AND a.attnum > 0 AND NOT a.attisdropped
   ORDER BY a.attrelid, a.attnum`;

const CONSTRAINTS_SQL = `
  SELECT con.conname AS name, con.contype::text AS type,
         con.conrelid::int8 AS rel, con.confrelid::int8 AS frel,
         ARRAY(SELECT a.attname::text FROM unnest(con.conkey) WITH ORDINALITY k(num, ord)
                 JOIN pg_catalog.pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.num
                ORDER BY k.ord) AS cols,
         ARRAY(SELECT a.attname::text FROM unnest(con.confkey) WITH ORDINALITY k(num, ord)
                 JOIN pg_catalog.pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.num
                ORDER BY k.ord) AS fcols
    FROM pg_catalog.pg_constraint con
    JOIN pg_catalog.pg_namespace n ON n.oid = con.connamespace
   WHERE con.contype IN ('p', 'u', 'f')
     AND n.nspname = ANY($1::text[])`;

const FUNCTIONS_SQL = `
  SELECT n.nspname AS schema, p.proname AS name,
         p.pronargs::int AS nargs, p.pronargdefaults::int AS ndefaults,
         p.proargnames::text[] AS argnames, p.proargmodes::text[] AS argmodes,
         ARRAY(SELECT pg_catalog.format_type(t, NULL)
                 FROM unnest(coalesce(p.proallargtypes, p.proargtypes::oid[])) WITH ORDINALITY u(t, ord)
                ORDER BY u.ord) AS argtypes,
         p.proretset AS retset,
         pg_catalog.format_type(p.prorettype, NULL) AS rettype,
         rt.typtype::text AS rettyptype,
         (rt.oid = 'pg_catalog.record'::regtype) AS retrecord,
         (rt.oid = 'pg_catalog.void'::regtype) AS retvoid
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_catalog.pg_type rt ON rt.oid = p.prorettype
   WHERE p.prokind = 'f'
     AND n.nspname = ANY($1::text[])`;

interface FunctionRow {
  schema: string;
  name: string;
  nargs: number;
  ndefaults: number;
  argnames: string[] | null;
  argmodes: string[] | null;
  argtypes: string[];
  retset: boolean;
  rettype: string;
  rettyptype: string;
  retrecord: boolean;
  retvoid: boolean;
}

export function functionFromRow(r: FunctionRow): FunctionInfo {
  const modes = r.argmodes ?? r.argtypes.map(() => 'i');
  const names = r.argnames ?? [];
  const inArgs: { name: string; type: string }[] = [];
  let outCount = 0;
  modes.forEach((mode, i) => {
    if (mode === 'i' || mode === 'b' || mode === 'v') inArgs.push({ name: names[i] ?? '', type: r.argtypes[i] });
    if (mode === 'o' || mode === 'b' || mode === 't') outCount++;
  });
  const firstDefault = inArgs.length - r.ndefaults;
  const args = inArgs.map((a, i) => ({ ...a, hasDefault: i >= firstDefault }));

  let returnShape: ReturnShape;
  const composite = r.rettyptype === 'c' || (r.retrecord && outCount > 0);
  if (r.retvoid) returnShape = 'void';
  else if (r.retset) returnShape = composite || r.retrecord ? 'setof-composite' : 'setof-scalar';
  else returnShape = composite ? 'composite' : 'scalar';

  return {
    schema: r.schema,
    name: r.name,
    args,
    returnShape,
    returnType: r.rettype,
    allNamed: args.every((a) => a.name !== ''),
  };
}

/**
 * The four catalog reads as one statement (one snapshot, one connection),
 * each as a JSON array. Columns keep their table's attnum order.
 */
export const CATALOG_SQL = `
  SELECT (SELECT coalesce(json_agg(t), '[]'::json) FROM (${TABLES_SQL}) t) AS tables,
         (SELECT coalesce(json_agg(t), '[]'::json) FROM (${COLUMNS_SQL}) t) AS columns,
         (SELECT coalesce(json_agg(t), '[]'::json) FROM (${CONSTRAINTS_SQL}) t) AS constraints,
         (SELECT coalesce(json_agg(t), '[]'::json) FROM (${FUNCTIONS_SQL}) t) AS functions`;

interface CatalogRow {
  tables: { oid: string | number; schema: string; name: string; kind: string }[];
  columns: { oid: string | number; name: string; type: string; typname: string; generated: boolean; default_expr: string | null }[];
  constraints: { name: string; type: string; rel: string | number; frel: string | number; cols: string[]; fcols: string[] }[];
  functions: FunctionRow[];
}

export async function loadSchema(db: Queryable, schemas: string[]): Promise<SchemaSnapshot> {
  const { rows } = await db.query<CatalogRow>(CATALOG_SQL, [schemas]);
  const catalog = rows[0];
  if (!catalog) throw new Error('schema cache: the catalog read returned no row');
  const tablesRes = { rows: catalog.tables };
  const columnsRes = { rows: catalog.columns };
  const constraintsRes = { rows: catalog.constraints };
  const functionsRes = { rows: catalog.functions };

  const byOid = new Map<string, TableInfo>();
  const tables = new Map<string, TableInfo>();
  for (const r of tablesRes.rows) {
    const t: TableInfo = { schema: r.schema, name: r.name, kind: r.kind, columns: new Map(), pk: [], uniqueKeys: [] };
    byOid.set(String(r.oid), t);
    tables.set(tableKey(r.schema, r.name), t);
  }
  for (const r of columnsRes.rows) {
    byOid.get(String(r.oid))?.columns.set(r.name, {
      name: r.name,
      type: r.type,
      typname: r.typname,
      generated: r.generated,
      defaultExpr: r.default_expr,
    });
  }

  const fks: { name: string; rel: TableInfo; frel: TableInfo; cols: string[]; fcols: string[] }[] = [];
  for (const r of constraintsRes.rows) {
    const rel = byOid.get(String(r.rel));
    if (!rel) continue;
    if (r.type === 'p') {
      rel.pk = r.cols;
      rel.uniqueKeys.push(r.cols);
    } else if (r.type === 'u') {
      rel.uniqueKeys.push(r.cols);
    } else {
      // A foreign key to a table outside the exposed schemas (auth.users,
      // say) is not embeddable, exactly as in PostgREST.
      const frel = byOid.get(String(r.frel));
      if (frel) fks.push({ name: r.name, rel, frel, cols: r.cols, fcols: r.fcols });
    }
  }

  const isUnique = (t: TableInfo, cols: string[]) =>
    t.uniqueKeys.some((k) => k.length === cols.length && k.every((c) => cols.includes(c)));

  const relationships: Relationship[] = [];
  for (const fk of fks) {
    const oneToOne = isUnique(fk.rel, fk.cols);
    relationships.push({
      constraint: fk.name,
      from: fk.rel,
      to: fk.frel,
      fromCols: fk.cols,
      toCols: fk.fcols,
      forward: true,
      toOne: true,
      cardinality: oneToOne ? 'one-to-one' : 'many-to-one',
      fkCols: fk.cols,
    });
    relationships.push({
      constraint: fk.name,
      from: fk.frel,
      to: fk.rel,
      fromCols: fk.fcols,
      toCols: fk.cols,
      forward: false,
      toOne: oneToOne,
      cardinality: oneToOne ? 'one-to-one' : 'one-to-many',
      fkCols: fk.cols,
    });
  }

  const functions = new Map<string, FunctionInfo[]>();
  for (const r of functionsRes.rows) {
    const fn = functionFromRow(r);
    const key = tableKey(fn.schema, fn.name);
    functions.set(key, [...(functions.get(key) ?? []), fn]);
  }

  return { schemas, tables, relationships, functions, loadedAt: Date.now() };
}

/** Single-flight, miss-driven cache around loadSchema(). */
export class SchemaCache {
  private current: SchemaSnapshot | null = null;
  private inflight: Promise<SchemaSnapshot> | null = null;
  /** When the last reload failed (0: the last one did not). */
  private failedAt = 0;

  constructor(
    private readonly db: Queryable,
    readonly schemas: string[],
    private readonly maxAgeMs = 5 * 60_000,
    /** A miss may force a reload at most this often. */
    private readonly minReloadGapMs = 1_000,
    /** After a failed reload, the age refresh waits this long before it tries again. */
    private readonly retryGapMs = 10_000,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * The snapshot to answer with. Only the first load is awaited; an old
   * snapshot is served while one refresh runs in the background.
   */
  async get(): Promise<SchemaSnapshot> {
    const current = this.current;
    if (!current) return this.reload();
    if (this.now() - current.loadedAt >= this.maxAgeMs) this.refreshInBackground();
    return current;
  }

  /** Starts the age refresh unless one runs, or the last one failed less than retryGapMs ago. */
  private refreshInBackground(): void {
    if (this.inflight) return;
    if (this.failedAt && this.now() - this.failedAt < this.retryGapMs) return;
    this.reload().catch(() => undefined); // logged by reload()
  }

  /**
   * Reload unless the snapshot is younger than `minReloadGapMs` — a burst of
   * requests that all miss the same object costs one catalog read, and a
   * request for something that truly does not exist cannot turn into a reload
   * per request. Returns whether the snapshot is newer than `seen`.
   */
  async refreshAfterMiss(seen: SchemaSnapshot): Promise<SchemaSnapshot | null> {
    if (this.current && this.current !== seen) return this.current;
    const now = this.now();
    // A failed reload counts as one: a miss right after it does not try again.
    if (now - seen.loadedAt < this.minReloadGapMs || (this.failedAt && now - this.failedAt < this.minReloadGapMs)) return null;
    const next = await this.reload();
    return next === seen ? null : next;
  }

  reload(): Promise<SchemaSnapshot> {
    if (!this.inflight) {
      this.inflight = loadSchema(this.db, this.schemas)
        .then((snap) => {
          snap.loadedAt = this.now();
          this.current = snap;
          this.failedAt = 0;
          return snap;
        })
        .catch((err: unknown) => {
          this.failedAt = this.now();
          console.warn(
            `[db] schema cache reload failed${this.current ? ', serving the snapshot loaded ' + Math.round((this.now() - this.current.loadedAt) / 1000) + ' s ago' : ''}:`,
            (err as Error | null)?.message || err,
          );
          throw err;
        })
        .finally(() => {
          this.inflight = null;
        });
    }
    return this.inflight;
  }
}

// ── lookups shared by the planner ──────────────────────────────────────────

/** PostgREST's "Perhaps you meant ..." — see ./fuzzy.ts. */
export function closest(name: string, candidates: Iterable<string>): string | undefined {
  return fuzzyBest(name, candidates);
}
