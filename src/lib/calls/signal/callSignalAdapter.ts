/**
 * Call Signal Adapter — single owner of incoming-offer ingestion.
 *
 * Architecture target:
 *   signal source(s) → callSignalAdapter → CallSessionEngine → UI
 *
 * Why this exists:
 *   Before this layer, every UI surface (IncomingCallSurface, queue panel,
 *   dock) was free to poll the queue and act on it. That is what created
 *   the "two parallel call systems" feeling. Now those surfaces just read
 *   engine state, and ALL incoming offer detection happens here.
 *
 * Signal sources (ranked):
 *   1. Realtime Centrifugo channel `ws:{workspaceId}:queue` — preferred.
 *      Server publishes `event` envelopes with payload.kind='call_queue'
 *      on every queue lifecycle transition (offered/accepted/cancelled/
 *      expired/missed/requeued).
 *   2. Periodic poll of /api/call-queue — fallback + reconciliation.
 *      Realtime can drop frames during reconnects; the slow poll picks
 *      up offers that arrived during a socket gap. We slow the poll down
 *      considerably when realtime is healthy (30s instead of 5s) so we
 *      do NOT replicate the previous polling-first cadence.
 *
 * Multi-offer handling:
 *   The engine enforces one-call-at-a-time. The adapter still tracks the
 *   total count of offers visible to this operator so the UI can show a
 *   discreet "another call waiting" indicator (badge in the dock). It
 *   never feeds the engine a second offer while the engine is busy.
 *
 * Logging:
 *   Behind window.__CALL_DEBUG__. No state spam in production.
 */
import { callQueueApi, type CallQueueEntry } from '@/lib/call-queue-api';
import { resolveClientRealtimeProvider } from '@/realtime';
import type { RealtimeSubscription } from '@/realtime';
import type { CallSessionEngine, IncomingOffer } from '@/lib/calls/CallSessionEngine';

const POLL_FAST_MS = 6_000;   // when realtime is unavailable / pre-confirmed
const POLL_SLOW_MS = 30_000;  // when realtime is healthy — reconciliation only

function logDebug(msg: string, data?: unknown): void {
  if (typeof window !== 'undefined' && (window as { __CALL_DEBUG__?: boolean }).__CALL_DEBUG__) {
    // eslint-disable-next-line no-console
    console.debug('[callSignal]', msg, data ?? '');
  }
}

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

export interface CallSignalAdapterStats {
  /** True when the realtime socket is currently feeding us live updates. */
  realtimeHealthy: boolean;
  /** Total offers visible to this operator across the workspace. */
  totalOffers: number;
  /** Offers explicitly addressed to this operator (state='offered' & offered_to_user_id===me). */
  offersForMe: number;
  /** Last reconciliation timestamp (ms). */
  lastReconcileAt: number;
}

export type StatsListener = (s: CallSignalAdapterStats) => void;

export interface StartAdapterInput {
  workspaceId: string;
  userId: string;
  engine: CallSessionEngine;
  onStats?: StatsListener;
}

export interface CallSignalAdapterHandle {
  stop(): void;
  /** Force a reconciliation pass (useful on visibility-change). */
  reconcile(): Promise<void>;
}

/**
 * Start the adapter. Returns a handle the caller MUST stop on cleanup.
 * Idempotent against the same engine instance — repeated start calls are
 * harmless but only the most recent handle controls lifecycle.
 */
export function startCallSignalAdapter(input: StartAdapterInput): CallSignalAdapterHandle {
  const { workspaceId, userId, engine, onStats } = input;

  let stopped = false;
  let activeOfferId: string | null = null;
  let realtimeHealthy = false;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let rtSub: RealtimeSubscription | null = null;

  const stats: CallSignalAdapterStats = {
    realtimeHealthy: false,
    totalOffers: 0,
    offersForMe: 0,
    lastReconcileAt: 0,
  };

  const emitStats = () => {
    stats.realtimeHealthy = realtimeHealthy;
    onStats?.({ ...stats });
  };

  /**
   * Apply a list of queue entries to the engine.
   * Rules:
   *   - "Offers for me" = state==='offered' && offered_to_user_id===userId
   *   - First such offer becomes the engine's active incoming.
   *   - If the active offer disappears, tell the engine.
   *   - Engine itself drops a new offer if it is already busy (one-call-at-a-time).
   */
  const reconcile = async (): Promise<void> => {
    if (stopped) return;
    try {
      const r = await callQueueApi.list(workspaceId);
      if (stopped) return;
      const total = r.entries.filter((e) => e.state === 'queued' || e.state === 'offered').length;
      const myOffers = r.entries.filter(
        (e) => e.state === 'offered' && e.offered_to_user_id === userId,
      );
      const primary = myOffers[0] ?? null;

      stats.totalOffers = total;
      stats.offersForMe = myOffers.length;
      stats.lastReconcileAt = Date.now();
      emitStats();

      const prev = activeOfferId;
      if (primary) {
        activeOfferId = primary.id;
        if (prev !== primary.id) {
          logDebug('reconcile → receive', { offerId: primary.id });
        }
        engine.receiveIncoming(offerFrom(primary));
      } else if (prev) {
        activeOfferId = null;
        logDebug('reconcile → cancel (vanished)', { offerId: prev });
        void engine.cancelIncoming('remote_cancelled');
      }
    } catch (err) {
      // Network blip — never tear down a valid ring on transient failure.
      logDebug('reconcile failed', err);
    }
  };

  const schedulePoll = () => {
    if (stopped) return;
    if (pollTimer) clearTimeout(pollTimer);
    const delay = realtimeHealthy ? POLL_SLOW_MS : POLL_FAST_MS;
    pollTimer = setTimeout(async () => {
      await reconcile();
      schedulePoll();
    }, delay);
  };

  // Subscribe to the realtime queue channel (best-effort).
  // On any incoming push we immediately reconcile — the queue endpoint is
  // cheap and the reconcile handles every transition (offered → cancelled,
  // accepted-by-other, requeued) without needing per-event branching.
  (async () => {
    try {
      const provider = await resolveClientRealtimeProvider(workspaceId);
      if (stopped) return;
      const channel = `ws:${workspaceId}:queue`;
      rtSub = await provider.subscribe(channel, {
        onEvent: () => {
          // Any queue event ⇒ reconcile so the engine sees the truth.
          void reconcile();
        },
        onStatus: (status) => {
          const wasHealthy = realtimeHealthy;
          realtimeHealthy = status === 'open';
          if (wasHealthy !== realtimeHealthy) {
            emitStats();
            // Reschedule poll cadence on health flips.
            schedulePoll();
            // On regaining health, reconcile immediately.
            if (realtimeHealthy) void reconcile();
          }
        },
      });
      // Polling provider returns vendor='polling' and emits no `onEvent`;
      // that is fine — the slow/fast poll below covers it.
    } catch (err) {
      logDebug('queue subscribe failed', err);
    }
  })();

  // Page visibility — when the operator returns to the tab, reconcile
  // immediately rather than waiting for the next poll tick.
  const onVisibility = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
      void reconcile();
    }
  };
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibility);
  }

  // Kick off — first reconcile + start poll loop.
  void reconcile();
  schedulePoll();

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      if (pollTimer) clearTimeout(pollTimer);
      pollTimer = null;
      if (rtSub) {
        try { rtSub.unsubscribe(); } catch { /* */ }
      }
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibility);
      }
    },
    reconcile,
  };
}