/**
 * Reads that name a column a migration adds, on a database that does not
 * have it yet. RESPOK's backend may start before its migrator has applied
 * the files (docs/EDITIONS.md), and WebYar's are applied by hand: until then
 * such a read fails with "column does not exist" (PostgreSQL 42703 through
 * the direct driver, PGRST204 from PostgREST) and must fall back to the
 * columns that were there before, the new ones then reading as their
 * defaults, instead of failing the request or leaving a list empty.
 */

/** Postgres' "column does not exist", naming one of `columns` when they are given. */
export function isMissingColumnError(error: unknown, columns?: readonly string[]): boolean {
  const e = error as { code?: unknown; message?: unknown; details?: unknown; hint?: unknown } | null | undefined;
  const code = String(e?.code ?? '');
  if (code !== '42703' && code !== 'PGRST204') return false;
  if (!columns?.length) return true;
  const text = `${String(e?.message ?? '')} ${String(e?.details ?? '')} ${String(e?.hint ?? '')}`;
  return columns.some((column) => text.includes(column));
}

/**
 * Runs `read` with the full column list and, when that fails because one of
 * `missing` is not there yet, once more with `fallback`. `degraded` says the
 * fallback answered.
 */
export async function readWithColumnFallback(
  read: (columns: string) => PromiseLike<{ data: unknown; error: unknown }>,
  full: string,
  fallback: string,
  missing: readonly string[],
): Promise<{ data: unknown; error: unknown; degraded: boolean }> {
  const first = await read(full);
  if (!first.error || !isMissingColumnError(first.error, missing)) return { data: first.data, error: first.error, degraded: false };
  const second = await read(fallback);
  return { data: second.data, error: second.error, degraded: true };
}
