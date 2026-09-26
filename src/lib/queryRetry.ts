/**
 * Retry policy for React Query queries.
 *
 * The library default retries every failed query three times, whatever the
 * failure. A 4xx is the server's final answer — a plan without the feature
 * (403), a record that is gone (404), a signed-out session (401) — so those
 * retries only multiplied the load, and a component polling such an endpoint
 * paid four requests on every tick.
 *
 * Errors that carry an HTTP status (most first-party API modules attach one)
 * are no longer retried on a 4xx, except 408 and 429, which ask to be retried
 * later. Everything else — network failures, 5xx, errors without a status —
 * keeps the default three retries.
 */
const DEFAULT_RETRIES = 3;

export function httpStatusOf(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null;
  const { status, statusCode } = error as { status?: unknown; statusCode?: unknown };
  const n = Number(status ?? statusCode);
  return Number.isInteger(n) && n >= 100 && n <= 599 ? n : null;
}

export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  const status = httpStatusOf(error);
  if (status !== null && status >= 400 && status < 500 && status !== 408 && status !== 429) return false;
  return failureCount < DEFAULT_RETRIES;
}
