/**
 * Request → SQL. One PostgREST request becomes one SQL statement whose result
 * row already holds the response: the JSON body (built by Postgres, as
 * PostgREST builds it), the page size and, when asked for, the exact count.
 *
 * Shapes follow PostgREST 14.5 (what the production project runs), checked
 * against the real binary by src/test/integration/postgrestEngineParity.pg.test.ts:
 *   * the top level is json_agg of the rows, in select order;
 *   * an embed is jsonb (to_jsonb / jsonb_agg — so its keys come back in jsonb
 *     order), `null` for a missing to-one row and `[]` for an empty to-many;
 *   * a filter on an embed narrows the embed; with `!inner` it also drops the
 *     parent rows whose embed came back empty;
 *   * bulk inserts take the union of the rows' keys (supabase-js's `columns`)
 *     and a key missing from a row is NULL, not the column default.
 */
import {
  type FieldRef,
  type Filter,
  type LogicTree,
  type OpExpr,
  type OrderTerm,
  type SelectItem,
  parseColumns,
  parseFilterKey,
  parseLogicValue,
  parseOnConflict,
  parseOpExpr,
  parseOrder,
  parseSelect,
} from './grammar.js';
import {
  PgrstError,
  ambiguousRelationship,
  badRequest,
  columnNotFound,
  relationshipNotFound,
  tableNotFound,
} from './errors.js';
import { type Relationship, type SchemaSnapshot, type TableInfo, closest, tableKey } from './schemaCache.js';
import { Params, qi, ql, qtable, safeTypeName } from './sql.js';

/** Thrown for a name the schema cache does not know; the engine reloads once and retries. */
export class SchemaMiss extends Error {
  constructor(readonly error: PgrstError) {
    super(error.message);
  }
}

// ── request parameters ──────────────────────────────────────────────────────

export interface QueryParams {
  select: SelectItem[] | null;
  columns: string[] | null;
  onConflict: string[] | null;
  /** Keyed by embed path ('' = the top level, 'a.b' = embed b inside a). */
  filters: Map<string, Filter[]>;
  logic: Map<string, LogicTree[]>;
  order: Map<string, OrderTerm[]>;
  limit: Map<string, number>;
  offset: Map<string, number>;
  /** Params that are neither reserved nor filters — GET-style RPC args. */
  plain: Map<string, string>;
}

const LOGIC_KEY = /^(?:(.*)\.)?(not\.)?(or|and)$/;

function intParam(v: string, key: string): number {
  if (!/^\d+$/.test(v)) throw badRequest('PGRST100', `"failed to parse ${key} parameter (${v})"`);
  return Number(v);
}

export function parseQueryParams(query: URLSearchParams, rpcArgNames?: Set<string>): QueryParams {
  const out: QueryParams = {
    select: null,
    columns: null,
    onConflict: null,
    filters: new Map(),
    logic: new Map(),
    order: new Map(),
    limit: new Map(),
    offset: new Map(),
    plain: new Map(),
  };
  const push = <T>(m: Map<string, T[]>, k: string, v: T) => m.set(k, [...(m.get(k) ?? []), v]);

  for (const [key, value] of query) {
    if (key === 'select') {
      out.select = parseSelect(value);
    } else if (key === 'columns') {
      out.columns = parseColumns(value);
    } else if (key === 'on_conflict') {
      out.onConflict = parseOnConflict(value);
    } else if (key === 'order' || key.endsWith('.order')) {
      const path = key === 'order' ? '' : key.slice(0, -'.order'.length);
      out.order.set(path, [...(out.order.get(path) ?? []), ...parseOrder(value)]);
    } else if (key === 'limit' || key.endsWith('.limit')) {
      out.limit.set(key === 'limit' ? '' : key.slice(0, -'.limit'.length), intParam(value, key));
    } else if (key === 'offset' || key.endsWith('.offset')) {
      out.offset.set(key === 'offset' ? '' : key.slice(0, -'.offset'.length), intParam(value, key));
    } else if (LOGIC_KEY.test(key) && value.startsWith('(')) {
      const m = LOGIC_KEY.exec(key)!;
      push(out.logic, m[1] ?? '', parseLogicValue(m[3] as 'and' | 'or', !!m[2], value, key));
    } else if (rpcArgNames?.has(key)) {
      out.plain.set(key, value);
    } else {
      const { path, field } = parseFilterKey(key);
      push(out.filters, path.join('.'), { field, expr: parseOpExpr(value, key) });
    }
  }
  return out;
}

