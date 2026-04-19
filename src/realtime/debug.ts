/**
 * Realtime debug logger (client).
 *
 * Off by default. Enable per-tab without a rebuild:
 *
 *   localStorage.setItem('rt:debug', '1');  // turn on
 *   localStorage.removeItem('rt:debug');    // turn off
 *
 * Or set `VITE_RT_DEBUG=1` at build time for always-on diagnostics
 * in non-production environments.
 *
 * All logs are namespaced `[rt]` so they grep cleanly. Never logs
 * tokens, JWTs, or workspace secrets — only IDs, vendor names, and
 * event types.
 */

const envFlag =
  typeof import.meta !== 'undefined' &&
  (import.meta as any)?.env?.VITE_RT_DEBUG === '1';

function lsFlag(): boolean {
  try {
    return typeof window !== 'undefined' && window.localStorage?.getItem('rt:debug') === '1';
  } catch {
    return false;
  }
}

export function rtDebugEnabled(): boolean {
  return envFlag || lsFlag();
}

export function rtDebug(scope: string, msg: string, data?: Record<string, unknown>): void {
  if (!rtDebugEnabled()) return;
  if (data && Object.keys(data).length) {
    // eslint-disable-next-line no-console
    console.debug(`[rt:${scope}] ${msg}`, data);
  } else {
    // eslint-disable-next-line no-console
    console.debug(`[rt:${scope}] ${msg}`);
  }
}

export function rtWarn(scope: string, msg: string, data?: Record<string, unknown>): void {
  // Warnings always print regardless of the debug flag — they indicate
  // degraded transport or a fallback decision the operator should know
  // about. Still namespaced for greppability.
  if (data && Object.keys(data).length) {
    // eslint-disable-next-line no-console
    console.warn(`[rt:${scope}] ${msg}`, data);
  } else {
    // eslint-disable-next-line no-console
    console.warn(`[rt:${scope}] ${msg}`);
  }
}
