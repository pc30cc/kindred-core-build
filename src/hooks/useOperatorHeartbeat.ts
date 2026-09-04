/**
 * Sends a lightweight presence heartbeat every 2 minutes while the operator
 * panel is open and the tab is VISIBLE. The server uses each beat twice:
 *   - refreshes the live presence row (source of truth for online dots,
 *     routing eligibility and widget availability; ~5 min liveness window)
 *   - records at most one 5-minute analytics bucket for the
 *     "Operator activity" report.
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
