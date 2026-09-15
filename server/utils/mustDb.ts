/**
 * Sixth corrective pass (storage architecture standardization), P0: real
 * Supabase/PostgREST resolves a failed query as `{ data, error }` — it
 * does NOT throw unless `.throwOnError()` is explicitly used. Any `await`
 * on a PostgREST builder that doesn't inspect `.error` silently treats a
 * failed write exactly like a successful one.
 *
 * `mustDb` makes that failure behave like a thrown exception instead, so
 * ordinary `try/catch` around a critical write actually catches it. Used
 * anywhere a write's success is a safety precondition for something
 * else — a durable "Egress may be running" marker, a terminal recording
 * state a deletion worker waits on, an audit/dedup row — where treating
 * a resolved `{error}` as success would silently defeat that guarantee.
 */
export async function mustDb<T>(
  result: { data: T; error: { message: string; code?: string } | null },
  context: string,
): Promise<T> {
  if (result.error) {
    throw new Error(`db_write_failed[${context}]: ${result.error.message}`);
  }
  return result.data;
}