// ── the read tree ───────────────────────────────────────────────────────────

interface ReadNode {
  table: TableInfo;
  /** SQL alias; the table's own name at the top level, `<table>_<n>` below. */
  alias: string;
  items: PlannedItem[];
  filters: Filter[];
  logic: LogicTree[];
  order: OrderTerm[];
  limit?: number;
  offset?: number;
  /** `embed=is.null` / `embed=not.is.null` — filters on an embed's existence. */
  existence: { embed: EmbedPlan; exists: boolean }[];
  embeds: EmbedPlan[];
  /** Expand `*` to the table's columns (the source carries extra columns). */
  explicitStar?: boolean;
}

type PlannedItem =
  | { kind: 'star' }
  | { kind: 'field'; field: FieldRef; output: string; cast?: string }
  | { kind: 'embed'; embed: EmbedPlan };

interface EmbedPlan {
  node: ReadNode;
  rel: Relationship;
  output: string;
  /** The name filters/order/limit address this embed by (alias, else name). */
  pathName: string;
  inner: boolean;
}

export class Planner {
  private aliasCounter = 0;

  constructor(
    readonly snapshot: SchemaSnapshot,
    readonly schema: string,
  ) {}

  table(name: string): TableInfo {
    const t = this.snapshot.tables.get(tableKey(this.schema, name));
    if (t) return t;
    const names = [...this.snapshot.tables.values()].filter((x) => x.schema === this.schema).map((x) => x.name);
    throw new SchemaMiss(tableNotFound(this.schema, name, closest(name, names)));
  }

  /** Build the read tree for `table` and attach every filter to its node. */
  readTree(table: TableInfo, select: SelectItem[] | null, params: QueryParams, topAlias?: string): ReadNode & { explicitStar?: boolean } {
    const root = this.node(table, select ?? [{ kind: 'star' }], topAlias ?? table.name);
    const nodes = new Map<string, ReadNode>([['', root]]);
    const index = (node: ReadNode, prefix: string) => {
      for (const e of node.embeds) {
        const p = prefix ? `${prefix}.${e.pathName}` : e.pathName;
        nodes.set(p, e.node);
        index(e.node, p);
      }
    };
    index(root, '');

    const at = (path: string): ReadNode => {
      const n = nodes.get(path);
      if (n) return n;
      const name = path.split('.').pop() as string;
      throw new PgrstError(400, {
        code: 'PGRST108',
        message: `'${name}' is not an embedded resource in this request`,
        details: null,
        hint: `Verify that '${name}' is included in the 'select' query parameter.`,
      });
    };

    for (const [path, filters] of params.filters) {
      const node = at(path);
      for (const f of filters) {
        const embed = !f.field.json.length ? node.embeds.find((e) => e.pathName === f.field.name) : undefined;
        if (embed && f.expr.operation.op === 'is' && (f.expr.operation.value === 'null' || f.expr.operation.value === 'not_null')) {
          const isNull = f.expr.operation.value === 'null';
          node.existence.push({ embed, exists: f.expr.negate ? isNull : !isNull });
        } else {
          node.filters.push(f);
        }
      }
    }
    for (const [path, trees] of params.logic) at(path).logic.push(...trees);
    for (const [path, terms] of params.order) at(path).order.push(...terms);
    for (const [path, n] of params.limit) at(path).limit = n;
    for (const [path, n] of params.offset) at(path).offset = n;
    return root;
  }

