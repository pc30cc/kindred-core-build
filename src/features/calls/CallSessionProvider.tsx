/**
 * Phase — Inbox Call Unification · Pass B + C
 *
 * Single CallSessionEngine instance per inbox host. Both the
 * OperatorCallPanel (per-conversation header) and the global
 * IncomingCallSurface (workspace-level modal) bind to the SAME engine
 * via this context. That is what makes incoming and outgoing share one
 * lifecycle / busy lock instead of running in parallel.
 *
 * The provider itself does the LiveKit transport binding so the engine
 * stays UI-agnostic. On unmount it disposes the engine — final safety
 * net against busy leaks.
 */
import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
} from 'react';
import { useLiveKitCall, type UseLiveKitCallApi } from '@/hooks/useLiveKitCall';
import {
  CallSessionEngine,
  type CallSessionState,
  type MediaTransport,
  type StartOutgoingInput,
  type AcceptIncomingInput,
} from '@/lib/calls/CallSessionEngine';

export interface CallSessionContextValue {
  engine: CallSessionEngine;
  state: CallSessionState;
  startOutgoing: (input: StartOutgoingInput) => Promise<void>;
  acceptIncoming: (input?: AcceptIncomingInput) => Promise<void>;
  declineIncoming: (reason?: string) => Promise<void>;
  hangup: () => Promise<void>;
  /** Direct media controls (mute, camera toggle, remote tracks). */
  media: UseLiveKitCallApi;
}

const Ctx = createContext<CallSessionContextValue | null>(null);

export function CallSessionProvider({ children }: { children: React.ReactNode }) {
  // Audio always published; camera is flipped by the engine per-call.
  const lk = useLiveKitCall({ publishMic: true, publishCamera: false });
  const lkRef = useRef(lk);
  lkRef.current = lk;

  const transport = useMemo<MediaTransport>(() => ({
    async connect(input) {
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
  useEffect(() => engineRef.current!.subscribe(setState), []);

  // Bridge transport-level signals → engine.
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

  // Final cleanup. Provider unmounts only when the operator leaves the
  // inbox shell — we still tear the call down to avoid orphan busy.
  useEffect(() => () => { void engineRef.current!.dispose(); }, []);

  const startOutgoing = useCallback(
    (input: StartOutgoingInput) => engineRef.current!.startOutgoing(input), [],
  );
  const acceptIncoming = useCallback(
    (input?: AcceptIncomingInput) => engineRef.current!.acceptIncoming(input), [],
  );
  const declineIncoming = useCallback(
    (reason?: string) => engineRef.current!.declineIncoming(reason), [],
  );
  const hangup = useCallback(() => engineRef.current!.hangup(), []);

  const value = useMemo<CallSessionContextValue>(() => ({
    engine: engineRef.current!,
    state,
    startOutgoing,
    acceptIncoming,
    declineIncoming,
    hangup,
    media: lk,
  }), [state, startOutgoing, acceptIncoming, declineIncoming, hangup, lk]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useCallSessionContext(): CallSessionContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useCallSessionContext must be used within <CallSessionProvider>');
  return v;
}

/** Optional accessor — returns null when no provider is mounted. */
export function useOptionalCallSessionContext(): CallSessionContextValue | null {
  return useContext(Ctx);
}