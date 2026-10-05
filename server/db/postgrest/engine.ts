/**
 * An in-process PostgREST: answers the HTTP requests supabase-js makes, by
 * running SQL on a PostgreSQL connection pool.
 *
 * Why this shape. The backend has ~2,700 `.from()` and ~230 `.rpc()` call
 * sites written against supabase-js. Keeping supabase-js as the query builder
 * and swapping only its `fetch` (see ../pgFetch.ts) means none of them change,
 * and every behaviour they rely on — maybeSingle, count from Content-Range,
 * error objects, throwOnError, retries of reads — stays supabase-js's own code.
 * What changes is the server: instead of Supabase's PostgREST over HTTPS, this
 * file, over a direct `DATABASE_URL` connection. So the same build runs on any
 * PostgreSQL, and on Supabase it uses nothing but the database.
 *
 * Every request is one SQL statement (autocommit), as in PostgREST. A
 * `.single()` mutation that matches more than one row aborts its own statement,
 * so the write is rolled back exactly as PostgREST rolls it back.
 */
import {
  PgrstError,
  ambiguousFunction,
  badRequest,
  fromPgError,
  functionNotFound,
  isPgServerError,
  singularityError,
} from './errors.js';
import {
  Planner,
  SchemaMiss,
  effectiveLimit,
  parseQueryParams,
  type QueryParams,
} from './plan.js';
import { type FunctionInfo, type SchemaCache, type SchemaSnapshot, type TableInfo, closest, tableKey } from './schemaCache.js';
import { Params, qi, qtable } from './sql.js';
import type { EngineRequest, EngineResponse, Queryable } from './types.js';

export interface EngineOptions {
  /** PostgREST `db-max-rows`. Supabase's default is 1000; 0 = unlimited. */
  maxRows: number;
}

interface Prefer {
  representation: boolean;
  count: boolean;
  resolution?: 'merge' | 'ignore';
  missingDefault: boolean;
}

function parsePrefer(headers: Headers): Prefer {
  const tokens = (headers.get('prefer') ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  const prefer: Prefer = { representation: false, count: false, missingDefault: false };
  for (const t of tokens) {
    if (t === 'return=representation') prefer.representation = true;
    else if (t === 'return=minimal' || t === 'return=headers-only') prefer.representation = false;
    else if (t.startsWith('count=')) prefer.count = true; // exact, planned and estimated are all answered exactly
    else if (t === 'resolution=merge-duplicates') prefer.resolution = 'merge';
    else if (t === 'resolution=ignore-duplicates') prefer.resolution = 'ignore';
    else if (t === 'missing=default') prefer.missingDefault = true;
  }
  return prefer;
}

const STATUS_TEXT: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  204: 'No Content',
  206: 'Partial Content',
  300: 'Multiple Choices',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  406: 'Not Acceptable',
  409: 'Conflict',
  500: 'Internal Server Error',
  501: 'Not Implemented',
  503: 'Service Unavailable',
};

export function statusText(status: number): string {
  return STATUS_TEXT[status] ?? '';
}

function errorResponse(err: PgrstError): EngineResponse {
  const { code, details, hint, message } = err.body;
  return { status: err.status, headers: {}, body: JSON.stringify({ code, details, hint, message }) };
}

function contentRange(offset: number, rows: number, total: number | null): string {
  const t = total === null ? '*' : String(total);
  return rows > 0 ? `${offset}-${offset + rows - 1}/${t}` : `*/${t}`;
}

/** Marker the single-row guard raises to abort a multi-row `.single()` mutation. */
const SINGULAR_GUARD = 'pgrst_singular:';

export class PostgrestEngine {
  constructor(
    private readonly db: Queryable,
    private readonly cache: SchemaCache,
    private readonly options: EngineOptions,
  ) {}

