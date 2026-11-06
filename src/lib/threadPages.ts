/**
 * A thread's messages, page by page, in the operator panel.
 *
 * GET /api/conversations/:id/messages answers the newest page (`limit`) in
 * thread order, with `older: { before, before_id }` while earlier messages
 * exist; `?before=…&before_id=…` reads the page before. The panel holds one
 * contiguous run of the thread, newest page first, older pages added on
 * request:
 *
 *   · a refresh (a new message, a reaction, a seen, a focus) reads the
 *     newest page again. Everything at or after that page's start is the
 *     page's (edits, deletions and reactions land); what was loaded before
 *     it is kept, unless the page no longer touches it (more new messages
 *     than one page arrived meanwhile), in which case the run starts again
 *     from the page so it never has a hole;
 *   · an older page goes before the run.
 *
 * Rows are ordered by (created_at, id) as the server orders them, with
 * created_at's microseconds kept: a JavaScript Date would drop them and
 * reorder rows written in one millisecond.
 */

/** Messages per page the panel asks for (the server's default is 1000). */
export const THREAD_PAGE_SIZE = 100;

export interface ThreadCursor {
  before: string;
  before_id: string;
}

export interface ThreadRow {
  id: string;
  created_at: string;
}

const STAMP = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}(?::?\d{2})?)?$/;

/**
 * Microseconds since the epoch of a timestamp as the server writes it
 * (`2026-11-06T18:07:55.698123+00:00`) or as a browser does (`…55.698Z`);
 * NaN when unreadable. Exact: 2^53 µs is about 285 years past 1970.
 */
export function stampMicros(value: string | null | undefined): number {
  const m = typeof value === 'string' ? STAMP.exec(value.trim()) : null;
  if (!m) return Number.NaN;
  const [, y, mo, d, h, mi, sec, frac = '', zone = 'Z'] = m;
  let offsetMin = 0;
  if (zone !== 'Z') {
    const sign = zone[0] === '-' ? -1 : 1;
    const digits = zone.slice(1).replace(':', '');
    offsetMin = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4) || '0'));
  }
  const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(sec)) - offsetMin * 60_000;
  const micros = Number((frac + '000000').slice(0, 6));
  return ms * 1000 + micros;
}

/** Thread order: (created_at, id), oldest first; an unreadable time sorts first. */
export function compareThreadRows(a: ThreadRow, b: ThreadRow): number {
  const ta = stampMicros(a.created_at);
  const tb = stampMicros(b.created_at);
  if (ta !== tb) {
    if (Number.isNaN(ta)) return -1;
    if (Number.isNaN(tb)) return 1;
    return ta < tb ? -1 : 1;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** At or after the cursor's row, in thread order. */
function atOrAfter(row: ThreadRow, cursor: ThreadCursor): boolean {
  return compareThreadRows(row, { id: cursor.before_id, created_at: cursor.before }) >= 0;
}

/** One row per id (the later list's copy wins), in thread order. */
function union<T extends ThreadRow>(...lists: T[][]): T[] {
  const byId = new Map<string, T>();
  for (const list of lists) for (const row of list) if (row?.id) byId.set(row.id, row);
  return [...byId.values()].sort(compareThreadRows);
}

export interface ThreadRun<T extends ThreadRow> {
  rows: T[];
  /** Where the page before the run starts; null at the thread's start. */
  older: ThreadCursor | null;
}

/**
 * The run after a newest-page read: `page` with its `older`, `held` the run
 * the panel had (and its own `older`).
 */
export function mergeNewestPage<T extends ThreadRow>(
  held: ThreadRun<T> | null | undefined,
  page: ThreadRun<T>,
): ThreadRun<T> {
  const fresh = union(page.rows);
  // The page reaches the thread's start: it is the whole thread.
  if (!page.older) return { rows: fresh, older: null };
  if (!held || held.rows.length === 0) return { rows: fresh, older: page.older };
  const boundary = page.older;
  const before = held.rows.filter((r) => !atOrAfter(r, boundary));
  // Nothing held before the page: the page is the run.
  if (before.length === 0) return { rows: fresh, older: page.older };
  // The run touches the page only when it reaches its start: some held row
  // at or after it (the newest held row is then in the page's range).
  const newestHeld = held.rows.reduce((max, r) => (compareThreadRows(r, max) > 0 ? r : max), held.rows[0]);
  if (!atOrAfter(newestHeld, boundary)) return { rows: fresh, older: page.older };
  return { rows: union(before, fresh), older: held.older };
}

/** The run after an older page was read before it. */
export function mergeOlderPage<T extends ThreadRow>(
  held: ThreadRun<T> | null | undefined,
  page: ThreadRun<T>,
): ThreadRun<T> {
  return { rows: union(held?.rows ?? [], page.rows), older: page.older };
}
