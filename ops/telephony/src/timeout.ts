/**
 * Portable request-timeout signal.
 *
 * Node 22 has AbortSignal.timeout, but some test/runtime environments do not,
 * so fall back to a controller-based timer rather than crashing the request.
 */
export function timeoutSignal(ms: number): AbortSignal | undefined {
  const anyAbort = AbortSignal as unknown as { timeout?: (ms: number) => AbortSignal };
  if (typeof anyAbort.timeout === 'function') return anyAbort.timeout(ms);
  if (typeof AbortController !== 'function') return undefined;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  if (typeof (timer as unknown as { unref?: () => void }).unref === 'function') {
    (timer as unknown as { unref: () => void }).unref();
  }
  return controller.signal;
}
