/**
 * Phase 6-S5-R7.3 — typed fail-closed read results.
 *
 * Every AI-KB read model that touches the database returns one of these
 * instead of a "best effort" business value. An infrastructure failure can
 * therefore never be laundered into a valid empty state (no domain, Free
 * plan, zero jobs, zero credits) that the customer would act on.
 */

export type AiKbReadErrorCode =
  | 'source_domain_status_unavailable'
  | 'plan_status_unavailable'
  | 'job_usage_status_unavailable'
  | 'credit_status_unavailable'
  | 'capability_status_unavailable';

export type ReadResult<T, E extends string = AiKbReadErrorCode> =
  | { ok: true; value: T; errorCode?: undefined; retryable?: undefined }
  | { ok: false; value?: undefined; errorCode: E; retryable: true };

export function readOk<T>(value: T): { ok: true; value: T; errorCode?: undefined; retryable?: undefined } {
  return { ok: true, value };
}

export function readFailed<E extends string>(
  errorCode: E,
): { ok: false; value?: undefined; errorCode: E; retryable: true } {
  return { ok: false, errorCode, retryable: true };
}

/** Returns the first failure in a list of read results, or null. */
export function firstReadFailure(
  results: Array<ReadResult<unknown, string>>,
): { ok: false; errorCode: string; retryable: true } | null {
  for (const r of results) {
    if (r.ok === false) return { ok: false, errorCode: r.errorCode, retryable: true };
  }
  return null;
}
