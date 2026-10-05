/**
 * SQL text helpers shared by the planner. Identifiers and literals are quoted
 * here and nowhere else; every request value travels as a bind parameter.
 */

export function qi(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** A string literal for the few places PostgREST inlines one (JSON keys). */
export function ql(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function qtable(schema: string, name: string): string {
  return `${qi(schema)}.${qi(name)}`;
}

/** Bind parameters of one statement. `add` returns the `$n` placeholder. */
export class Params {
  readonly values: unknown[] = [];

  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

/** Cast-type names come from the request; allow only what a type name can be. */
export function safeTypeName(t: string): string {
  const trimmed = t.trim();
  if (!/^[A-Za-z_][A-Za-z0-9_ ]*(\[\])?$/.test(trimmed)) throw new Error(`invalid cast type: ${t}`);
  return trimmed;
}
