/**
 * Pure delivery-classification rules for the Channels Gateway.
 *
 * Kept side-effect free (no env reads, no server boot) so it can be unit
 * tested and reasoned about in isolation from the running gateway.
 */

/**
 * Core error codes that mean "this update will NEVER be deliverable".
 * Retrying them only makes the provider hammer a dead endpoint, so they are
 * acknowledged. Anything else is treated as transient and retried.
 */
export const PERMANENT_CORE_CODES = new Set([
  'unknown_integration',
  'integration_disconnected',
  'invalid_payload',
]);

export function classifyCoreResponse(status: number, errorCode: string | null): 'ack' | 'retry' {
  if (status >= 200 && status < 300) return 'ack';
  if (status >= 500) return 'retry';
  if (status === 401 || status === 403 || status === 404) {
    // Auth/config problems on OUR side must stay visible as retries, except
    // the explicitly classified "unknown integration" case.
    return errorCode && PERMANENT_CORE_CODES.has(errorCode) ? 'ack' : 'retry';
  }
  return errorCode && PERMANENT_CORE_CODES.has(errorCode) ? 'ack' : 'retry';
}
