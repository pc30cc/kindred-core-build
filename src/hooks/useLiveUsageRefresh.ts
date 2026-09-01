import { useEffect, useRef } from 'react';

/**
 * Live refresh for workspace usage counters.
 *
 * Why not Supabase `postgres_changes` on `workspace_usage_counters`?
 * The browser Supabase client carries no Supabase JWT in this app
 * (authentication is first-party `gs_session`), and both RLS policies on
 * that table require `auth.uid()`. Realtime enforces RLS, so a
 * postgres_changes subscription would silently deliver zero rows.
 *
 * Instead this hook drives a live refresh loop against the first-party
 * API (which authorizes from the session principal):
 *   - poll on an interval while the tab is visible
 *   - refresh immediately when the tab becomes visible / regains focus
 *   - never poll in a hidden tab (no wasted requests)
 */
export function useLiveUsageRefresh(
  enabled: boolean,
  refresh: () => void,
  intervalMs = 20_000,
) {
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    if (!enabled) return;

    let timer: ReturnType<typeof setInterval> | null = null;

    const tick = () => {
      if (document.visibilityState !== 'visible') return;
      refreshRef.current();
    };

    const start = () => {
      if (timer) return;
      timer = setInterval(tick, intervalMs);
    };
    const stop = () => {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    };

    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        refreshRef.current();
        start();
      } else {
        stop();
      }
    };
    const onFocus = () => {
      if (document.visibilityState === 'visible') refreshRef.current();
    };

    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', onFocus);

    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', onFocus);
    };
  }, [enabled, intervalMs]);
}
