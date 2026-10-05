/**
 * PostgREST's query-string grammar, parsed the way PostgREST parses it (12.x
 * through 14.5, the version production runs).
 *
 * The data layer keeps supabase-js as its query builder and answers its HTTP
 * requests in-process (see ../pgFetch.ts). Everything a builder call becomes —
 * `select=*,owner:profiles!inner(email)`, `status=in.(open,"a,b")`,
 * `or=(a.eq.1,and(b.gt.2,c.is.null))`, `order=created_at.desc.nullslast` —
 * arrives here as text and is turned into the small trees ./query.ts compiles
 * to SQL. The rules follow PostgREST's own parser (src/PostgREST/ApiRequest/
 * QueryParams.hs); where a rule looks odd it is because PostgREST has it.
 */
import { PgrstError } from './errors.js';

export type JsonOp = { arrow: '->' | '->>'; key: string; index: boolean };

export interface FieldRef {
  name: string;
  json: JsonOp[];
}

export type AggregateFn = 'count' | 'sum' | 'avg' | 'max' | 'min';

export type SelectItem =
  | { kind: 'star' }
  | {
      kind: 'field';
      field: FieldRef;
      alias?: string;
      cast?: string;
      aggregate?: AggregateFn;
      aggregateCast?: string;
    }
  | {
      kind: 'embed';
      name: string;
      alias?: string;
      hint?: string;
      joinType?: 'inner' | 'left';
      spread: boolean;
      items: SelectItem[];
    };

export type Quantifier = 'any' | 'all';

export type Operation =
  | { op: 'in'; values: string[] }
  | { op: 'is'; value: 'null' | 'not_null' | 'true' | 'false' | 'unknown' }
  | { op: 'isdistinct'; value: string }
  | { op: 'fts' | 'plfts' | 'phfts' | 'wfts'; lang?: string; value: string }
  | { op: SimpleOp; quantifier?: Quantifier; value: string };

export type SimpleOp =
  | 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte'
  | 'like' | 'ilike' | 'match' | 'imatch'
  | 'cs' | 'cd' | 'ov' | 'sl' | 'sr' | 'nxr' | 'nxl' | 'adj';

export const SIMPLE_OPS: readonly SimpleOp[] = [
  'eq', 'neq', 'gte', 'gt', 'lte', 'lt', 'like', 'ilike', 'imatch', 'match',
  'cs', 'cd', 'ov', 'sl', 'sr', 'nxr', 'nxl', 'adj',
];

/** Operators PostgREST lets a `(any)` / `(all)` quantifier modify. */
const QUANTIFIABLE: ReadonlySet<SimpleOp> = new Set(['eq', 'gte', 'gt', 'lte', 'lt', 'like', 'ilike', 'match', 'imatch']);

export interface OpExpr {
  negate: boolean;
  operation: Operation;
}

export interface Filter {
  field: FieldRef;
  expr: OpExpr;
}

export type LogicTree =
  | { kind: 'filter'; filter: Filter }
  | { kind: 'expr'; negate: boolean; op: 'and' | 'or'; children: LogicTree[] };

export interface OrderTerm {
  /** Set when ordering by a column of a to-one embed: `order=client(name).asc`. */
  relation?: string;
  field: FieldRef;
  direction?: 'asc' | 'desc';
  nulls?: 'first' | 'last';
}

// ── character classes ──────────────────────────────────────────────────────

/** Parsec's `letter` is Unicode-aware; so is this. */
function isIdentChar(c: string): boolean {
  return /[\p{L}\p{N}_ $]/u.test(c);
}

class Cursor {
  pos = 0;
  constructor(readonly src: string, readonly what: string) {}

  get done(): boolean {
    return this.pos >= this.src.length;
  }

  peek(n = 0): string {
    return this.src[this.pos + n] ?? '';
  }

  startsWith(s: string): boolean {
    return this.src.startsWith(s, this.pos);
  }

  eat(s: string): boolean {
    if (this.startsWith(s)) {
      this.pos += s.length;
      return true;
    }
    return false;
  }

  expect(s: string): void {
    if (!this.eat(s)) this.fail(`expecting "${s}"`);
  }

  fail(why: string): never {
    // PGRST100 is PostgREST's "failed to parse" family; the message mirrors
    // its shape ("failed to parse select parameter (...)") so a log line reads
    // the same whichever side produced it.
    throw new PgrstError(400, {
      code: 'PGRST100',
      message: `"failed to parse ${this.what} parameter (${this.src})" (line 1, column ${this.pos + 1})`,
      details: `unexpected ${this.done ? 'end of input' : `"${this.peek()}"`} ${why}`,
      hint: null,
    });
  }
}

