/**
 * Phase 5C.1 — Fast in-memory lookup of currently-active auto-actions.
 *
 * Hot-path safe: typing handlers (and any future runtime hooks) check
 * `isActionActive(...)` synchronously without hitting Postgres on every
 * request. The cache is refreshed in the background every REFRESH_MS.
 *
 * Hard rules:
 *   • Pure read-side. Never mutates auto_action_events.
 *   • Fail-open: on any error, returns "no actions active" so we never
 *     block traffic on observability infrastructure.
 *   • No PII. Stores only action_type + slug + expires_at.
 *   • Refresh is best-effort; ticker uses unref() so it can't keep the
 *     event loop alive on shutdown.
 */

import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { emitLog } from './metrics.js';

export type AutoActionType =
  | 'disable_typing_temporarily'
  | 'force_polling_mode'
  | 'increase_reconnect_backoff'
  | 'mark_system_degraded'
  | 'throttle_new_conversations'
  | 'slow_mode_messages'
  | 'operator_load_shedding'
  | 'priority_only_mode'
  // Phase 8A call policy actions
  | 'audio_only_mode'
  | 'video_disabled'
  | 'recording_forced';

interface CachedAction {
  action_type: AutoActionType;
  action_slug: string;
  expires_at: number; // ms epoch
}

const REFRESH_MS = 7_000; // 7s — between 5–10s as per scope
const STALE_FAIL_OPEN_MS = 60_000;

let cache: CachedAction[] = [];
let lastRefreshAt = 0;
let refreshTimer: ReturnType<typeof setInterval> | null = null;
let refreshing: Promise<void> | null = null;

export function startAutoActionsCache(config: ServerConfig): void {
  if (refreshTimer) return;
  // First refresh shortly after boot so we don't race the ticker.
  setTimeout(() => void refreshNow(config), 5_000);
  refreshTimer = setInterval(() => void refreshNow(config), REFRESH_MS);
  if (typeof (refreshTimer as any)?.unref === 'function') {
    (refreshTimer as any).unref();
  }
}

async function refreshNow(config: ServerConfig): Promise<void> {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      const sb = getServiceClient(config);
      const nowIso = new Date().toISOString();
      const { data, error } = await sb
        .from('auto_action_events')
        .select('action_type, action_slug, expires_at')
        .eq('state', 'active')
        .gt('expires_at', nowIso)
        .limit(50);
      if (error) {
        emitLog(config, 'warn', 'auto_action_cache_refresh_failed', {
          error: error.message,
        });
        return;
      }
      cache = (data || []).map((row) => ({
        action_type: row.action_type as AutoActionType,
        action_slug: row.action_slug,
        expires_at: new Date(row.expires_at).getTime(),
      }));
      lastRefreshAt = Date.now();
    } catch (err: any) {
      emitLog(config, 'warn', 'auto_action_cache_refresh_threw', {
        error: err?.message || 'unknown',
      });
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

/**
 * Synchronous, hot-path lookup. Returns true iff at least one currently-
 * active auto-action of the given type exists in the cache.
 * Fail-open: if the cache has never refreshed or is more than
 * STALE_FAIL_OPEN_MS behind, treat as "not active" — observability must
 * never silently break runtime behavior.
 */
export function isActionActive(actionType: AutoActionType): boolean {
  if (lastRefreshAt === 0) return false;
  if (Date.now() - lastRefreshAt > STALE_FAIL_OPEN_MS) return false;
  const now = Date.now();
  for (const a of cache) {
    if (a.action_type === actionType && a.expires_at > now) return true;
  }
  return false;
}

/**
 * Snapshot of the current cache, intended for /api/health-style debug
 * endpoints. Does NOT trigger a refresh.
 */
export function getActiveActionsSnapshot(): {
  actions: CachedAction[];
  last_refresh_at: number;
} {
  return { actions: [...cache], last_refresh_at: lastRefreshAt };
}

/**
 * Force a refresh — called by the auto-actions API after manual override
 * so subsequent requests see the change immediately instead of waiting
 * up to 7s for the next tick.
 */
export async function forceRefreshAutoActionsCache(
  config: ServerConfig,
): Promise<void> {
  await refreshNow(config);
}

export function __resetAutoActionsCacheForTests(): void {
  cache = [];
  lastRefreshAt = 0;
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  refreshing = null;
}