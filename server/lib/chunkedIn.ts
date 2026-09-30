/**
 * Run a PostgREST `.in(column, values)` read in bounded chunks.
 *
 * supabase-js sends `.in()` values in the GET query string. A page of 200
 * visitor session ids is ~8 KB of URL and 200 SHA-256 ip hashes ~13 KB —
 * past the request-line limit of common proxies (nginx, Kong, many CDNs
 * default to 8 KB), where the request fails with 414 before it reaches the
 * database. Chunks of IN_LIST_CHUNK keep every request small; they run in
 * parallel and their rows are concatenated (callers that need an order must
 * re-sort). A failed chunk is logged under `label` and contributes no rows,
 * instead of silently emptying the whole result.
 */
export const IN_LIST_CHUNK = 50;

type ChunkResult = { data: unknown; error: { message?: string } | null };

export async function selectInChunks<T>(
  values: readonly string[],
  run: (chunk: string[]) => PromiseLike<ChunkResult>,
  label: string,
): Promise<T[]> {
  const unique = Array.from(new Set(values.filter(Boolean)));
  if (!unique.length) return [];
  const chunks: string[][] = [];
  for (let i = 0; i < unique.length; i += IN_LIST_CHUNK) chunks.push(unique.slice(i, i + IN_LIST_CHUNK));
  const results = await Promise.all(chunks.map((chunk) => Promise.resolve(run(chunk))));
  const rows: T[] = [];
  for (const { data, error } of results) {
    if (error) {
      console.warn(`[${label}] chunked read failed:`, error.message ?? error);
      continue;
    }
    if (Array.isArray(data)) rows.push(...(data as T[]));
  }
  return rows;
}