  async handle(req: EngineRequest): Promise<EngineResponse> {
    let snapshot = await this.cache.get();
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.dispatch(req, snapshot);
      } catch (err) {
        // A name the cache does not know may be a migration applied after it
        // loaded: reload once and retry before answering "not found".
        const stale =
          err instanceof SchemaMiss || (isPgServerError(err) && err.code === '42883' && req.path.startsWith('/rpc/'));
        if (stale && attempt === 0) {
          const next = await this.cache.refreshAfterMiss(snapshot);
          if (next) {
            snapshot = next;
            continue;
          }
        }
        if (err instanceof SchemaMiss) return errorResponse(err.error);
        if (err instanceof PgrstError) return errorResponse(err);
        if (isPgServerError(err)) {
          if (err.code === '22P02' && err.message?.includes(SINGULAR_GUARD)) {
            const rows = Number(/pgrst_singular:(\d+)/.exec(err.message)?.[1] ?? 0);
            return errorResponse(singularityError(rows));
          }
          return errorResponse(fromPgError(err));
        }
        // A socket or pool failure has no SQLSTATE. Rethrow it: supabase-js
        // turns a thrown fetch into `{ error }` and retries reads, which is
        // how an unreachable PostgREST already behaved.
        throw err;
      }
    }
  }

  private schemaFor(req: EngineRequest, snapshot: SchemaSnapshot): string {
    const read = req.method === 'GET' || req.method === 'HEAD';
    const requested = req.headers.get(read ? 'accept-profile' : 'content-profile');
    const schema = requested ?? snapshot.schemas[0];
    if (!snapshot.schemas.includes(schema)) {
      throw new PgrstError(406, {
        code: 'PGRST106',
        message: `The schema must be one of the following: ${snapshot.schemas.join(', ')}`,
        details: null,
        hint: null,
      });
    }
    return schema;
  }

  private dispatch(req: EngineRequest, snapshot: SchemaSnapshot): Promise<EngineResponse> {
    const schema = this.schemaFor(req, snapshot);
    const single = (req.headers.get('accept') ?? '').includes('application/vnd.pgrst.object+json');
    const prefer = parsePrefer(req.headers);
    const segments = req.path.split('/').filter(Boolean).map(decodeURIComponent);

    if (segments[0] === 'rpc' && segments.length === 2) {
      return this.rpc(snapshot, schema, segments[1], req, prefer, single);
    }
    if (segments.length !== 1) {
      throw badRequest('PGRST100', `unsupported path: ${req.path}`);
    }
    const planner = new Planner(snapshot, schema);
    const table = planner.table(segments[0]);
    switch (req.method) {
      case 'GET':
      case 'HEAD':
        return this.read(planner, table, parseQueryParams(req.query), prefer, single, req.method === 'HEAD');
      case 'POST':
        return this.insert(planner, table, req, prefer, single);
      case 'PATCH':
        return this.update(planner, table, req, prefer, single);
      case 'DELETE':
        return this.remove(planner, table, req, prefer, single);
      default:
        throw new PgrstError(405, { code: 'PGRST117', message: `Unsupported HTTP method: ${req.method}`, details: null, hint: null });
    }
  }

  // ── reads ────────────────────────────────────────────────────────────────

  private async read(
    planner: Planner,
    table: TableInfo,
    params: QueryParams,
    prefer: Prefer,
    single: boolean,
    head: boolean,
  ): Promise<EngineResponse> {
    const root = planner.readTree(table, params.select, params);
    const p = new Params();
    const top = planner.selectSql(root, p, { maxRows: this.options.maxRows });
    let countSql = 'NULL::bigint';
    if (prefer.count) {
      const where = planner.whereParts(root, p);
      countSql = `(SELECT pg_catalog.count(*) FROM ${qtable(table.schema, table.name)} AS ${qi(root.alias)}${where.length ? ` WHERE ${where.join(' AND ')}` : ''})`;
    }
    const body = head ? `''` : single ? `(json_agg(_pgrst_t) -> 0)::text` : `coalesce(json_agg(_pgrst_t), '[]')::text`;
    const sql = `SELECT ${countSql} AS total, pg_catalog.count(*) AS page, ${body} AS body FROM (${top}) AS _pgrst_t`;
    const { rows } = await this.db.query<{ total: string | null; page: string; body: string }>(sql, p.values);
    const page = Number(rows[0].page);
    const total = rows[0].total === null ? null : Number(rows[0].total);
    if (single && page !== 1) throw singularityError(page);
    const offset = root.offset ?? 0;
    const partial = total !== null && (offset > 0 || offset + page < total);
    return {
      status: partial ? 206 : 200,
      headers: { 'content-range': contentRange(offset, page, total) },
      body: head ? '' : rows[0].body,
    };
  }

  // ── writes ───────────────────────────────────────────────────────────────

  /**
   * Runs `WITH pgrst_source AS (<mutation> RETURNING ...)` and shapes the
   * representation from it. A `.single()` mutation that touched more than one
   * row raises inside the statement, so the write never commits.
   */
  private async mutate(
    planner: Planner,
    table: TableInfo,
    params: QueryParams,
    mutation: (returning: string) => string,
    p: Params,
    prefer: Prefer,
    single: boolean,
    kind: 'insert' | 'upsert' | 'update' | 'delete',
  ): Promise<EngineResponse> {
    const alias = table.name;
    const representation = prefer.representation || single;
    const guard = single ? `CASE WHEN pg_catalog.count(*) > 1 THEN ('${SINGULAR_GUARD}' || pg_catalog.count(*))::int ELSE 0 END` : '0';
    // PostgREST answers an upsert that only updated existing rows with 200,
    // and one that inserted anything with 201; xmax = 0 marks a fresh row.
    const upsert = kind === 'upsert';
    const insertedFlag = upsert ? `, (${qi(alias)}.xmax = 0) AS pgrst_inserted` : '';
    const inserted = upsert ? `(SELECT coalesce(bool_or(pgrst_inserted), true) FROM pgrst_source)` : 'true';
    let sql: string;
    if (representation) {
      const root = planner.readTree(
        table,
        params.select,
        { ...params, filters: new Map(), logic: new Map(), order: new Map(), limit: new Map(), offset: new Map() },
        alias,
      );
      root.explicitStar = upsert;
      const shaped = planner.selectSql(root, p, { from: 'pgrst_source' });
      const body = single ? `(json_agg(_pgrst_t) -> 0)::text` : `coalesce(json_agg(_pgrst_t), '[]')::text`;
      sql = `WITH pgrst_source AS (${mutation(`${qi(alias)}.*${insertedFlag}`)}) SELECT ${guard} AS guard, pg_catalog.count(*) AS page, ${body} AS body, ${inserted} AS inserted FROM (${shaped}) AS _pgrst_t`;
    } else {
      const returning = upsert ? insertedFlag.slice(2) : '1';
      sql = `WITH pgrst_source AS (${mutation(returning)}) SELECT ${guard} AS guard, pg_catalog.count(*) AS page, '' AS body, ${inserted} AS inserted FROM pgrst_source`;
    }
    const { rows } = await this.db.query<{ page: string; body: string; inserted: boolean }>(sql, p.values);
    const page = Number(rows[0].page);
    if (single && page !== 1) throw singularityError(page);
    const total = prefer.count ? page : null;
    const created = kind === 'insert' || (upsert && (page === 0 || rows[0].inserted));
    const writesRows = kind === 'insert' || kind === 'upsert';
    if (!representation) {
      return {
        status: writesRows ? (created ? 201 : 200) : 204,
        headers: { 'content-range': writesRows ? `*/${total ?? '*'}` : contentRange(0, total ?? 0, total) },
        body: '',
      };
    }
    return {
      status: created ? 201 : 200,
      headers: { 'content-range': writesRows ? `*/${total ?? '*'}` : contentRange(0, page, total) },
      body: rows[0].body,
    };
  }

  private parseBody(req: EngineRequest): unknown {
    if (req.body === null || req.body === '') return {};
    try {
      return JSON.parse(req.body);
    } catch {
      throw badRequest('PGRST102', 'Empty or invalid json');
    }
  }

  private async insert(planner: Planner, table: TableInfo, req: EngineRequest, prefer: Prefer, single: boolean): Promise<EngineResponse> {
    const params = parseQueryParams(req.query);
    const payload = this.parseBody(req);
    const rows = (Array.isArray(payload) ? payload : [payload]) as Record<string, unknown>[];
    if (rows.some((r) => r === null || typeof r !== 'object' || Array.isArray(r))) {
      throw badRequest('PGRST102', 'All object keys must match');
    }
    if (prefer.missingDefault) {
      throw new PgrstError(501, {
        code: 'PGRST128',
        message: 'Prefer: missing=default is not supported by this server',
        details: null,
        hint: null,
      });
    }
    // supabase-js sends `columns` for an array (the union of its keys); a
    // single object inserts exactly the keys it has.
    const cols = params.columns ?? Object.keys(rows[0] ?? {});
    planner.checkColumns(table, cols);
    const target = qtable(table.schema, table.name);
    const alias = qi(table.name);

    let conflict = '';
    if (prefer.resolution) {
      const keys = params.onConflict ?? table.pk;
      if (keys.length) {
        planner.checkColumns(table, keys);
        const on = keys.map(qi).join(', ');
        conflict =
          prefer.resolution === 'ignore' || cols.length === 0
            ? ` ON CONFLICT (${on}) DO NOTHING`
            : ` ON CONFLICT (${on}) DO UPDATE SET ${cols.map((c) => `${qi(c)} = EXCLUDED.${qi(c)}`).join(', ')}`;
      }
    }

    if (rows.length > 1 && cols.length === 0) throw badRequest('PGRST102', 'All object keys must match');

    const p = new Params();
    const kind = prefer.resolution ? 'upsert' : 'insert';
    const mutation = (returning: string) => {
      // `[]` inserts nothing; the statement keeps its shape so the answer is `[]`.
      if (rows.length === 0) return `SELECT ${returning} FROM ${target} AS ${alias} WHERE false`;
      // `{}` — every column takes its default.
      if (cols.length === 0) return `INSERT INTO ${target} AS ${alias} DEFAULT VALUES RETURNING ${returning}`;
      const list = cols.map(qi).join(', ');
      const body = p.add(JSON.stringify(rows));
      return `INSERT INTO ${target} AS ${alias} (${list}) SELECT ${list} FROM json_populate_recordset(NULL::${target}, ${body}::json) AS pgrst_body${conflict} RETURNING ${returning}`;
    };
    return this.mutate(planner, table, params, mutation, p, prefer, single, kind);
  }

  /** WHERE for PATCH/DELETE, plus PostgREST 13's limited update/delete (`limit`/`order`). */
  private targetWhere(planner: Planner, table: TableInfo, params: QueryParams, p: Params): string {
    const root = planner.readTree(table, [{ kind: 'star' }], params);
    const where = planner.whereParts(root, p);
    if (root.limit !== undefined || root.offset !== undefined) {
      const inner = planner.selectSql(root, p, { columns: `${qi(root.alias)}.ctid` });
      where.push(`${qi(root.alias)}.ctid = ANY(ARRAY(${inner}))`);
    }
    return where.length ? ` WHERE ${where.join(' AND ')}` : '';
  }

  private async update(planner: Planner, table: TableInfo, req: EngineRequest, prefer: Prefer, single: boolean): Promise<EngineResponse> {
    const params = parseQueryParams(req.query);
    const payload = this.parseBody(req);
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      throw badRequest('PGRST102', 'Empty or invalid json');
    }
    const cols = Object.keys(payload);
    planner.checkColumns(table, cols);
    const target = qtable(table.schema, table.name);
    const alias = qi(table.name);
    const p = new Params();
    const mutation = (returning: string) => {
      // PostgREST treats an empty PATCH as a no-op that matches nothing.
      if (cols.length === 0) return `SELECT ${returning} FROM ${target} AS ${alias} WHERE false`;
      const body = p.add(JSON.stringify(payload));
      const where = this.targetWhere(planner, table, params, p);
      return `UPDATE ${target} AS ${alias} SET ${cols.map((c) => `${qi(c)} = pgrst_body.${qi(c)}`).join(', ')} FROM (SELECT * FROM json_populate_record(NULL::${target}, ${body}::json)) AS pgrst_body${where} RETURNING ${returning}`;
    };
    return this.mutate(planner, table, params, mutation, p, prefer, single, 'update');
  }

  private async remove(planner: Planner, table: TableInfo, req: EngineRequest, prefer: Prefer, single: boolean): Promise<EngineResponse> {
    const params = parseQueryParams(req.query);
    const target = qtable(table.schema, table.name);
    const alias = qi(table.name);
    const p = new Params();
    const mutation = (returning: string) =>
      `DELETE FROM ${target} AS ${alias}${this.targetWhere(planner, table, params, p)} RETURNING ${returning}`;
    return this.mutate(planner, table, params, mutation, p, prefer, single, 'delete');
  }

  // ── functions ────────────────────────────────────────────────────────────

  private resolveFunction(snapshot: SchemaSnapshot, schema: string, name: string, keys: string[]): FunctionInfo {
    const candidates = snapshot.functions.get(tableKey(schema, name)) ?? [];
    const singleJson = (f: FunctionInfo) =>
      f.args.length === 1 && f.args[0].name === '' && (f.args[0].type === 'json' || f.args[0].type === 'jsonb');
    let matches = candidates.filter((f) => {
      if (singleJson(f)) return true;
      if (!f.allNamed) return false;
      const names = new Set(f.args.map((a) => a.name));
      return keys.every((k) => names.has(k)) && f.args.every((a) => a.hasDefault || keys.includes(a.name));
    });
    if (matches.length > 1) {
      const exact = matches.filter((f) => !singleJson(f) && f.args.length === keys.length);
      if (exact.length === 1) matches = exact;
    }
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      throw ambiguousFunction(schema, name, matches.map((f) => f.args.map((a) => `${a.name} => ${a.type}`).join(', ')));
    }
    const sameName = candidates[0];
    const suggestion = sameName
      ? `${name}(${sameName.args.map((a) => a.name).join(', ')})`
      : closest(
          name,
          [...snapshot.functions.values()].flat().filter((f) => f.schema === schema).map((f) => f.name),
        );
    throw new SchemaMiss(functionNotFound(schema, name, keys, suggestion));
  }

  private async rpc(
    snapshot: SchemaSnapshot,
    schema: string,
    name: string,
    req: EngineRequest,
    prefer: Prefer,
    single: boolean,
  ): Promise<EngineResponse> {
    let args: Record<string, unknown>;
    if (req.method === 'POST') {
      const body = this.parseBody(req);
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        throw badRequest('PGRST102', 'Bulk RPC calls are not supported by this server');
      }
      args = body as Record<string, unknown>;
    } else if (req.method === 'GET' || req.method === 'HEAD') {
      args = {};
      const fnArgs = new Set((snapshot.functions.get(tableKey(schema, name)) ?? []).flatMap((f) => f.args.map((a) => a.name)));
      for (const [k, v] of req.query) if (fnArgs.has(k)) args[k] = v;
    } else {
      throw new PgrstError(405, { code: 'PGRST101', message: 'Only GET, HEAD and POST are allowed for RPC', details: null, hint: null });
    }

    const keys = Object.keys(args);
    const fn = this.resolveFunction(snapshot, schema, name, keys);
    const params = parseQueryParams(req.query, new Set(req.method === 'POST' ? [] : keys));
    const p = new Params();
    const qfn = qtable(fn.schema, fn.name);

    let from: string;
    let call: string;
    if (fn.args.length === 1 && fn.args[0].name === '' && (fn.args[0].type === 'json' || fn.args[0].type === 'jsonb')) {
      call = `${qfn}(${p.add(JSON.stringify(args))}::${fn.args[0].type})`;
      from = '';
    } else if (keys.length === 0) {
      call = `${qfn}()`;
      from = '';
    } else {
      const byName = new Map(fn.args.map((a) => [a.name, a]));
      const cols = keys.map((k) => `${qi(k)} ${byName.get(k)!.type}`).join(', ');
      call = `${qfn}(${keys.map((k) => `${qi(k)} := pgrst_args.${qi(k)}`).join(', ')})`;
      from = `json_to_record(${p.add(JSON.stringify(args))}::json) AS pgrst_args(${cols})`;
    }
    const fromList = (extra: string) => (from ? `FROM ${from}${extra ? `, LATERAL ${extra}` : ''}` : extra ? `FROM ${extra}` : '');

    switch (fn.returnShape) {
      case 'void': {
        await this.db.query(`SELECT ${call} ${fromList('')}`, p.values);
        return { status: 204, headers: { 'content-range': '0-0/*' }, body: '' };
      }
      case 'scalar': {
        const { rows } = await this.db.query<{ body: string | null }>(`SELECT to_json(${call})::text AS body ${fromList('')}`, p.values);
        return { status: 200, headers: { 'content-range': '0-0/*' }, body: rows[0]?.body ?? 'null' };
      }
      case 'composite': {
        const { rows } = await this.db.query<{ body: string | null }>(
          `SELECT to_json(pgrst_call)::text AS body ${fromList(`${call} AS pgrst_call`)}`,
          p.values,
        );
        const body = rows[0]?.body ?? 'null';
        if (single && rows.length !== 1) throw singularityError(rows.length);
        return { status: 200, headers: { 'content-range': '0-0/*' }, body };
      }
      case 'setof-scalar': {
        const limit = effectiveLimit(params.limit.get(''), this.options.maxRows);
        const offset = params.offset.get('') ?? 0;
        const inner = `SELECT pgrst_call AS pgrst_scalar ${fromList(`${call} AS pgrst_call`)}${limit !== undefined ? ` LIMIT ${limit}` : ''}${offset ? ` OFFSET ${offset}` : ''}`;
        const body = single ? `(json_agg(_pgrst_t.pgrst_scalar) -> 0)::text` : `coalesce(json_agg(_pgrst_t.pgrst_scalar), '[]')::text`;
        const { rows } = await this.db.query<{ page: string; body: string }>(
          `SELECT pg_catalog.count(*) AS page, ${body} AS body FROM (${inner}) AS _pgrst_t`,
          p.values,
        );
        const page = Number(rows[0].page);
        if (single && page !== 1) throw singularityError(page);
        return { status: 200, headers: { 'content-range': contentRange(offset, page, null) }, body: rows[0].body };
      }
      case 'setof-composite': {
        const planner = new Planner(snapshot, schema);
        const rowType = this.rowTable(snapshot, schema, fn);
        const root = planner.readTree(rowType, params.select, params, fn.name);
        const source = `(SELECT pgrst_call.* ${fromList(`${call} AS pgrst_call`)})`;
        const top = planner.selectSql(root, p, { from: source, maxRows: this.options.maxRows });
        const body = single ? `(json_agg(_pgrst_t) -> 0)::text` : `coalesce(json_agg(_pgrst_t), '[]')::text`;
        const { rows } = await this.db.query<{ page: string; body: string }>(
          `SELECT pg_catalog.count(*) AS page, ${body} AS body FROM (${top}) AS _pgrst_t`,
          p.values,
        );
        const page = Number(rows[0].page);
        if (single && page !== 1) throw singularityError(page);
        const offset = root.offset ?? 0;
        return { status: 200, headers: { 'content-range': contentRange(offset, page, null) }, body: rows[0].body };
      }
    }
  }

  /** The table a set-returning function's rows belong to, when it returns one; else an anonymous row type. */
  private rowTable(snapshot: SchemaSnapshot, schema: string, fn: FunctionInfo): TableInfo {
    const bare = fn.returnType.replace(/^.*\./, '').replace(/"/g, '');
    return (
      snapshot.tables.get(tableKey(schema, bare)) ?? {
        schema,
        name: fn.name,
        kind: 'f',
        columns: new Map(),
        pk: [],
        uniqueKeys: [],
      }
    );
  }
}