  private node(table: TableInfo, select: SelectItem[], alias: string): ReadNode {
    const node: ReadNode = {
      table,
      alias,
      items: [],
      filters: [],
      logic: [],
      order: [],
      existence: [],
      embeds: [],
    };
    for (const item of select) {
      if (item.kind === 'star') {
        node.items.push({ kind: 'star' });
      } else if (item.kind === 'field') {
        if (item.aggregate) {
          throw new PgrstError(400, {
            code: 'PGRST123',
            message: 'Use of aggregate functions is not allowed',
            details: null,
            hint: null,
          });
        }
        node.items.push({ kind: 'field', field: item.field, output: outputName(item.field, item.alias), cast: item.cast });
      } else {
        if (item.spread) {
          throw badRequest('PGRST100', `spread embedding ("...${item.name}") is not supported by this server`);
        }
        const rel = this.relationship(table, item.name, item.hint);
        const child = this.node(rel.to, item.items.length ? item.items : [{ kind: 'star' }], `${rel.to.name}_${++this.aliasCounter}`);
        const embed: EmbedPlan = {
          node: child,
          rel,
          output: item.alias ?? item.name,
          pathName: item.alias ?? item.name,
          inner: item.joinType === 'inner',
        };
        node.embeds.push(embed);
        node.items.push({ kind: 'embed', embed });
      }
    }
    return node;
  }

  /**
   * PostgREST's embed resolution: by target table name, or — for a
   * many-to-one — by the FK constraint name or the single FK column; `!hint`
   * then narrows by constraint name or FK column. More than one survivor is
   * PGRST201, none is PGRST200.
   */
  relationship(from: TableInfo, name: string, hint?: string): Relationship {
    let found = this.snapshot.relationships.filter(
      (r) =>
        r.from === from &&
        (r.to.name === name ||
          (r.forward && (r.constraint === name || (r.fkCols.length === 1 && r.fkCols[0] === name)))),
    );
    if (hint !== undefined) {
      found = found.filter(
        (r) =>
          r.constraint === hint ||
          (r.fkCols.length === 1 && (r.fromCols[0] === hint || r.toCols[0] === hint)) ||
          (r.to.name === hint && r.to.name !== name),
      );
    }
    if (found.length === 1) return found[0];
    if (found.length === 0) {
      const err = relationshipNotFound(from.name, name, this.schema, hint);
      const reachable = this.snapshot.relationships.filter((r) => r.from === from).map((r) => r.to.name);
      const guess = closest(name, reachable);
      if (guess) err.body.hint = `Perhaps you meant '${guess}' instead of '${name}'.`;
      throw new SchemaMiss(err);
    }
    throw ambiguousRelationship(
      from.name,
      name,
      found
        .sort((a, b) => a.constraint.localeCompare(b.constraint))
        .map((r) => {
          const [refTable, refCols, fkTable, fkCols] = r.forward
            ? [r.to, r.toCols, r.from, r.fromCols]
            : [r.from, r.fromCols, r.to, r.toCols];
          return {
            cardinality: r.cardinality,
            embedding: `${from.name} with ${r.to.name}`,
            relationship: r.forward
              ? `${r.constraint} using ${fkTable.name}(${fkCols.join(', ')}) and ${refTable.name}(${refCols.join(', ')})`
              : `${r.constraint} using ${refTable.name}(${refCols.join(', ')}) and ${fkTable.name}(${fkCols.join(', ')})`,
            constraint: r.constraint,
          };
        }),
    );
  }

  // ── SQL ──────────────────────────────────────────────────────────────────