// ── shared pieces ──────────────────────────────────────────────────────────

/** `"..."` with backslash escapes, exactly as PostgREST's pQuotedValue. */
function quoted(c: Cursor): string | null {
  if (c.peek() !== '"') return null;
  c.pos++;
  let out = '';
  while (!c.done && c.peek() !== '"') {
    if (c.peek() === '\\') {
      c.pos++;
      if (c.done) c.fail('inside a quoted value');
    }
    out += c.peek();
    c.pos++;
  }
  c.expect('"');
  return out;
}

function identifier(c: Cursor): string {
  const start = c.pos;
  while (!c.done && isIdentChar(c.peek())) c.pos++;
  if (c.pos === start) c.fail('expecting an identifier');
  return c.src.slice(start, c.pos);
}

/** pFieldName: a quoted name, or identifiers joined by `-` not followed by `>`. */
function fieldName(c: Cursor): string {
  const q = quoted(c);
  if (q !== null) return q;
  let name = identifier(c);
  while (c.peek() === '-' && c.peek(1) !== '>' && isIdentChar(c.peek(1))) {
    c.pos++;
    name += '-' + identifier(c);
  }
  return name;
}

function jsonPath(c: Cursor): JsonOp[] {
  const ops: JsonOp[] = [];
  for (;;) {
    let arrow: JsonOp['arrow'];
    if (c.startsWith('->>')) arrow = '->>';
    else if (c.startsWith('->')) arrow = '->';
    else return ops;
    c.pos += arrow.length;
    // An integer operand is an array index when what follows ends it.
    const m = /^-?\d+/.exec(c.src.slice(c.pos));
    if (m) {
      const after = c.src.slice(c.pos + m[0].length);
      if (after === '' || /^(->|::|\.|,|\)|\(|!)/.test(after)) {
        c.pos += m[0].length;
        ops.push({ arrow, key: m[0], index: true });
        continue;
      }
    }
    ops.push({ arrow, key: fieldName(c), index: false });
  }
}

function field(c: Cursor): FieldRef {
  const name = fieldName(c);
  return { name, json: jsonPath(c) };
}

function castType(c: Cursor): string | undefined {
  if (!c.eat('::')) return undefined;
  const start = c.pos;
  while (!c.done && /[\p{L}\p{N}_ ]/u.test(c.peek())) c.pos++;
  if (c.pos === start) c.fail('expecting a type name');
  return c.src.slice(start, c.pos);
}

/** `alias:` — a single colon, never the `::` of a cast. */
function optionalAlias(c: Cursor): string | undefined {
  const save = c.pos;
  try {
    const name = fieldName(c);
    if (c.peek() === ':' && c.peek(1) !== ':') {
      c.pos++;
      return name;
    }
  } catch {
    /* not an alias */
  }
  c.pos = save;
  return undefined;
}

// ── select ─────────────────────────────────────────────────────────────────

export function parseSelect(src: string): SelectItem[] {
  const c = new Cursor(src, 'select');
  const items = selectForest(c);
  if (!c.done) c.fail('expecting "," or end of input');
  return items;
}

function selectForest(c: Cursor): SelectItem[] {
  const items: SelectItem[] = [];
  if (c.done || c.peek() === ')') return items;
  for (;;) {
    items.push(selectTree(c));
    if (!c.eat(',')) return items;
  }
}

function atItemEnd(c: Cursor): boolean {
  return c.done || c.peek() === ',' || c.peek() === ')';
}

