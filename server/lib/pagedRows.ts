/**
 * Up to `max` rows of a read, page by page. The data layer caps every read
 * at DATABASE_MAX_ROWS (1000 by default) without a word, an explicit
 * `.limit()` above it included, so a read meant to see more rows than that
 * (a count, a window of messages) must be paged. `max: Infinity` reads to
 * the end.
 *
 * The read must be ordered by a unique key (add `id` as the last order).
 * The database may return fewer rows than asked for, so the next page starts
 * after the rows actually read, and only an empty page is the end. Rows are
 * deduplicated by `id` when they carry one: a row inserted ahead of the
 * offset between two pages moves the next page by one.
 */

/** Rows per page (the default DATABASE_MAX_ROWS). */
export const ROWS_PAGE = 1000;

export type PagedRowsRead<T> = (from: number, to: number) => PromiseLike<{
  data: T[] | null;
  error: { code?: string; message?: string } | null;
}>;

export async function readRows<T>(
  read: PagedRowsRead<T>,
  max: number = Infinity,
): Promise<{ data: T[]; error: { code?: string; message?: string } | null }> {
  const out: T[] = [];
  const seen = new Set<string>();
  for (let from = 0; out.length < max; ) {
    const want = Math.min(ROWS_PAGE, max - out.length);
    const { data, error } = await read(from, from + want - 1);
    if (error) return { data: out, error };
    const page = data || [];
    if (page.length === 0) break;
    for (const row of page) {
      const id = (row as { id?: unknown } | null)?.id;
      if (typeof id === 'string') {
        if (seen.has(id)) continue;
        seen.add(id);
      }
      out.push(row);
      if (out.length >= max) break;
    }
    from += page.length;
  }
  return { data: out, error: null };
}
