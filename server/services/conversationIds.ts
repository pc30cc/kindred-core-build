/**
 * `?ids=` on `GET /api/conversations` — targeted reads for native clients.
 *
 * A realtime event or a push names one conversation; a client that must learn
 * what that conversation looks like now — and whether it is still in the
 * queue on screen — used to have to re-read the whole queue, which this list
 * route answers without pagination. With `ids`, the same query (same queue,
 * same status, same assignment scope, same post-filters) runs narrowed to the
 * named rows: an id that comes back is in the queue; one that does not, is not.
 *
 * Backward compatible both ways: without `ids` the route answers exactly as
 * before, and the response echoes the ids it narrowed to, so a client can tell
 * a server that honoured them from an older one that ignored the parameter and
 * sent the whole queue.
 */

/** The most ids one request may name. A client with more reads the queue. */
export const MAX_CONVERSATION_IDS = 100;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ParsedIds =
  | { ok: true; ids: string[] | null }
  | { ok: false; error: string };

/**
 * `null` when the parameter is absent (the ordinary list). Otherwise the
 * distinct ids, in order — or an error for anything that is not a list of at
 * most [MAX_CONVERSATION_IDS] UUIDs, rather than silently answering a
 * different question than the one asked.
 */
export function parseConversationIds(raw: unknown): ParsedIds {
  if (raw === undefined || raw === null) return { ok: true, ids: null };
  if (typeof raw !== 'string') return { ok: false, error: 'ids must be a comma-separated list' };
  const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return { ok: false, error: 'ids is empty' };
  const unique = Array.from(new Set(parts.map((p) => p.toLowerCase())));
  if (unique.length > MAX_CONVERSATION_IDS) {
    return { ok: false, error: `at most ${MAX_CONVERSATION_IDS} ids` };
  }
  if (!unique.every((id) => UUID.test(id))) return { ok: false, error: 'ids must be UUIDs' };
  return { ok: true, ids: unique };
}

/** Whether a path segment can be a conversation id at all. */
export function isConversationId(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}