function selectTree(c: Cursor): SelectItem {
  const save = c.pos;

  if (c.startsWith('...')) {
    c.pos += 3;
    const name = fieldName(c);
    const params = embedParams(c);
    c.expect('(');
    const items = selectForest(c);
    c.expect(')');
    return { kind: 'embed', name, spread: true, items, ...params };
  }

  // A relation: [alias:]name[!hint][!inner](...). `count` is never one —
  // PostgREST guards it so `count()` stays the aggregate.
  {
    const alias = optionalAlias(c);
    let name: string | null = null;
    try {
      name = fieldName(c);
    } catch {
      name = null;
    }
    if (name !== null && name !== 'count') {
      const params = embedParams(c);
      if (c.peek() === '(') {
        c.pos++;
        const items = selectForest(c);
        c.expect(')');
        return { kind: 'embed', name, alias, spread: false, items, ...params };
      }
    }
    c.pos = save;
  }

  if (c.peek() === '*') {
    c.pos++;
    if (!atItemEnd(c)) c.fail('after "*"');
    return { kind: 'star' };
  }

  const alias = optionalAlias(c);
  if (c.startsWith('count()')) {
    c.pos += 'count()'.length;
    const aggregateCast = castType(c);
    if (!atItemEnd(c)) c.fail('after "count()"');
    return { kind: 'field', field: { name: '*', json: [] }, alias, aggregate: 'count', aggregateCast };
  }
  const f = field(c);
  const cast = castType(c);
  let aggregate: AggregateFn | undefined;
  const m = /^\.(count|sum|avg|max|min)\(\)/.exec(c.src.slice(c.pos));
  if (m) {
    c.pos += m[0].length;
    aggregate = m[1] as AggregateFn;
  }
  const aggregateCast = aggregate ? castType(c) : undefined;
  if (!atItemEnd(c)) c.fail('expecting "," or ")"');
  return { kind: 'field', field: f, alias, cast, aggregate, aggregateCast };
}

function embedParams(c: Cursor): { hint?: string; joinType?: 'inner' | 'left' } {
  const out: { hint?: string; joinType?: 'inner' | 'left' } = {};
  for (let i = 0; i < 2 && c.peek() === '!'; i++) {
    c.pos++;
    if (c.startsWith('inner') && !isIdentChar(c.peek(5)) && c.peek(5) !== '-') {
      c.pos += 5;
      out.joinType = 'inner';
    } else if (c.startsWith('left') && !isIdentChar(c.peek(4)) && c.peek(4) !== '-') {
      c.pos += 4;
      out.joinType = 'left';
    } else {
      out.hint = fieldName(c);
    }
  }
  return out;
}

// ── filters ────────────────────────────────────────────────────────────────

/**
 * A filter's key: `col`, `col->a->>b`, or `embed.col` / `a.b.col` — the leading
 * names select the embedded resource the filter applies to.
 */
export function parseFilterKey(src: string): { path: string[]; field: FieldRef } {
  const c = new Cursor(src, 'filter');
  const names = [fieldName(c)];
  while (c.peek() === '.') {
    c.pos++;
    names.push(fieldName(c));
  }
  const json = jsonPath(c);
  if (!c.done) c.fail('in a filter column');
  const name = names.pop() as string;
  return { path: names, field: { name, json } };
}

/** `[not.]op.value` where value runs to the end of the parameter. */
export function parseOpExpr(src: string, column: string): OpExpr {
  const c = new Cursor(src, `filter "${column}"`);
  const negate = c.eat('not.');
  const operation = operationAt(c, 'query');
  return { negate, operation };
}

type ValueMode = 'query' | 'logic';

function operationAt(c: Cursor, mode: ValueMode): Operation {
  if (c.eat('in.')) return { op: 'in', values: listValue(c) };
  if (c.eat('is.')) {
    const raw = singleValue(c, mode).toLowerCase();
    if (raw === 'null' || raw === 'not_null' || raw === 'true' || raw === 'false' || raw === 'unknown') {
      return { op: 'is', value: raw };
    }
    c.fail('expecting null, not_null, true, false or unknown');
  }
  if (c.eat('isdistinct.')) return { op: 'isdistinct', value: singleValue(c, mode) };

  const fts = /^(fts|plfts|phfts|wfts)(?:\(([\p{L}\p{N}_]*)\))?\./u.exec(c.src.slice(c.pos));
  if (fts) {
    c.pos += fts[0].length;
    return { op: fts[1] as 'fts', lang: fts[2] || undefined, value: singleValue(c, mode) };
  }

  for (const op of SIMPLE_OPS) {
    if (!c.startsWith(op)) continue;
    const after = c.src.slice(c.pos + op.length);
    const quant = /^\((any|all)\)\./.exec(after);
    if (quant && QUANTIFIABLE.has(op)) {
      c.pos += op.length + quant[0].length;
      return { op, quantifier: quant[1] as Quantifier, value: singleValue(c, mode) };
    }
    if (after.startsWith('.')) {
      c.pos += op.length + 1;
      return { op, value: singleValue(c, mode) };
    }
  }
  c.fail('expecting an operator');
}

