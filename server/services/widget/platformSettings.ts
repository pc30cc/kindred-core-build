/**
 * Phase 1 — Platform-settings loader for the widget API server.
 *
 * Centralised, lightly cached read of the singleton
 * `widget_platform_settings` row. Exposes ONLY the keys server-side code
 * cares about (typing rate limit + the resubscribe-guard diagnostic).
 *
 * Cache: 60s in-memory, fail-open with safe defaults if the row is
 * missing or the read fails. Never throws.
 *
 * The inactivity close's switch and default (migration 284) have a read of
 * their own below (loadInactivityCloseSettings), which fails closed.
 */

import { getServiceClient } from '../../supabase.js';
import type { ServerConfig } from '../../config.js';
import { onInvalidate } from '../../lib/cacheBus.js';
import {
  INACTIVITY_CLOSE_DEFAULT_HOURS,
  INACTIVITY_CLOSE_MAX_HOURS,
  INACTIVITY_CLOSE_MIN_HOURS,
} from '../../../shared/inactivityClose.js';
import { DEFAULT_TYPING_RATE_LIMIT, type TypingRateLimitConfig } from './typingRateLimit.js';

export interface WidgetPlatformRuntimeSettings {
  typing: TypingRateLimitConfig;
  realtime: {
    staleResubscribeGuardEnabled: boolean;
    /** Phase 2 — % jitter applied to reconnect backoff (0–50). */
    reconnectJitterPct: number;
    /** Phase 2 — Centrifugo connection/subscription token TTL (sec). */
    tokenTtlSeconds: number;
    /** Phase 2 — idle ms before an unused realtime socket is disposed. */
    idleDisposalMs: number;
    /** Phase 2 — hard cap on in-flight pending callbacks per socket. */
    pendingMax: number;
    /** Phase 2 — drop duplicate push frames before fan-out. */
    messageDedupeEnabled: boolean;
    /** Phase 2 — ring buffer size for the per-channel dedupe set. */
    messageDedupeWindow: number;
  };
}

const DEFAULTS: WidgetPlatformRuntimeSettings = {
  typing: { ...DEFAULT_TYPING_RATE_LIMIT },
  realtime: {
    staleResubscribeGuardEnabled: true,
    reconnectJitterPct: 20,
    tokenTtlSeconds: 1800,
    idleDisposalMs: 60_000,
    pendingMax: 256,
    messageDedupeEnabled: true,
    messageDedupeWindow: 200,
  },
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
        'typing_rate_limit_enabled, typing_rate_limit_window_ms, typing_rate_limit_max_events, realtime_stale_resubscribe_guard_enabled, realtime_reconnect_jitter_pct, realtime_token_ttl_seconds, realtime_idle_disposal_ms, realtime_pending_max, realtime_message_dedupe_enabled, realtime_message_dedupe_window',
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
        reconnectJitterPct: clampInt(data.realtime_reconnect_jitter_pct, 0, 50, 20),
        tokenTtlSeconds: clampInt(data.realtime_token_ttl_seconds, 300, 7200, 1800),
        idleDisposalMs: clampInt(data.realtime_idle_disposal_ms, 10_000, 1_800_000, 60_000),
        pendingMax: clampInt(data.realtime_pending_max, 32, 4096, 256),
        messageDedupeEnabled: data.realtime_message_dedupe_enabled !== false,
        messageDedupeWindow: clampInt(data.realtime_message_dedupe_window, 16, 4096, 200),
      },
    };
    cache = { value, ts: now };
    return value;
  } catch {
    cache = { value: DEFAULTS, ts: now };
    return DEFAULTS;
  }
}

function clampInt(raw: unknown, min: number, max: number, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.trunc(n);
  if (i < min) return min;
  if (i > max) return max;
  return i;
}

/** Test-only — reset the in-memory cache. */
export function __resetWidgetPlatformRuntimeSettingsCache(): void {
  cache = null;
}

// ─── The inactivity close (migration 284) ──────────────────────────────────

export interface InactivityCloseSettings {
  /** The Super Admin's switch. */
  enabled: boolean;
  /** The window of every workspace without its own (1–48). */
  defaultHours: number;
}

/**
 * Off, 24 h: what an unreadable or missing row reads as. Unlike the settings
 * above this fails CLOSED, since it starts a timer that closes conversations
 * (and a database before 284 has no such columns).
 */
const INACTIVITY_CLOSE_OFF: InactivityCloseSettings = { enabled: false, defaultHours: INACTIVITY_CLOSE_DEFAULT_HOURS };

let inactivityCache: { value: InactivityCloseSettings; ts: number } | null = null;

/**
 * The Super Admin's inactivity-close switch and default window, read on
 * their own (never added to the first-paint selects above, which would fail
 * on a database before 284). 60 s cache, cleared by PATCH /platform/config
 * and by the cache bus `platform` message. This only decides whether the
 * ticker takes its lease and what the panel shows: the SQL due and close
 * functions read the switch themselves, so once it is off nothing closes.
 * Never throws.
 */
export async function loadInactivityCloseSettings(config: ServerConfig): Promise<InactivityCloseSettings> {
  const now = Date.now();
  if (inactivityCache && now - inactivityCache.ts < CACHE_TTL_MS) return inactivityCache.value;
  let value = INACTIVITY_CLOSE_OFF;
  try {
    const { data, error } = await getServiceClient(config)
      .from('widget_platform_settings')
      .select('inactivity_close_enabled, inactivity_close_default_hours')
      .limit(1)
      .maybeSingle();
    if (!error && data) {
      const row = data as { inactivity_close_enabled?: unknown; inactivity_close_default_hours?: unknown };
      value = {
        enabled: row.inactivity_close_enabled === true,
        defaultHours: clampInt(row.inactivity_close_default_hours, INACTIVITY_CLOSE_MIN_HOURS, INACTIVITY_CLOSE_MAX_HOURS, INACTIVITY_CLOSE_DEFAULT_HOURS),
      };
    }
  } catch {
    value = INACTIVITY_CLOSE_OFF;
  }
  inactivityCache = { value, ts: now };
  return value;
}

/** Forget the cached switch and default (a save here, or another process's: the cache bus). */
export function invalidateInactivityCloseSettings(): void {
  inactivityCache = null;
}

// Another backend process saved the platform settings (lib/cacheBus.ts 'platform' / 'all').
onInvalidate('platform', () => invalidateInactivityCloseSettings());

/** Test-only — reset the inactivity-close cache. */
export function __resetInactivityCloseSettingsCache(): void {
  inactivityCache = null;
}
