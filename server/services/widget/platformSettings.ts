/**
 * Phase 1 — Platform-settings loader for the widget API server.
 *
 * Centralised, lightly cached read of the singleton
 * `widget_platform_settings` row. Exposes ONLY the keys server-side code
 * cares about (typing rate limit + the resubscribe-guard diagnostic).
 *
 * Cache: 60s in-memory, fail-open with safe defaults if the row is
 * missing or the read fails. Never throws.
 */

import { getServiceClient } from '../../supabase.js';
import type { ServerConfig } from '../../config.js';
import { DEFAULT_TYPING_RATE_LIMIT, type TypingRateLimitConfig } from './typingRateLimit.js';

export interface WidgetPlatformRuntimeSettings {
  typing: TypingRateLimitConfig;
  realtime: {
    staleResubscribeGuardEnabled: boolean;
  };
}

const DEFAULTS: WidgetPlatformRuntimeSettings = {
  typing: { ...DEFAULT_TYPING_RATE_LIMIT },
  realtime: { staleResubscribeGuardEnabled: true },
};

const CACHE_TTL_MS = 60_000;
let cache: { value: WidgetPlatformRuntimeSettings; ts: number } | null = null;

export async function loadWidgetPlatformRuntimeSettings(
  config: ServerConfig,
): Promise<WidgetPlatformRuntimeSettings> {
  const now = Date.now();
  if (cache && now - cache.ts < CACHE_TTL_MS) return cache.value;

  try {
    const sb = getServiceClient(config);
    const { data, error } = await sb
      .from('widget_platform_settings')
      .select(
        'typing_rate_limit_enabled, typing_rate_limit_window_ms, typing_rate_limit_max_events, realtime_stale_resubscribe_guard_enabled',
      )
      .limit(1)
      .maybeSingle();

    if (error || !data) {
      cache = { value: DEFAULTS, ts: now };
      return DEFAULTS;
    }

    const value: WidgetPlatformRuntimeSettings = {
      typing: {
        enabled: data.typing_rate_limit_enabled !== false,
        windowMs: Number(data.typing_rate_limit_window_ms) || DEFAULT_TYPING_RATE_LIMIT.windowMs,
        maxEvents: Number(data.typing_rate_limit_max_events) || DEFAULT_TYPING_RATE_LIMIT.maxEvents,
      },
      realtime: {
        staleResubscribeGuardEnabled: data.realtime_stale_resubscribe_guard_enabled !== false,
      },
    };
    cache = { value, ts: now };
    return value;
  } catch {
    cache = { value: DEFAULTS, ts: now };
    return DEFAULTS;
  }
}

/** Test-only — reset the in-memory cache. */
export function __resetWidgetPlatformRuntimeSettingsCache(): void {
  cache = null;
}