function singleValue(c: Cursor, mode: ValueMode): string {
  if (mode === 'query') {
    const v = c.src.slice(c.pos);
    c.pos = c.src.length;
    return v;
  }
  // pLogicSingleVal: a quoted value not followed by more text, a `{...}`
  // array literal, or everything up to the next `,` / `)`.
  const save = c.pos;
  if (c.peek() === '"') {
    const q = quoted(c);
    if (q !== null && (c.done || c.peek() === ',' || c.peek() === ')')) return q;
    c.pos = save;
  }
  if (c.peek() === '{') {
    const close = c.src.indexOf('}', c.pos);
    const inner = close < 0 ? null : c.src.slice(c.pos + 1, close);
    if (inner !== null && !inner.includes('{')) {
      c.pos = close + 1;
      return `{${inner}}`;
    }
  }
  const start = c.pos;
  while (!c.done && c.peek() !== ',' && c.peek() !== ')') c.pos++;
  return c.src.slice(start, c.pos);
}

/** `(a,"b,c",d)` — PostgREST's pListVal / pLogicListVal. */
function listValue(c: Cursor): string[] {
  c.expect('(');
  const out: string[] = [];
  if (c.eat(')')) return out;
  for (;;) {
    const save = c.pos;
    let v: string | null = null;
    if (c.peek() === '"') {
      v = quoted(c);
      if (c.peek() !== ',' && c.peek() !== ')') {
        c.pos = save;
        v = null;
      }
    }
    if (v === null) {
      const start = c.pos;
      while (!c.done && c.peek() !== ',' && c.peek() !== ')') c.pos++;
      v = c.src.slice(start, c.pos);
    }
    out.push(v);
    if (c.eat(',')) continue;
    c.expect(')');
    return out;
  }
}

// ── logic trees: or=(...) / and=(...) / not.or=(...) ─────────────────────────

export function parseLogicValue(op: 'and' | 'or', negate: boolean, src: string, key: string): LogicTree {
  const c = new Cursor(src, `logic tree "${key}"`);
  c.expect('(');
  const children = logicForest(c);
  c.expect(')');
  if (!c.done) c.fail('after the closing ")"');
  return { kind: 'expr', negate, op, children };
}

function logicForest(c: Cursor): LogicTree[] {
  const out: LogicTree[] = [];
  for (;;) {
    out.push(logicTree(c));
    if (!c.eat(',')) return out;
  }
}

function logicTree(c: Cursor): LogicTree {
  // A filter is tried first, exactly as PostgREST's `try pLogicFilter`.
  const save = c.pos;
  try {
    const f = field(c);
    c.expect('.');
    const negate = c.eat('not.');
    const operation = operationAt(c, 'logic');
    if (c.done || c.peek() === ',' || c.peek() === ')') {
      return { kind: 'filter', filter: { field: f, expr: { negate, operation } } };
    }
  } catch (err) {
    if (!(err instanceof PgrstError)) throw err;
  }
  c.pos = save;
  const negate = c.eat('not.');
  let op: 'and' | 'or';
  if (c.eat('and')) op = 'and';
  else if (c.eat('or')) op = 'or';
  else c.fail('expecting a filter, "and(" or "or("');
  c.expect('(');
  const children = logicForest(c);
  c.expect(')');
  return { kind: 'expr', negate, op, children };
}

// ── order ──────────────────────────────────────────────────────────────────

export function parseOrder(src: string): OrderTerm[] {
  const c = new Cursor(src, 'order');
  const out: OrderTerm[] = [];
  for (;;) {
    const save = c.pos;
    let term: OrderTerm | null = null;
    // rel(col).asc — order by a to-one embed's column.
    try {
      const relation = fieldName(c);
      if (c.eat('(')) {
        const f = field(c);
        c.expect(')');
        term = { relation, field: f };
      }
    } catch (err) {
      if (!(err instanceof PgrstError)) throw err;
    }
    if (!term) {
      c.pos = save;
      term = { field: field(c) };
    }
    if (c.startsWith('.asc') || c.startsWith('.desc')) {
      term.direction = c.eat('.asc') ? 'asc' : (c.eat('.desc'), 'desc');
    }
    if (c.eat('.nullsfirst')) term.nulls = 'first';
    else if (c.eat('.nullslast')) term.nulls = 'last';
    out.push(term);
    if (c.done) return out;
    c.expect(',');
  }
}

/** `columns="a","b"` on bulk inserts. */
export function parseColumns(src: string): string[] {
  const c = new Cursor(src, 'columns');
  const out: string[] = [];
  for (;;) {
    out.push(fieldName(c));
    if (c.done) return out;
    c.expect(',');
  }
}

/** `on_conflict=a, b` — PostgREST lexes the list, so spaces around names are allowed. */
export function parseOnConflict(src: string): string[] {
  return src
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s));
}
