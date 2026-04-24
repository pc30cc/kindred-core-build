/**
 * Phase — Inbox Call Unification · Pass B
 *
 * Single signal source that detects incoming call offers for the current
 * operator and pipes them into a CallSessionEngine via the supplied
 * commands. UI surfaces no longer poll the queue themselves for ringing
 * detection — they read engine state.
 *
 * Why polling and not realtime?
 *   The existing call_queue_entries flow already drives offers via REST.
 *   A realtime-first variant can replace this hook later WITHOUT touching
 *   any surface, because the contract is pure: "call engine.receiveIncoming
 *   when an offer appears, engine.cancelIncoming when it goes away".
 *
 * Lifecycle:
 *  - polls /api/call-queue every 5s (same cadence as other panels)
 *  - finds the offer where state==='offered' && offered_to_user_id===me
 *  - if a new offer appears → engine.receiveIncoming()
 *  - if the active offer disappears → engine.cancelIncoming('remote_cancelled')
 *  - tab visibility changes do NOT change polling cadence (the engine
 *    owns ringtone gating; this hook just feeds the data)
 */
import { useEffect, useRef } from 'react';
import { callQueueApi, type CallQueueEntry } from '@/lib/call-queue-api';
import type { CallSessionEngine, IncomingOffer } from '@/lib/calls/CallSessionEngine';

const POLL_MS = 5000;

function offerFrom(entry: CallQueueEntry): IncomingOffer {
  const md = (entry.metadata || {}) as Record<string, unknown>;
  return {
    offerId: entry.id,
    workspaceId: entry.workspace_id,
    callType: entry.channel === 'video' ? 'video' : 'audio',
    conversationId: entry.conversation_id,
    callSessionId: entry.call_session_id,
    visitorName: typeof md.visitor_name === 'string' ? md.visitor_name : null,
    country: typeof md.country === 'string' ? md.country : null,
    expiresAt: entry.last_offer_expires_at ?? entry.expires_at ?? null,
  };
}

export function useIncomingCallSignal(opts: {
  workspaceId: string | null | undefined;
  userId: string | null | undefined;
  engine: CallSessionEngine | null;
}): void {
  const { workspaceId, userId, engine } = opts;
  // Track the offer id we're currently feeding so we can detect transitions.
  const activeIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!workspaceId || !userId || !engine) return;
    let cancelled = false;

    const tick = async () => {
      try {
        const r = await callQueueApi.list(workspaceId);
        if (cancelled) return;
        const offer = r.entries.find(
          (e) => e.state === 'offered' && e.offered_to_user_id === userId,
        ) ?? null;

        const prevId = activeIdRef.current;
        if (offer) {
          activeIdRef.current = offer.id;
          engine.receiveIncoming(offerFrom(offer));
        } else if (prevId) {
          // Active offer vanished — engine will release busy & stop ring.
          activeIdRef.current = null;
          void engine.cancelIncoming('remote_cancelled');
        }
      } catch {
        // Network blips are silent; next tick retries. Critical: do NOT
        // call cancelIncoming on a transient error — that would falsely
        // tear down a valid ring.
      }
    };

    void tick();
    const id = setInterval(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [workspaceId, userId, engine]);
}