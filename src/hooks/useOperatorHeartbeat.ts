/**
 * Sends a lightweight presence heartbeat every 30s while the operator panel
 * is open and the tab is visible. The server converts heartbeats into
 * minute buckets used by the "Operator activity" report.
 */
import { useEffect } from 'react';
import { sendOperatorHeartbeat } from '@/lib/operator-activity-api';

const INTERVAL_MS = 30_000;

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
