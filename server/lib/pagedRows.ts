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

export type KeyedRowsRead<T> = (afterKey: string | null, pageSize: number) => PromiseLike<{
  data: T[] | null;
  error: { code?: string; message?: string } | null;
}>;

/**
 * Every row of a read, page by page by key (keyset paging), for reads that
 * drive a delete, a sweep, a hand-back or money. Offset paging can skip a
 * row when an earlier one leaves the filter between two pages (it shifts the
 * next page); a keyset cannot: each page starts after the last key read.
 *
 * `read(afterKey, pageSize)` must order by `key` ascending, filter
 * `key > afterKey` when afterKey is not null, and take `pageSize` rows
 * (`.order(key).gt(key, afterKey).limit(pageSize)`); `key` must be unique.
 * The database may return fewer rows than asked for, so only an empty page
 * is the end.
 *
 * On an error the rows read so far come back WITH the error: the set is
 * incomplete, and a caller must never delete, retire or charge on it.
 */
export async function readRowsByKey<T, K extends keyof T & string = keyof T & string>(
  key: K,
  read: KeyedRowsRead<T>,
): Promise<{ data: T[]; error: { code?: string; message?: string } | null }> {
  const out: T[] = [];
  let after: string | null = null;
  for (;;) {
    const { data, error } = await read(after, ROWS_PAGE);
    if (error) return { data: out, error };
    const page = data || [];
    if (page.length === 0) break;
    out.push(...page);
    const last = page[page.length - 1][key];
    if (last === null || last === undefined) {
      return { data: out, error: { code: 'pagedrows_key_missing', message: `rows lack their key "${key}"` } };
    }
    const next = String(last);
    if (after !== null && next <= after) {
      return { data: out, error: { code: 'pagedrows_key_order', message: `rows are not ordered by "${key}"` } };
    }
    after = next;
  }
  return { data: out, error: null };
}

interface KeyPageable<Q> {
  gt(column: string, value: string): Q;
  order(column: string, options: { ascending: boolean }): Q;
  limit(count: number): Q;
}

/** One keyset page of a query builder: `key > after` (when given), ordered by `key`, `size` rows. */
export function keyPage<Q extends KeyPageable<Q>>(query: Q, key: string, after: string | null, size: number): Q {
  return (after === null ? query : query.gt(key, after)).order(key, { ascending: true }).limit(size);
}
