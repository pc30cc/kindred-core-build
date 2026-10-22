/**
 * The widget platform's tuning values (Super Admin → Widget settings →
 * Realtime and Flood protection; widget_platform_settings) and the range each
 * one may take: the range its reader keeps to (server/services/widget/
 * platformSettings.ts, the realtime client), which the page offers and the
 * platform settings PATCH enforces. One table, so the page never offers a
 * value the server refuses or a reader quietly clamps.
 */
export interface PlatformTuningRange {
  min: number;
  max: number;
  step: number;
}

export const PLATFORM_TUNING_RANGES = {
  /** Reconnect backoff spread, in percent. */
  realtime_reconnect_jitter_pct: { min: 0, max: 50, step: 1 },
  /** How long a realtime connection / subscription token is valid, in seconds. */
  realtime_token_ttl_seconds: { min: 300, max: 7200, step: 60 },
  /** In-flight callbacks one realtime connection may hold. */
  realtime_pending_max: { min: 32, max: 4096, step: 32 },
  /** Recent message ids remembered per channel to drop a repeated frame. */
  realtime_message_dedupe_window: { min: 16, max: 4096, step: 16 },
  /** The typing limiter's window, in milliseconds. */
  typing_rate_limit_window_ms: { min: 250, max: 60000, step: 250 },
  /** Typing events one conversation may publish per window. */
  typing_rate_limit_max_events: { min: 1, max: 100, step: 1 },
} as const satisfies Record<string, PlatformTuningRange>;

export type PlatformTuningKey = keyof typeof PLATFORM_TUNING_RANGES;

/**
 * A typed value as the page may save it: a whole number inside the key's
 * range, else null (nothing is saved; an empty field never writes a default).
 */
export function parsePlatformTuningValue(key: PlatformTuningKey, raw: string): number | null {
  // Persian and Arabic-Indic digits read as the digits they are.
  const text = raw
    .trim()
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));
  if (!/^\d+$/.test(text)) return null;
  const value = Number(text);
  const range = PLATFORM_TUNING_RANGES[key];
  return Number.isSafeInteger(value) && value >= range.min && value <= range.max ? value : null;
}