  /** `SELECT <items> FROM <table> WHERE ... ORDER BY ... LIMIT ...` for one node. */
  selectSql(
    node: ReadNode,
    p: Params,
    opts: { from?: string; join?: string; maxRows?: number; columns?: string } = {},
  ): string {
    const cols = opts.columns !== undefined ? [opts.columns] : node.items.map((it) => this.itemSql(node, it, p));
    const where = this.whereParts(node, p);
    if (opts.join) where.unshift(opts.join);
    let sql = `SELECT ${cols.length ? cols.join(', ') : ''} FROM ${opts.from ?? qtable(node.table.schema, node.table.name)} AS ${qi(node.alias)}`;
    if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
    if (node.order.length) sql += ` ORDER BY ${this.orderSql(node, node.order)}`;
    const limit = effectiveLimit(node.limit, opts.maxRows);
    if (limit !== undefined) sql += ` LIMIT ${limit}`;
    if (node.offset) sql += ` OFFSET ${node.offset}`;
    return sql;
  }

  /** The WHERE of a node without ordering/paging: filters, logic, `!inner` and existence. */
  whereParts(node: ReadNode, p: Params): string[] {
    const parts: string[] = [];
    for (const f of node.filters) parts.push(this.filterSql(node, f, p));
    for (const t of node.logic) parts.push(this.logicSql(node, t, p));
    for (const e of node.embeds) if (e.inner) parts.push(`EXISTS (${this.existsSql(node, e, p)})`);
    for (const x of node.existence) parts.push(`${x.exists ? '' : 'NOT '}EXISTS (${this.existsSql(node, x.embed, p)})`);
    return parts;
  }

  joinSql(parent: ReadNode, e: EmbedPlan): string {
    return e.rel.toCols
      .map((c, i) => `${qi(e.node.alias)}.${qi(c)} = ${qi(parent.alias)}.${qi(e.rel.fromCols[i])}`)
      .join(' AND ');
  }

  private existsSql(parent: ReadNode, e: EmbedPlan, p: Params): string {
    const where = [this.joinSql(parent, e), ...this.whereParts(e.node, p)];
    return `SELECT 1 FROM ${qtable(e.node.table.schema, e.node.table.name)} AS ${qi(e.node.alias)} WHERE ${where.join(' AND ')}`;
  }

  private itemSql(node: ReadNode, it: PlannedItem, p: Params): string {
    if (it.kind === 'star') {
      if (!node.explicitStar) return `${qi(node.alias)}.*`;
      return [...node.table.columns.keys()].map((c) => `${qi(node.alias)}.${qi(c)}`).join(', ');
    }
    if (it.kind === 'field') {
      let expr = fieldExpr(node.alias, it.field, node.table);
      if (it.cast) expr = `CAST(${expr} AS ${safeTypeName(it.cast)})`;
      return `${expr} AS ${qi(it.output)}`;
    }
    const e = it.embed;
    const sub = this.selectSql(e.node, p, { join: this.joinSql(node, e) });
    const alias = qi(`${e.node.alias}_row`);
    const value = e.rel.toOne
      ? `(SELECT to_jsonb(${alias}) FROM (${sub}) AS ${alias})`
      : `COALESCE((SELECT jsonb_agg(${alias}) FROM (${sub}) AS ${alias}), '[]'::jsonb)`;
    return `${value} AS ${qi(e.output)}`;
  }

  filterSql(node: ReadNode, f: Filter, p: Params): string {
    const column = node.table.columns.get(f.field.name);
    return opSql(fieldExpr(node.alias, f.field, node.table), f.expr, p, column?.typname === 'tsvector' && !f.field.json.length);
  }

  private logicSql(node: ReadNode, t: LogicTree, p: Params): string {
    if (t.kind === 'filter') return this.filterSql(node, t.filter, p);
    const inner = t.children.map((c) => this.logicSql(node, c, p)).join(t.op === 'and' ? ' AND ' : ' OR ');
    return `${t.negate ? 'NOT ' : ''}(${inner})`;
  }

