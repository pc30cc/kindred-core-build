/**
 * Realtime debug logger (server).
 *
 * Off by default. Enable with the `RT_DEBUG=1` environment variable.
 * All logs are namespaced `[rt:server:<scope>]` so they grep cleanly.
 * Never logs tokens, API keys, or HMAC secrets — only IDs, vendor
 * names, channel names, event types, and outcome reasons.
 */

const enabled = process.env.RT_DEBUG === '1';

export function rtDebugEnabled(): boolean {
  return enabled;
}

export function rtDebug(scope: string, msg: string, data?: Record<string, unknown>): void {
  if (!enabled) return;
  if (data && Object.keys(data).length) {
    // eslint-disable-next-line no-console
    console.debug(`[rt:server:${scope}] ${msg}`, data);
  } else {
    // eslint-disable-next-line no-console
    console.debug(`[rt:server:${scope}] ${msg}`);
  }
}

export function rtWarn(scope: string, msg: string, data?: Record<string, unknown>): void {
  // Warnings always print — they indicate fallback or degraded transport.
  if (data && Object.keys(data).length) {
    // eslint-disable-next-line no-console
    console.warn(`[rt:server:${scope}] ${msg}`, data);
  } else {
    // eslint-disable-next-line no-console
    console.warn(`[rt:server:${scope}] ${msg}`);
  }
}
