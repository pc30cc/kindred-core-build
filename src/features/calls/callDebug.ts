/**
 * Call diagnostic logger.
 *
 * Off by default in production. Enable per tab without rebuild:
 *
 *   ?callDebug=1
 *   localStorage.setItem('call_debug', '1')
 *
 * Companion flag for video orientation diagnostics lives in
 * `videoOrientation.ts` (`callOrientationDebug` / `call_orientation_debug`).
 *
 * Logs are namespaced `[call:<scope>]` and never include tokens, JWTs or
 * room secrets — only IDs, role names, and event types.
 */

export function isCallDebugEnabled(): boolean {
  try {
    if (typeof window === 'undefined') return false;
    const params = new URLSearchParams(window.location.search);
    return params.get('callDebug') === '1' ||
      window.localStorage.getItem('call_debug') === '1';
  } catch {
    return false;
  }
}

export function callDebug(scope: string, msg: string, data?: Record<string, unknown>): void {
  if (!isCallDebugEnabled()) return;
  if (data && Object.keys(data).length) {
    // eslint-disable-next-line no-console
    console.debug(`[call:${scope}] ${msg}`, data);
  } else {
    // eslint-disable-next-line no-console
    console.debug(`[call:${scope}] ${msg}`);
  }
}

export function callWarn(scope: string, msg: string, data?: Record<string, unknown>): void {
  // Warnings always print — they indicate a degraded call state operators
  // and visitors should know about (e.g. media permission denied,
  // LiveKit reconnect, hangup with error).
  if (data && Object.keys(data).length) {
    // eslint-disable-next-line no-console
    console.warn(`[call:${scope}] ${msg}`, data);
  } else {
    // eslint-disable-next-line no-console
    console.warn(`[call:${scope}] ${msg}`);
  }
}