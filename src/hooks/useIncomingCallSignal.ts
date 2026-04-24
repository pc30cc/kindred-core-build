/**
 * Phase — Final Inbox Call Hardening · Pass A + B
 *
 * Thin React binding for the central Call Signal Adapter. The adapter
 * owns ALL incoming-offer detection (realtime-first via Centrifugo queue
 * channel, polling only for reconciliation). UI surfaces never poll the
 * queue themselves for ringing — they read engine state and, optionally,
 * the adapter stats this hook exposes.
 *
 * Multi-offer policy:
 *   The engine is single-offer. The adapter still tracks "totalOffers"
 *   and "offersForMe" so UI can show a discreet "another call waiting"
 *   indicator (used by OperatorCallDock).
 */
import { useEffect, useState } from 'react';
import {
  startCallSignalAdapter,
  type CallSignalAdapterStats,
} from '@/lib/calls/signal/callSignalAdapter';
import type { CallSessionEngine } from '@/lib/calls/CallSessionEngine';

const INITIAL_STATS: CallSignalAdapterStats = {
  realtimeHealthy: false,
  totalOffers: 0,
  offersForMe: 0,
  lastReconcileAt: 0,
};

export function useIncomingCallSignal(opts: {
  workspaceId: string | null | undefined;
  userId: string | null | undefined;
  engine: CallSessionEngine | null;
}): CallSignalAdapterStats {
  const { workspaceId, userId, engine } = opts;
  const [stats, setStats] = useState<CallSignalAdapterStats>(INITIAL_STATS);

  useEffect(() => {
    if (!workspaceId || !userId || !engine) return;
    const handle = startCallSignalAdapter({
      workspaceId,
      userId,
      engine,
      onStats: setStats,
    });
    return () => handle.stop();
  }, [workspaceId, userId, engine]);

  return stats;
}