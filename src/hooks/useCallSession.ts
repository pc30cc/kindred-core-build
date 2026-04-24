/**
 * Phase — Inbox Call Hardening · Pass 1
 *
 * React binding for CallSessionEngine. Owns ONE engine instance for the
 * lifetime of the host component. Wires the existing useLiveKitCall hook
 * into the engine as a MediaTransport, so we keep the SDK plumbing in one
 * place and the lifecycle logic in the engine.
 *
 * Hard guarantees:
 *  - On unmount, engine.dispose() runs → server hangup is best-effort
 *    issued, transport is torn down, busy is cleared. This closes the
 *    "operator navigates away mid-call" busy-leak bug.
 *  - The engine, not the component, is the single source of truth for
 *    `phase` and `busy`. The component only reads.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLiveKitCall, type UseLiveKitCallApi } from './useLiveKitCall';
import {
  CallSessionEngine,
  type CallSessionState,
  type MediaTransport,
  type StartOutgoingInput,
} from '@/lib/calls/CallSessionEngine';

export interface UseCallSessionApi {
  state: CallSessionState;
  startOutgoing: (input: StartOutgoingInput) => Promise<void>;
  hangup: () => Promise<void>;
  /** Direct media controls — read remote tracks, toggle local mic/cam. */
  media: UseLiveKitCallApi;
}

export function useCallSession(): UseCallSessionApi {
  // The transport hook stays exactly as-is. We never publish camera by
  // default; the engine flips it on per-call when call_type === 'video'.
  const lk = useLiveKitCall({ publishMic: true, publishCamera: false });

  // Bridge: the engine asks the transport to connect with explicit options.
  // We keep a ref to lk so the transport closure always sees the latest
  // stable functions (they are useCallback'd in the underlying hook).
  const lkRef = useRef(lk);
  lkRef.current = lk;

  const transport = useMemo<MediaTransport>(() => ({
    async connect(input) {
      // The underlying hook only publishes camera based on its initial
      // option, so for video calls we explicitly enable it after connect.
      await lkRef.current.connect({
        wsUrl: input.wsUrl,
        token: input.token,
        iceServers: input.iceServers,
        iceTransportPolicy: input.iceTransportPolicy,
      });
      if (input.publishCamera) {
        try { await lkRef.current.toggleCamera(); } catch { /* non-fatal */ }
      }
    },
    async disconnect() {
      await lkRef.current.disconnect();
    },
  }), []);

  const engineRef = useRef<CallSessionEngine | null>(null);
  if (!engineRef.current) {
    engineRef.current = new CallSessionEngine({
      transport,
      log: (msg, extra) => {
        if (typeof window !== 'undefined' && (window as { __CALL_DEBUG__?: boolean }).__CALL_DEBUG__) {
          // eslint-disable-next-line no-console
          console.debug('[CallEngine]', msg, extra ?? '');
        }
      },
    });
  }

  const [state, setState] = useState<CallSessionState>(() => engineRef.current!.getState());

  useEffect(() => {
    const off = engineRef.current!.subscribe(setState);
    return off;
  }, []);

  // Bridge transport-level signals → engine. We watch the LiveKit hook's
  // state and forward meaningful transitions. This is what catches "remote
  // hung up" / "connection lost" so busy gets released even when the
  // operator does not click End.
  const lastLkStateRef = useRef(lk.state);
  useEffect(() => {
    const prev = lastLkStateRef.current;
    lastLkStateRef.current = lk.state;
    const eng = engineRef.current!;
    if (lk.state === 'reconnecting') eng.onTransportReconnecting();
    else if (lk.state === 'connected' && prev === 'reconnecting') eng.onTransportReconnected();
    else if (lk.state === 'disconnected' && (prev === 'connected' || prev === 'reconnecting')) {
      void eng.onTransportDisconnected('remote');
    } else if (lk.state === 'failed') {
      void eng.onTransportDisconnected('failure');
    }
  }, [lk.state]);

  // Unmount = hard cleanup. This is the busy-leak safety net.
  useEffect(() => {
    const eng = engineRef.current!;
    return () => { void eng.dispose(); };
  }, []);

  const startOutgoing = useCallback(
    (input: StartOutgoingInput) => engineRef.current!.startOutgoing(input),
    [],
  );
  const hangup = useCallback(() => engineRef.current!.hangup(), []);

  return { state, startOutgoing, hangup, media: lk };
}