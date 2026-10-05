/**
 * Errors in PostgREST's wire shape.
 *
 * Callers of the data layer branch on these fields — `code === '23505'`,
 * `'PGRST202'` with a message that names the function, `'PGRST205'` naming the
 * table — so the in-process engine must answer with the same code, message and
 * HTTP status PostgREST 12 would, or a working fallback silently stops firing.
 */

export interface PgrstErrorBody {
  code: string;
  message: string;
  /** A string almost always; PGRST201 lists the candidate relationships. */
  details: string | unknown[] | null;
  hint: string | null;
}

export class PgrstError extends Error {
  constructor(
    readonly status: number,
    readonly body: PgrstErrorBody,
  ) {
    super(body.message);
    this.name = 'PgrstError';
  }
}

/** The subset of a node-postgres DatabaseError this module reads. */
export interface PgDriverError {
  code?: string;
  message?: string;
  detail?: string;
  hint?: string;
  severity?: string;
}

export function isPgServerError(err: unknown): err is PgDriverError {
  const e = err as PgDriverError | null;
  return !!e && typeof e === 'object' && typeof e.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code) && !!e.severity;
}

/**
 * PostgREST's SQLSTATE → HTTP status table (src/PostgREST/Error.hs,
 * `pgErrorStatus`). The server always connects as the trusted role, so 42501
 * takes the "authenticated" branch (403).
 */
export function statusForSqlState(code: string, message = ''): number {
  switch (code) {
    case '23503':
    case '23505':
      return 409;
    case '25006':
      return 405;
    case '21000':
      return message.endsWith('requires a WHERE clause') ? 400 : 500;
    case '53400':
      return 500;
    case '57P01':
      return 503;
    case 'P0001':
      return 400;
    case '42883':
    case '42P01':
      return 404;
    case '42P17':
      return 500;
    case '42501':
      return 403;
  }
  const two = code.slice(0, 2);
  switch (two) {
    case '08':
      return 503;
    case '09':
      return 500;
    case '0L':
    case '0P':
      return 403;
    case '25':
    case '2D':
    case '38':
    case '39':
    case '3B':
    case '40':
      return 500;
    case '28':
      return 403;
    case '53':
      return 503;
    case '54':
    case '55':
    case '57':
    case '58':
    case 'F0':
    case 'HV':
    case 'P0':
    case 'XX':
      return 500;
    case 'PT': {
      const n = Number(code.slice(2));
      return Number.isInteger(n) && n >= 100 && n <= 599 ? n : 500;
    }
  }
  return 400;
}

export function fromPgError(err: PgDriverError): PgrstError {
  const code = err.code ?? '';
  const message = err.message ?? '';
  return new PgrstError(statusForSqlState(code, message), {
    code,
    message,
    details: err.detail ?? null,
    hint: err.hint ?? null,
  });
}

// ── PostgREST's own errors, worded as PostgREST 12.2 words them ─────────────

export function singularityError(rows: number): PgrstError {
  return new PgrstError(406, {
    code: 'PGRST116',
    message: 'Cannot coerce the result to a single JSON object',
    details: `The result contains ${rows} rows`,
    hint: null,
  });
}

export function tableNotFound(schema: string, table: string, suggestion?: string): PgrstError {
  return new PgrstError(404, {
    code: 'PGRST205',
    message: `Could not find the table '${schema}.${table}' in the schema cache`,
    details: null,
    hint: suggestion ? `Perhaps you meant the table '${schema}.${suggestion}'` : null,
  });
}

export function columnNotFound(table: string, column: string): PgrstError {
  return new PgrstError(400, {
    code: 'PGRST204',
    message: `Could not find the '${column}' column of '${table}' in the schema cache`,
    details: null,
    hint: null,
  });
}

export function functionNotFound(schema: string, fn: string, argNames: string[], suggestion?: string): PgrstError {
  const sorted = [...argNames].sort();
  const sig = sorted.length ? `(${sorted.join(', ')})` : ' without parameters';
  const searched = sorted.length
    ? `Searched for the function ${schema}.${fn} with parameter${sorted.length > 1 ? 's' : ''} ${sorted.join(', ')} or with a single unnamed json/jsonb parameter, but no matches were found in the schema cache.`
    : `Searched for the function ${schema}.${fn} without parameters or with a single unnamed json/jsonb parameter, but no matches were found in the schema cache.`;
  return new PgrstError(404, {
    code: 'PGRST202',
    message: `Could not find the function ${schema}.${fn}${sig} in the schema cache`,
    details: searched,
    hint: suggestion ? `Perhaps you meant to call the function ${schema}.${suggestion}` : null,
  });
}

export function ambiguousFunction(schema: string, fn: string, candidates: string[]): PgrstError {
  return new PgrstError(300, {
    code: 'PGRST203',
    message: `Could not choose the best candidate function between: ${candidates.map((c) => `${schema}.${fn}(${c})`).join(', ')}`,
    details: null,
    hint: 'Try renaming the parameters or the function itself in the database so function overloading can be resolved',
  });
}

export function relationshipNotFound(parent: string, child: string, schema: string, hint?: string): PgrstError {
  return new PgrstError(400, {
    code: 'PGRST200',
    message: `Could not find a relationship between '${parent}' and '${child}' in the schema cache`,
    details: hint
      ? `Searched for a foreign key relationship between '${parent}' and '${child}' using the hint '${hint}' in the schema '${schema}', but no matches were found.`
      : `Searched for a foreign key relationship between '${parent}' and '${child}' in the schema '${schema}', but no matches were found.`,
    hint: null,
  });
}

export interface RelationshipChoice {
  cardinality: string;
  embedding: string;
  relationship: string;
  constraint: string;
}

export function ambiguousRelationship(parent: string, child: string, choices: RelationshipChoice[]): PgrstError {
  return new PgrstError(300, {
    code: 'PGRST201',
    message: `Could not embed because more than one relationship was found for '${parent}' and '${child}'`,
    details: choices.map(({ cardinality, embedding, relationship }) => ({ cardinality, embedding, relationship })),
    hint: `Try changing '${child}' to one of the following: ${choices.map((c) => `'${child}!${c.constraint}'`).join(', ')}. Find the desired relationship in the 'details' key.`,
  });
}

export function badRequest(code: string, message: string, details: string | null = null): PgrstError {
  return new PgrstError(400, { code, message, details, hint: null });
}
