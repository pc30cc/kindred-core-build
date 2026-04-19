/**
 * Defensive dedupe for arrays of identifiable rows.
 *
 * Used as a safety net wherever realtime events and React Query refetch
 * results could overlap on the same `id`. The current Inbox flow uses
 * pure invalidation + refetch (no manual merging), so this utility is a
 * no-op there in practice — but applying it via React Query's `select`
 * makes the cache idempotent under future code paths that might patch
 * messages locally before a refetch lands (typing indicators,
 * optimistic agent sends, etc).
 *
 * Stable ordering is preserved: the FIRST occurrence of each id wins,
 * so if a refetch result follows a realtime push, the older row stays
 * in place rather than reordering the conversation visually.
 */

export function dedupeById<T extends { id: string }>(rows: T[] | undefined | null): T[] {
  if (!rows || rows.length === 0) return rows ?? ([] as T[]);
  const seen = new Set<string>();
  const out: T[] = [];
  for (const r of rows) {
    if (!r?.id) {
      // Rows without an id can't be deduped — keep them as-is so we
      // never silently drop data.
      out.push(r);
      continue;
    }
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
  }
  return out.length === rows.length ? rows : out;
}

/**
 * Merge a single realtime row into an existing array, deduped by id.
 *
 * - If a row with the same id already exists, the existing row is
 *   replaced in-place (preserving order). This is correct for `seen_at`
 *   updates that arrive after the original message.
 * - Otherwise the new row is appended.
 *
 * Not used by the Inbox today (we invalidate-and-refetch instead) but
 * exposed for any future hook that wants optimistic patching without
 * risking duplicates.
 */
export function mergeRowById<T extends { id: string }>(rows: T[] | undefined, incoming: T): T[] {
  if (!rows || rows.length === 0) return [incoming];
  const idx = rows.findIndex((r) => r?.id === incoming.id);
  if (idx === -1) return [...rows, incoming];
  const next = rows.slice();
  next[idx] = { ...rows[idx], ...incoming };
  return next;
}
