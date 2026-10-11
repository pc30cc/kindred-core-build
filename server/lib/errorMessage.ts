/**
 * The `message` of anything thrown or returned as an error: an Error, a
 * PostgREST error object, or whatever a library rejected with. Undefined when
 * there is no string message, so `details: errorMessage(e)` keeps the old
 * `details: e?.message` answer without typing the catch variable as any.
 */
export function errorMessage(error: unknown): string | undefined {
  const message = (error as { message?: unknown } | null | undefined)?.message;
  return typeof message === 'string' ? message : undefined;
}
