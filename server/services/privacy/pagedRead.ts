/**
 * Every row of a read, page by page, for the privacy export and erasure
 * (P-02): the data layer caps a read at DATABASE_MAX_ROWS (1000 by default)
 * and says nothing, which cut an archive short, and left an erasure's extra
 * sessions untouched, while the job reported success. The read must be
 * ordered by a unique key. The database may return fewer rows than asked
 * for, so the next page starts after the rows actually read, and only an
 * empty page is the end (as the IP blocklist reads, middleware/security.ts).
 */

/** Rows per page (the default DATABASE_MAX_ROWS). */
export const PRIVACY_READ_PAGE = 1000;

export type PagedRead<T> = (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { code?: string; message?: string } | null }>;

/** All rows, or the first page's error (the rows read before it are dropped). */
export async function readAllPages<T>(read: PagedRead<T>): Promise<{ data: T[]; error: { code?: string; message?: string } | null }> {
  const out: T[] = [];
  for (let from = 0; ; ) {
    const { data, error } = await read(from, from + PRIVACY_READ_PAGE - 1);
    if (error) return { data: [], error };
    const page = data || [];
    if (page.length === 0) break;
    out.push(...page);
    from += page.length;
  }
  return { data: out, error: null };
}
