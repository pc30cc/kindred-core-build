/**
 * Incremental thread sync for `GET /api/conversations/:id/messages?since=`.
 *
 * A message is not immutable after insert: its metadata changes (a call
 * card's status, an outbound delivery status, Telegram media landing, the
 * privacy anonymizer) and so does `seen_at`. `created_at > cursor` would miss
 * all of those, so the cursor is `conversation_messages.updated_at`, which a
 * trigger bumps on every UPDATE (migration 216 / 20260925100000).
 *
 * Commit order is not timestamp order: a transaction that stamped its row a
 * moment before another one can commit after it. The delta query therefore
 * reaches back SYNC_OVERLAP_MS behind the cursor; the rows it re-sends are
 * upserted by id on the client, so the overlap costs a few repeated rows and
 * never a missed one. Deletions are not expressed by a delta — a client that
 * cares reconciles with a periodic full read (no `since`).
 *
 * Backward compatible both ways: a request without `since` gets exactly the
 * old response (plus a `sync` object old clients ignore), and a server whose
 * database has not been migrated yet answers `since` requests in full.
 */

/** How far behind the client's cursor a delta reaches, for transactions committed out of order. */
export const SYNC_OVERLAP_MS = 10_000;

/** A cursor further ahead than this is treated as a clock problem and ignored (full read). */
const MAX_FUTURE_SKEW_MS = 5 * 60_000;

/**
 * The client's cursor as a Date, or null for "no usable cursor" (absent,
 * malformed, or implausibly far in the future) — which means a full read.
 */
export function parseSyncCursor(raw: unknown, now: number = Date.now()): Date | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!text || text.length > 64) return null;
  // ISO-8601 only: a timestamp the server itself handed out.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:?\d{2})$/.test(text)) return null;
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) return null;
  if (ms - now > MAX_FUTURE_SKEW_MS) return null;
  return new Date(ms);
}

/** The lower bound the delta query uses: the cursor, minus the overlap. */
export function deltaLowerBound(cursor: Date): string {
  return new Date(cursor.getTime() - SYNC_OVERLAP_MS).toISOString();
}

interface SyncRow {
  updated_at?: string | null;
}

/**
 * The cursor to hand back: the newest `updated_at` among the rows read, or —
 * when the read returned nothing newer — the cursor the client sent. Null when
 * the rows carry no `updated_at` (database not migrated): the client then has
 * no cursor and keeps reading in full.
 */
export function nextSyncCursor(rows: SyncRow[], previous: Date | null): string | null {
  let best: number | null = null;
  let bestText: string | null = null;
  for (const r of rows) {
    const t = typeof r.updated_at === 'string' ? Date.parse(r.updated_at) : NaN;
    if (Number.isFinite(t) && (best === null || t > best)) {
      best = t;
      bestText = new Date(t).toISOString();
    }
  }
  if (bestText) {
    // Never move the cursor backwards: an overlap read can return only older rows.
    if (previous && best !== null && best < previous.getTime()) return previous.toISOString();
    return bestText;
  }
  return previous ? previous.toISOString() : null;
}

/** Rows in thread order, whatever order the query returned them in. */
export function inThreadOrder<T extends { created_at?: string | null; id?: string | null }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    const ta = Date.parse(a.created_at ?? '') || 0;
    const tb = Date.parse(b.created_at ?? '') || 0;
    if (ta !== tb) return ta - tb;
    return String(a.id ?? '').localeCompare(String(b.id ?? ''));
  });
}
