/**
 * Sends a lightweight heartbeat every 2 minutes while the operator panel is
 * mounted — INCLUDING when the tab is hidden. The server uses each beat for:
 *   - LIVE PRESENCE FALLBACK: refreshing the `operator_presence_live` lease.
 *   - INTERNAL ACTIVITY: only when `interacted` is true, i.e. the operator
 *     really typed/clicked/focused since the last beat. Idle beats keep the
 *     connection alive but let internal presence fall to "away" after 5
 *     minutes.
 *
 * Nothing here influences customer-facing availability: a hidden tab, a
 * sleeping laptop or a dropped network never make the team look offline to
 * visitors. That is decided solely by manual status + personal schedule.
 */
import { useEffect } from 'react';
import { sendOperatorHeartbeat } from '@/lib/operator-activity-api';

/** One beat per 2 minutes: half the server liveness window, so a single
 *  missed beat never drops the operator offline. */
const INTERVAL_MS = 120_000;

export function useOperatorHeartbeat(workspaceId: string | undefined) {
  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;

    // Cheap, passive interaction latch — no network traffic per event.
    let interacted = true;
    const markInteracted = () => { interacted = true; };
    const events = ['keydown', 'pointerdown', 'focus'] as const;
    for (const ev of events) window.addEventListener(ev, markInteracted, { passive: true });

    const beat = () => {
      if (cancelled) return;
      const didInteract = interacted;
      interacted = false;
      void sendOperatorHeartbeat(workspaceId, didInteract);
    };

    beat();
    const id = setInterval(beat, INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
      for (const ev of events) window.removeEventListener(ev, markInteracted);
    };
  }, [workspaceId]);
}
