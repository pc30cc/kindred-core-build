/**
 * Sends a lightweight heartbeat every 2 minutes while the operator panel is
 * open and the tab is VISIBLE. The server uses each beat for:
 *   - ANALYTICS: at most one 5-minute bucket row for the "Operator activity"
 *     report (never a liveness signal).
 *   - LIVE PRESENCE FALLBACK ONLY: the `operator_presence_live` lease is
 *     refreshed exclusively when the realtime provider cannot supply
 *     presence (polling/disabled/Supabase, or Centrifugo presence
 *     unreadable). In healthy Centrifugo mode this beat performs ZERO
 *     live-presence writes — presence comes from channel membership
 *     (see useOperatorPresenceChannel).
 * Tab hidden => no beat => the operator goes offline within the liveness
 * window, which is the intended "available when using the app" semantics.
 */
import { useEffect } from 'react';
import { sendOperatorHeartbeat } from '@/lib/operator-activity-api';

/** One beat per 2 minutes: half the server liveness window, so a single
 *  missed beat never drops the operator offline. The server skips the
 *  analytics write when the 5-minute bucket is already recorded. */
const INTERVAL_MS = 120_000;

export function useOperatorHeartbeat(workspaceId: string | undefined) {
  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;

    const beat = () => {
      if (cancelled) return;
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      void sendOperatorHeartbeat(workspaceId);
    };

    beat();
    const id = setInterval(beat, INTERVAL_MS);
    document.addEventListener('visibilitychange', beat);
    return () => {
      cancelled = true;
      clearInterval(id);
      document.removeEventListener('visibilitychange', beat);
    };
  }, [workspaceId]);
}