  orderSql(node: ReadNode, terms: OrderTerm[]): string {
    return terms
      .map((t) => {
        if (t.relation) {
          throw badRequest('PGRST100', `ordering by an embedded resource ("${t.relation}(...)") is not supported by this server`);
        }
        let s = `${fieldExpr(node.alias, t.field, node.table)} ${t.direction === 'desc' ? 'DESC' : 'ASC'}`;
        if (t.nulls) s += ` NULLS ${t.nulls === 'first' ? 'FIRST' : 'LAST'}`;
        return s;
      })
      .join(', ');
  }

  /** Every key of a mutation payload must be a column — PGRST204 otherwise. */
  checkColumns(table: TableInfo, cols: string[]): void {
    for (const c of cols) if (!table.columns.has(c)) throw new SchemaMiss(columnNotFound(table.name, c));
  }
}

export function effectiveLimit(limit: number | undefined, maxRows?: number): number | undefined {
  if (maxRows && maxRows > 0) return limit === undefined ? maxRows : Math.min(limit, maxRows);
  return limit;
}

/** PostgREST names a JSON-path column after its last key unless aliased. */
function outputName(field: FieldRef, alias?: string): string {
  if (alias) return alias;
  const last = field.json[field.json.length - 1];
  return last && !last.index ? last.key : field.name;
}

/**
 * `alias."col"` plus its JSON path. PostgREST applies the arrows to array
 * columns too, by going through to_jsonb() first (`tags->0`).
 */
export function fieldExpr(alias: string, field: FieldRef, table?: TableInfo): string {
  let expr = `${qi(alias)}.${qi(field.name)}`;
  if (field.json.length && table?.columns.get(field.name)?.typname.startsWith('_')) expr = `to_jsonb(${expr})`;
  for (const op of field.json) expr += `${op.arrow}${op.index ? op.key : ql(op.key)}`;
  return expr;
}

const SQL_OPS: Record<string, string> = {
  eq: '=',
  neq: '<>',
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
  like: 'LIKE',
  ilike: 'ILIKE',
  match: '~',
  imatch: '~*',
  cs: '@>',
  cd: '<@',
  ov: '&&',
  sl: '<<',
  sr: '>>',
  nxr: '&<',
  nxl: '&>',
  adj: '-|-',
};

const TSQUERY: Record<string, string> = {
  fts: 'to_tsquery',
  plfts: 'plainto_tsquery',
  phfts: 'phraseto_tsquery',
  wfts: 'websearch_to_tsquery',
};

/** One filter. Values are bound as untyped text, so Postgres casts them to the column's type — as PostgREST does. */
export function opSql(expr: string, e: OpExpr, p: Params, isTsvector = false): string {
  const o = e.operation;
  let cond: string;
  switch (o.op) {
    case 'in':
      cond = `${expr} = ANY(${p.add(o.values)})`;
      break;
    case 'is':
      cond = `${expr} IS ${o.value === 'not_null' ? 'NOT NULL' : o.value.toUpperCase()}`;
      break;
    case 'isdistinct':
      cond = `${expr} IS DISTINCT FROM ${p.add(o.value)}`;
      break;
    case 'fts':
    case 'plfts':
    case 'phfts':
    case 'wfts': {
      const lang = o.lang ? `${ql(o.lang)}::regconfig, ` : '';
      const doc = isTsvector ? expr : `to_tsvector(${lang}${expr})`;
      cond = `${doc} @@ ${TSQUERY[o.op]}(${lang}${p.add(o.value)})`;
      break;
    }
    default: {
      const like = o.op === 'like' || o.op === 'ilike';
      const value = like ? o.value.replace(/\*/g, '%') : o.value;
      cond = o.quantifier
        ? `${expr} ${SQL_OPS[o.op]} ${o.quantifier.toUpperCase()}(${p.add(value)})`
        : `${expr} ${SQL_OPS[o.op]} ${p.add(value)}`;
    }
  }
  return e.negate ? `NOT ${cond}` : cond;
}
