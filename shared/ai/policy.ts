/**
 * Timeout / retry policy helpers — pure, shared by Core (for surfacing
 * classification) and the AI Runtime (for enforcement).
 */

/**
 * Bounded env integer reader. Env overrides are validated: non-numeric, zero,
 * negative or absurd values fall back to the default instead of creating
 * instant-abort loops or unbounded waits.
 */
export function readBoundedEnvInt(
  name: string,
  fallback: number,
  min: number,
  max: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const parsed = Number(String(raw).trim());
  if (!Number.isFinite(parsed)) return fallback;
  const int = Math.trunc(parsed);
  if (int < min || int > max) return fallback;
  return int;
}

/**
 * HTTP status retry policy.
 *   400 / 401 / 403 / 404  → never retry (client/auth/config error)
 *   408 / 429              → bounded retry (429 respects a sane Retry-After)
 *   500 / 502 / 503 / 504  → bounded retry
 *   everything else        → no retry
 */
export function isRetryableStatus(status: number): boolean {
  if (status === 408 || status === 429) return true;
  return status === 500 || status === 502 || status === 503 || status === 504;
}

/** Retry-After in seconds or HTTP-date; ignored when absent/absurd (>15s). */
export function parseRetryAfterMs(value: string | null): number | null {
  if (!value) return null;
  const secs = Number(value.trim());
  if (Number.isFinite(secs)) {
    const ms = Math.trunc(secs * 1000);
    return ms >= 0 && ms <= 15000 ? ms : null;
  }
  const when = Date.parse(value);
  if (!Number.isFinite(when)) return null;
  const ms = when - Date.now();
  return ms > 0 && ms <= 15000 ? ms : null;
}
