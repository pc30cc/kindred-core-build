/**
 * OperatorCallProvider — single source of truth for the operator's
 * outbound call lifecycle. Lifted out of SidebarCallCard so the room
 * survives:
 *   - inbox sidebar unmount
 *   - selected-conversation switches (the legacy behavior, preserved by
 *     intentionally disconnecting on switch, can still be triggered via
 *     `requestConversationSwitch()`)
 *   - route navigation across the workspace shell (the provider lives
 *     above <Outlet /> in AppLayout)
 *
 * Mounting model
 *   <AppLayout>
 *     <OperatorCallProvider>
 *       <Outlet />                   ← inbox / contacts / settings / …
 *       <FloatingOperatorCallWindow/>← reads provider, follows operator
 *     </OperatorCallProvider>
 *   </AppLayout>
 *
 * Strict rules carried over from the previous SidebarCallCard:
 *   - Token + URLs come from /api/calls/:id/token (callsApi.token).
 *     Never minted client-side.
 *   - Audio invitations NEVER publish camera and NEVER show video stages.
 *   - Disconnect goes through `useLiveKitCall.disconnect(reason, ctx)`
 *     so every leave is traceable in the console.
 *   - The provider NEVER disconnects on unmount of any consumer; the
 *     room only goes down on explicit hangup, server end, terminal
 *     status, or the owning AppLayout finally unmounting (sign-out /
 *     full app shutdown).
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  callInvitationsApi,
  type CallInvitation,
  type InvitationChannel,
} from '@/lib/call-invitations-api';
import { onInvitationChanged } from '@/lib/call-invitations-events';
import { onCallEnded, type CallEndedEvent } from '@/lib/call-end-events';
import { callsApi } from '@/lib/calls-api';
import { useLiveKitCall } from '@/hooks/useLiveKitCall';
import type { CallVideoQuality } from '@/hooks/useLiveKitCall';
import { fetchWorkspaceCallSettings } from '@/lib/workspace-calls-api';
import { useLocalMediaPreview, type LocalPreviewState } from '@/hooks/useLocalMediaPreview';
import { rtDebug } from '@/realtime/debug';
import { toast } from '@/hooks/use-toast';
import { startRingback, stopRingback } from './callSound';

export type SurfacePhase = 'idle' | 'waiting' | 'connecting' | 'connected' | 'terminal';
export type TerminalStatus =
  | 'expired'
  | 'cancelled'
  | 'declined'
  | 'failed'
  | 'remote_ended'
  | 'connect_failed_remote'
  | null;

export interface LastEndedSummary {
  ended_by: 'operator' | 'visitor' | 'system';
  reason:
    | 'operator_ended'
    | 'visitor_ended'
    | 'system_ended'
    | 'failed'
    | 'visitor_connect_failed';
  duration_seconds: number;
  ended_at: string;
  conversation_id: string | null;
}

export interface OperatorCallSurface {
  phase: SurfacePhase;
  invitation: CallInvitation | null;
  channel: InvitationChannel;
  terminalStatus: TerminalStatus;
  errorMessage: string | null;
  /** Conversation id this surface belongs to (matches invitation). */
  conversationId: string | null;
  /** Optional contact name for nicer copy in floating window / sidebar. */
  contactName: string | null;
  /** Workspace id used to create the invitation. */
  workspaceId: string | null;
}

const INITIAL_SURFACE: OperatorCallSurface = {
  phase: 'idle',
  invitation: null,
  channel: 'audio',
  terminalStatus: null,
  errorMessage: null,
  conversationId: null,
  contactName: null,
  workspaceId: null,
};

interface AutoCloseTarget {
  invitationId: string | null;
  callSessionId: string | null;
  conversationId: string | null;
}

function callLog(message: string, data?: Record<string, unknown>): void {
  // eslint-disable-next-line no-console
  console.debug(`[call] ${message}`, data ?? {});
}

function callWarn(message: string, data?: Record<string, unknown>): void {
  // eslint-disable-next-line no-console
  console.warn(`[call] ${message}`, data ?? {});
}

export type FloatingMode = 'docked' | 'expanded' | 'minimized';

export interface OperatorCallContextValue {
  /** Current surface state — same semantics as the legacy SidebarCallCard. */
  surface: OperatorCallSurface;
  /** Pending creation channel (so the sidebar can spin its CTA). */
  creating: InvitationChannel | null;
  /** Generic loading flag for cancel / create. */
  loading: boolean;
  /** Live LiveKit call API (state, remote media, controls). */
  live: ReturnType<typeof useLiveKitCall>;
  /** Local-device preview during the waiting phase. */
  preview: { stream: MediaStream | null; state: LocalPreviewState };
  /** Floating-window UI mode. */
  floatingMode: FloatingMode;
  setFloatingMode(next: FloatingMode): void;
  /** Most recent invitation for the *given* conversation (drives sidebar pill). */
  latestForConversation(conversationId: string): CallInvitation | null;
  /** Initiate an invitation. */
  sendInvite(args: {
    workspaceId: string;
    conversationId: string;
    contactName: string | null;
    channel: InvitationChannel;
    ttlSeconds: number;
  }): Promise<void>;
  cancelInvite(): Promise<void>;
  /** Operator hangup (or close terminal early). */
  hangup(): Promise<void>;
  /** Close a terminal call UI without calling the hangup/end endpoint. */
  closeTerminal(): void;
  /** Force-refresh the latest invitation for a conversation (sidebar polling). */
  refreshLatest(conversationId: string): Promise<void>;
  /** Pass A — last ended summary for "Call ended · mm:ss" UI. */
  lastEnded: LastEndedSummary | null;
  clearLastEnded(): void;
  /** In-call video quality preset (operator selectable). */
  videoQuality: CallVideoQuality;
  setVideoQuality(q: CallVideoQuality): Promise<void>;
}

const OperatorCallContext = createContext<OperatorCallContextValue | null>(null);

export function useOperatorCall(): OperatorCallContextValue {
  const ctx = useContext(OperatorCallContext);
  if (!ctx) {
    throw new Error('useOperatorCall must be used within <OperatorCallProvider>');
  }
  return ctx;
}

/** Optional consumer that returns null when the provider is not mounted —
 *  used by the floating window so it can no-op outside AppLayout. */
export function useOperatorCallOptional(): OperatorCallContextValue | null {
  return useContext(OperatorCallContext);
}

export function OperatorCallProvider({ children }: { children: ReactNode }) {
  const [surface, setSurface] = useState<OperatorCallSurface>(INITIAL_SURFACE);
  const [creating, setCreating] = useState<InvitationChannel | null>(null);
  const [loading, setLoading] = useState(false);
  const [floatingMode, setFloatingMode] = useState<FloatingMode>('docked');
  const [lastEnded, setLastEnded] = useState<LastEndedSummary | null>(null);
  const [workspaceDefaultQuality, setWorkspaceDefaultQuality] = useState<CallVideoQuality>('auto');
  // Latest invitation per conversation — for the sidebar pill. Kept in
  // a ref+state pair so reads are cheap and writes still trigger the
  // sidebar consumers to re-render.
  const [latestMap, setLatestMap] = useState<Record<string, CallInvitation | null>>({});

  const autoCloseRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const surfaceRef = useRef<OperatorCallSurface>(surface);
  const cancellingRef = useRef(false);
  const connectedInvitationIdRef = useRef<string | null>(null);
  const startedConnectInvitationIdRef = useRef<string | null>(null);
  // Active call refs (used for disconnect ctx logging).
  const activeCallSessionIdRef = useRef<string | null>(null);
  const activeCallConversationIdRef = useRef<string | null>(null);
  // Pass A.2 — Keep the last-active session id around for 30s after we
  // clear the live refs. This lets us still semantically handle a
  // `call:ended` event that arrives slightly AFTER LiveKit emitted
  // Disconnected and we tore the local room down (visitor hangup race).
  const lastActiveCallSessionIdRef = useRef<string | null>(null);
  const lastActiveCallConversationIdRef = useRef<string | null>(null);
  const lastActiveCallEndedAtRef = useRef<number>(0);
  const RECENT_ENDED_WINDOW_MS = 30_000;
  // Pass A.2 — Per-participant fallback timers. If the visitor's LiveKit
  // participant disappears but the server hasn't published call:ended
  // within 1500ms we POST /api/calls/:id/end ourselves with reason
  // 'system_ended' so the operator UI never hangs at "in call" with no
  // remote stream.
  const remoteLeftFallbackRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previousRemoteCountRef = useRef<number>(0);
  // Pass A.3 — record when we entered 'connected' so we can compute a
  // best-effort local duration for the immediate visitor-ended terminal
  // state, before the server's /end response arrives with the canonical
  // duration_seconds.
  const connectedAtRef = useRef<number>(0);
  // True once we've already shown the immediate "Visitor ended" terminal
  // state for the current session, so the call:ended event that arrives
  // 100–1500ms later updates the existing surface (with duration) instead
  // of re-opening anything.
  const remoteEndedShownRef = useRef<boolean>(false);
  const hasLiveConnectSucceededRef = useRef<boolean>(false);
  const hasRemoteParticipantEverConnectedRef = useRef<boolean>(false);
  const hasRemoteTrackEverSubscribedRef = useRef<boolean>(false);
  const remoteParticipantSeenAtRef = useRef<number>(0);
  const connectStartedAtRef = useRef<number>(0);
  const liveConnectPendingRef = useRef<boolean>(false);
  const realVisitorDisconnectedRef = useRef<boolean>(false);

  const markRemoteParticipantSeen = useCallback((source: 'participant_connected' | 'track_subscribed' | 'snapshot', detail?: Record<string, unknown>) => {
    if (!hasRemoteParticipantEverConnectedRef.current) {
      hasRemoteParticipantEverConnectedRef.current = true;
      remoteParticipantSeenAtRef.current = Date.now();
      callLog('remote participant seen', { source, ...detail });
    }
  }, []);

  const resetPerCallLifecycleRefs = useCallback(() => {
    if (remoteLeftFallbackRef.current) {
      clearTimeout(remoteLeftFallbackRef.current);
      remoteLeftFallbackRef.current = null;
    }
    remoteEndedShownRef.current = false;
    previousRemoteCountRef.current = 0;
    hasLiveConnectSucceededRef.current = false;
    hasRemoteParticipantEverConnectedRef.current = false;
    hasRemoteTrackEverSubscribedRef.current = false;
    remoteParticipantSeenAtRef.current = 0;
    connectStartedAtRef.current = 0;
    liveConnectPendingRef.current = false;
    realVisitorDisconnectedRef.current = false;
  }, []);

  useEffect(() => {
    surfaceRef.current = surface;
  }, [surface]);

  const live = useLiveKitCall({
    publishMic: true,
    publishCamera: surface.channel === 'video',
    onRemoteParticipantSeen: ({ identity, source }) => {
      markRemoteParticipantSeen(source, { identity });
    },
    onRemoteParticipantDisconnected: ({ identity }) => {
      if (hasRemoteParticipantEverConnectedRef.current) {
        realVisitorDisconnectedRef.current = true;
        callLog('remote participant disconnected', { identity });
      }
    },
    onRemoteTrackSubscribed: ({ identity, kind, trackSid }) => {
      hasRemoteTrackEverSubscribedRef.current = true;
      markRemoteParticipantSeen('track_subscribed', { identity, kind, trackSid });
      callLog('remote track subscribed', { identity, kind, trackSid });
    },
  });

  // Pass B — load workspace default video quality once we know the
  // workspace id (when the operator opens an invite). Falls back to
  // 'auto' on any error so the call never fails over a settings fetch.
  useEffect(() => {
    const wsId = surface.workspaceId;
    if (!wsId) return;
    let cancelled = false;
    fetchWorkspaceCallSettings(wsId)
      .then((r) => {
        if (cancelled) return;
        const q = (r.overrides?.default_video_quality || 'auto') as CallVideoQuality;
        setWorkspaceDefaultQuality(q);
        // Push into the live hook before the connect phase publishes.
        void live.setVideoQuality(q);
      })
      .catch(() => { /* ignore */ });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [surface.workspaceId]);

  const preview = useLocalMediaPreview({
    enabled: surface.phase === 'waiting',
    wantVideo: surface.channel === 'video',
  });

  const disconnectLive = useCallback((
    reason: Parameters<typeof live.disconnect>[0],
    currentConversationId: string | null = surface.conversationId,
  ) => {
    if (
      reason === 'server_call_ended' &&
      (!activeCallSessionIdRef.current || !activeCallConversationIdRef.current)
    ) {
      callWarn('ignored call:ended without active session', {
        activeCallSessionId: activeCallSessionIdRef.current,
        activeCallConversationId: activeCallConversationIdRef.current,
        currentConversationId,
      });
      return Promise.resolve();
    }
    return live.disconnect(reason, {
      activeCallSessionId: activeCallSessionIdRef.current,
      activeCallConversationId: activeCallConversationIdRef.current,
      currentConversationId,
    });
  }, [live, surface.conversationId]);

  const clearActiveCallRefs = useCallback(() => {
    // Snapshot the last active session before clearing — UI may still
    // need it if a server-published call:ended event arrives a moment
    // late (visitor hangup → LK Disconnected → call:ended ordering race).
    if (activeCallSessionIdRef.current) {
      lastActiveCallSessionIdRef.current = activeCallSessionIdRef.current;
      lastActiveCallConversationIdRef.current = activeCallConversationIdRef.current;
      lastActiveCallEndedAtRef.current = Date.now();
    }
    activeCallConversationIdRef.current = null;
    activeCallSessionIdRef.current = null;
    connectedInvitationIdRef.current = null;
    startedConnectInvitationIdRef.current = null;
    resetPerCallLifecycleRefs();
    connectedAtRef.current = 0;
  }, [resetPerCallLifecycleRefs]);

  // Auto-close terminal surface after a short delay so it briefly shows
  // the outcome and then reverts to IDLE, exposing the invite buttons.
  const scheduleAutoClose = useCallback((delayMs: number, target: AutoCloseTarget) => {
    if (autoCloseRef.current) clearTimeout(autoCloseRef.current);
    autoCloseRef.current = setTimeout(() => {
      const cur = surfaceRef.current;
      const currentInvitationId = cur.invitation?.id ?? null;
      const currentCallSessionId = activeCallSessionIdRef.current ?? cur.invitation?.call_session_id ?? null;
      const invitationMatches = target.invitationId === currentInvitationId;
      const sessionMatches = !target.callSessionId || target.callSessionId === currentCallSessionId;
      if (cur.phase !== 'terminal' || !invitationMatches || !sessionMatches) {
        callLog('ignored stale terminal auto-close', {
          target,
          currentPhase: cur.phase,
          currentInvitationId,
          currentCallSessionId,
        });
        return;
      }
      rtDebug('call', 'auto-close terminal matched', { target });
      clearActiveCallRefs();
      setSurface(INITIAL_SURFACE);
      setFloatingMode('docked');
    }, delayMs);
  }, [clearActiveCallRefs]);

  useEffect(() => {
    if (surface.phase !== 'terminal') return;
    const delay = surface.terminalStatus === 'cancelled' ? 1800 : 3500;
    scheduleAutoClose(delay, {
      invitationId: surface.invitation?.id ?? null,
      callSessionId: activeCallSessionIdRef.current ?? surface.invitation?.call_session_id ?? null,
      conversationId: surface.conversationId,
    });
  }, [surface.phase, surface.terminalStatus, surface.invitation?.id, surface.invitation?.call_session_id, surface.conversationId, scheduleAutoClose]);

  // ── Operator ringback ─────────────────────────────────────────────────
  // Plays a soft Web Audio ringback while we're waiting for the visitor to
  // answer. Stops on every other phase or when this component unmounts so
  // the operator never hears a phantom ring after a call has connected,
  // failed, been cancelled, or the visitor declined.
  useEffect(() => {
    if (surface.phase === 'waiting') {
      startRingback();
      return () => { stopRingback('phase_change'); };
    }
    // Any non-waiting phase (connecting / connected / terminal / idle)
    // immediately silences ringback. We pass the phase as the reason for
    // diagnostic clarity.
    stopRingback(`phase:${surface.phase}`);
    return undefined;
  }, [surface.phase]);

  // Final safety net — guarantee silence on provider unmount even if a
  // terminal/idle transition got skipped (e.g. hard sign-out / route swap).
  useEffect(() => {
    return () => { stopRingback('provider_unmount'); };
  }, []);

  // ── Realtime subscription drives surface lifecycle for the active
  //    invitation and updates the latestMap for every conversation.
  useEffect(() => {
    return onInvitationChanged((evt) => {
      // Update latest map for the changed conversation.
      setLatestMap((prev) => {
        const cur = prev[evt.conversation_id] ?? null;
        if (cur && cur.id === evt.invitation_id) {
          return { ...prev, [evt.conversation_id]: { ...cur, status: evt.status } };
        }
        return prev;
      });
      // Drive active surface lifecycle.
      setSurface((prev) => {
        if (!prev.invitation) return prev;
        if (prev.invitation.id !== evt.invitation_id) return prev;
        if (
          connectedInvitationIdRef.current === evt.invitation_id &&
          (prev.phase === 'connected' || prev.phase === 'connecting')
        ) {
          rtDebug('call', 'ignoring stale invitation event', {
            invitation_id: evt.invitation_id,
            status: evt.status,
            phase: prev.phase,
          });
          return prev;
        }
        const status = evt.status;
        if (status === 'pending') {
          return { ...prev, invitation: { ...prev.invitation, status: 'pending' } };
        }
        if (status === 'joined') {
          if (prev.phase !== 'waiting') return prev;
          callLog('invitation joined', {
            invitation_id: evt.invitation_id,
            conversation_id: evt.conversation_id,
          });
          return {
            ...prev,
            phase: 'connecting',
            invitation: { ...prev.invitation, status: 'joined' },
          };
        }
        return {
          ...prev,
          phase: 'terminal',
          invitation: { ...prev.invitation, status },
          terminalStatus: status as Exclude<TerminalStatus, null | 'failed'>,
        };
      });
    });
  }, []);

  // ── On 'connecting' phase → resolve token and connect media.
  useEffect(() => {
    if (surface.phase !== 'connecting') return;
    const inv = surface.invitation;
    if (!inv) return;
    if (startedConnectInvitationIdRef.current === inv.id) return;
    resetPerCallLifecycleRefs();
    startedConnectInvitationIdRef.current = inv.id;
    connectStartedAtRef.current = Date.now();
    liveConnectPendingRef.current = true;
    let cancelled = false;
    (async () => {
      try {
        const fresh = await callInvitationsApi.get(inv.id)
          .then((r) => r.invitation)
          .catch(() => inv);
        if (cancelled) return;
        const callSessionId = fresh?.call_session_id;
        if (!callSessionId) throw new Error('missing_call_session');
        callLog('resolved call_session_id', {
          invitation_id: inv.id,
          call_session_id: callSessionId,
        });
        activeCallConversationIdRef.current = inv.conversation_id;
        activeCallSessionIdRef.current = callSessionId;
        callLog('active refs set', {
          invitation_id: inv.id,
          call_session_id: callSessionId,
          conversation_id: inv.conversation_id,
        });
        setSurface((prev) => {
          if (!prev.invitation || prev.invitation.id !== inv.id) return prev;
          return { ...prev, invitation: { ...prev.invitation, call_session_id: callSessionId } };
        });
        callLog('requesting operator token', { call_session_id: callSessionId });
        const tok = await callsApi.token(callSessionId);
        if (cancelled) return;
        callLog('callsApi.token success', { call_session_id: callSessionId });
        if (!tok.ws_url) throw new Error('missing_ws_url');
        callLog('live.connect start', {
          invitation_id: inv.id,
          call_session_id: callSessionId,
          channel: inv.channel,
        });
        await live.connect({
          wsUrl: tok.ws_url,
          token: tok.token,
          iceServers: tok.turn?.urls?.length
            ? [{
                urls: tok.turn.urls,
                username: tok.turn.username || undefined,
                credential: tok.turn.credential || undefined,
              }]
            : undefined,
          iceTransportPolicy: tok.ice_policy,
        });
        if (cancelled) return;
        liveConnectPendingRef.current = false;
        hasLiveConnectSucceededRef.current = true;
        connectedInvitationIdRef.current = inv.id;
        callLog('live.connect success', {
          invitation_id: inv.id,
          call_session_id: callSessionId,
        });
        rtDebug('call', 'connected', { invitation_id: inv.id, channel: inv.channel });
        connectedAtRef.current = Date.now();
        setSurface((prev) => prev.phase === 'connecting' ? { ...prev, phase: 'connected' } : prev);
      } catch (err: any) {
        if (cancelled) return;
        liveConnectPendingRef.current = false;
        startedConnectInvitationIdRef.current = null;
        rtDebug('call', 'connect failed', { invitation_id: inv.id, error: err?.message });
        setSurface((prev) => ({
          ...prev,
          phase: 'terminal',
          terminalStatus: 'failed',
          errorMessage: err?.message || String(err),
        }));
      }
    })();
    return () => { cancelled = true; liveConnectPendingRef.current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [surface.phase, surface.invitation?.id, resetPerCallLifecycleRefs]);

  const refreshLatest = useCallback(async (conversationId: string) => {
    try {
      const { invitations } = await callInvitationsApi.listForConversation(conversationId);
      setLatestMap((prev) => ({ ...prev, [conversationId]: invitations[0] ?? null }));
    } catch {
      /* polling will retry */
    }
  }, []);

  const sendInvite = useCallback(async (args: {
    workspaceId: string;
    conversationId: string;
    contactName: string | null;
    channel: InvitationChannel;
    ttlSeconds: number;
  }) => {
    if (creating || surface.phase !== 'idle') return;
    resetPerCallLifecycleRefs();
    lastActiveCallSessionIdRef.current = null;
    lastActiveCallConversationIdRef.current = null;
    lastActiveCallEndedAtRef.current = 0;
    setCreating(args.channel);
    setLoading(true);
    try {
      const { invitation } = await callInvitationsApi.create({
        workspace_id: args.workspaceId,
        conversation_id: args.conversationId,
        channel: args.channel,
        ttl_seconds: args.ttlSeconds,
      });
      setLatestMap((prev) => ({ ...prev, [args.conversationId]: invitation }));
      setSurface({
        phase: 'waiting',
        invitation,
        channel: args.channel,
        terminalStatus: null,
        errorMessage: null,
        conversationId: args.conversationId,
        contactName: args.contactName,
        workspaceId: args.workspaceId,
      });
      toast({
        title: args.channel === 'video' ? 'Video invite sent' : 'Audio invite sent',
        description: 'Visitor can join from the conversation card.',
      });
    } catch (e: any) {
      toast({
        title: 'Could not send invite',
        description: e?.message || String(e),
        variant: 'destructive',
      });
    } finally {
      setCreating(null);
      setLoading(false);
    }
  }, [creating, surface.phase, resetPerCallLifecycleRefs]);

  const cancelInvite = useCallback(async () => {
    const target = surface.invitation;
    if (!target || cancellingRef.current) return;
    cancellingRef.current = true;
    setLoading(true);
    try {
      const { invitation } = await callInvitationsApi.cancel(target.id);
      if (surface.conversationId) {
        setLatestMap((prev) => ({ ...prev, [surface.conversationId!]: invitation }));
      }
      setSurface((prev) => {
        if (!prev.invitation || prev.invitation.id !== target.id) return prev;
        if (prev.phase === 'connected') return prev;
        return {
          ...prev,
          phase: 'terminal',
          invitation: { ...prev.invitation, status: 'cancelled' },
          terminalStatus: 'cancelled',
        };
      });
    } catch (err: any) {
      toast({
        title: 'Could not cancel invitation',
        description: err?.message || String(err),
        variant: 'destructive',
      });
    } finally {
      cancellingRef.current = false;
      setLoading(false);
    }
  }, [surface.invitation, surface.conversationId]);

  const hangup = useCallback(async () => {
    if (autoCloseRef.current) { clearTimeout(autoCloseRef.current); autoCloseRef.current = null; }
    rtDebug('call', 'operator hangup disconnect');
    // Pass A — POST /api/calls/:id/end FIRST so the server publishes
    // call:ended to the visitor before we tear down our local LiveKit
    // room. Best-effort: never block the local disconnect on a server
    // error; server is the source of truth for duration/ended_by.
    const sessionId = activeCallSessionIdRef.current;
    const conversationId = activeCallConversationIdRef.current;
    if (sessionId) {
      try {
        const summary = await callsApi.end(sessionId, 'operator_ended');
        setLastEnded({
          ended_by: summary.ended_by,
          reason: summary.end_reason,
          duration_seconds: summary.duration_seconds,
          ended_at: summary.ended_at,
          conversation_id: conversationId,
        });
      } catch (err) {
        rtDebug('call', 'operator end api failed', { error: (err as any)?.message });
      }
    }
    try { await disconnectLive('explicit_hangup'); } catch { /* ignore */ }
    clearActiveCallRefs();
    setSurface(INITIAL_SURFACE);
    setFloatingMode('docked');
  }, [clearActiveCallRefs, disconnectLive]);

  const clearLastEnded = useCallback(() => setLastEnded(null), []);

  const closeTerminal = useCallback(() => {
    callLog('close terminal only', {
      phase: surfaceRef.current.phase,
      terminalStatus: surfaceRef.current.terminalStatus,
      activeCallSessionId: activeCallSessionIdRef.current,
    });
    if (autoCloseRef.current) { clearTimeout(autoCloseRef.current); autoCloseRef.current = null; }
    clearActiveCallRefs();
    setLastEnded(null);
    setSurface(INITIAL_SURFACE);
    setFloatingMode('docked');
  }, [clearActiveCallRefs]);

  // Auto-fade the "Call ended · mm:ss" surface so it never lingers
  // forever. The toast (below) carries the same info if the operator
  // navigates away in the meantime.
  useEffect(() => {
    if (!lastEnded) return;
    const handle = setTimeout(() => setLastEnded(null), 6000);
    return () => clearTimeout(handle);
  }, [lastEnded]);

  // Toast on every newly-arrived ended summary so the operator gets a
  // consistent confirmation regardless of which side ended the call.
  useEffect(() => {
    if (!lastEnded) return;
    const mm = Math.floor(lastEnded.duration_seconds / 60).toString().padStart(2, '0');
    const ss = (lastEnded.duration_seconds % 60).toString().padStart(2, '0');
    const who =
      lastEnded.ended_by === 'visitor' ? 'Visitor ended the call' :
      lastEnded.ended_by === 'operator' ? 'You ended the call' :
      'Call ended';
    toast({ title: who, description: `${mm}:${ss}` });
  }, [lastEnded]);

  // Pass A — react to server-published call:ended events. When the
  // visitor ends the call (or any other actor) the operator must
  // immediately leave the call surface and surface a duration message
  // without waiting for the LiveKit Disconnected event.
  useEffect(() => {
    return onCallEnded((evt: CallEndedEvent) => {
      const sessionId = activeCallSessionIdRef.current;
      const conversationId = activeCallConversationIdRef.current;
      const eventSessionId = evt.call_session_id || '';
      const cur = surfaceRef.current;
      const surfaceSessionId = cur.invitation?.call_session_id ?? null;

      if (!eventSessionId) {
        callLog('ignored stale call ended', { reason: 'missing_call_session_id', event: evt });
        return;
      }
      callLog('received call:ended', {
        eventCallSessionId: eventSessionId,
        endedBy: evt.ended_by,
        reason: evt.reason,
        durationSeconds: evt.duration_seconds,
      });
      // Pass A.2 — recent-ended fallback. If LiveKit Disconnected fired
      // BEFORE the server's call:ended event arrived, the active refs are
      // already null but we still want to render a terminal toast for the
      // operator with the canonical duration.
      if (!sessionId || !conversationId) {
        const recentId = lastActiveCallSessionIdRef.current;
        const recentConv = lastActiveCallConversationIdRef.current;
        const recentAge = Date.now() - lastActiveCallEndedAtRef.current;
        if (
          recentId &&
          recentId === eventSessionId &&
          recentAge >= 0 &&
          recentAge <= RECENT_ENDED_WINDOW_MS
        ) {
          callLog('handling visitor_ended recent session', {
            eventCallSessionId: eventSessionId,
            recentAgeMs: recentAge,
          });
          setLastEnded({
            ended_by: evt.ended_by,
            reason: evt.reason,
            duration_seconds: evt.duration_seconds,
            ended_at: evt.ended_at,
            conversation_id: evt.conversation_id || recentConv,
          });
          // The remote-vanished effect has already flipped us to terminal
          // 'remote_ended' (or we're already in idle if the auto-close
          // already fired). The toast effect handles surfacing the
          // canonical duration; we only update the surface if we never
          // showed terminal yet.
          if (surfaceRef.current.phase !== 'terminal' && surfaceRef.current.phase !== 'idle') {
            setSurface((prev) => ({
              ...prev,
              phase: 'terminal',
              terminalStatus: 'remote_ended',
            }));
          }
          // Clear the recent ref so the same envelope replayed by polling
          // does not double-fire.
          lastActiveCallSessionIdRef.current = null;
          return;
        }
        callWarn('ignored call:ended without active session', {
          eventCallSessionId: eventSessionId,
          activeCallSessionId: sessionId,
          activeCallConversationId: conversationId,
          recentSessionId: recentId,
          recentAgeMs: recentAge,
          phase: cur.phase,
          invitationId: cur.invitation?.id ?? null,
        });
        return;
      }
      if (sessionId !== eventSessionId) {
        callLog('ignored stale call ended', {
          eventCallSessionId: eventSessionId,
          activeCallSessionId: sessionId,
          phase: cur.phase,
        });
        return;
      }
      if ((cur.phase === 'waiting' || cur.phase === 'connecting') && surfaceSessionId !== eventSessionId) {
        callLog('ignored stale call ended', {
          reason: 'surface_session_mismatch',
          eventCallSessionId: eventSessionId,
          surfaceSessionId,
          phase: cur.phase,
        });
        return;
      }
      if (cur.phase !== 'connecting' && cur.phase !== 'connected') {
        callLog('ignored stale call ended', {
          reason: 'surface_not_active_media_phase',
          eventCallSessionId: eventSessionId,
          phase: cur.phase,
        });
        return;
      }
      callLog('handling visitor_ended active session', {
        eventCallSessionId: eventSessionId,
        endedBy: evt.ended_by,
      });
      callLog('received visitor call:ended event', {
        eventCallSessionId: eventSessionId,
        endedBy: evt.ended_by,
        reason: evt.reason,
        durationSeconds: evt.duration_seconds,
      });
      setLastEnded({
        ended_by: evt.ended_by,
        reason: evt.reason,
        duration_seconds: evt.duration_seconds,
        ended_at: evt.ended_at,
        conversation_id: evt.conversation_id || conversationId,
      });
      // Tear down our local room idempotently — the server already
      // closed the provider room.
      try { void disconnectLive('server_call_ended', conversationId); } catch { /* ignore */ }
      // Show terminal 'remote_ended' state instead of jumping straight
      // to idle. The auto-close effect (3500ms) will return us to idle
      // and the toast already surfaces the duration.
      remoteEndedShownRef.current = true;
      setSurface((prev) => ({
        ...prev,
        phase: 'terminal',
        terminalStatus: 'remote_ended',
      }));
      callLog('visitor ended call terminal shown', {
        eventCallSessionId: eventSessionId,
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const latestForConversation = useCallback(
    (conversationId: string) => latestMap[conversationId] ?? null,
    [latestMap],
  );

  // Pass A.2 — visitor-leave fallback. When LiveKit reports the remote
  // participant gone (or the room transitioned to disconnected) but the
  // server has not yet published a `call:ended` envelope, hit the
  // canonical /api/calls/:id/end endpoint ourselves so the operator UI
  // never hangs at "in call" with no remote stream. The endpoint is
  // idempotent — if call:ended arrives first the second invocation just
  // returns the existing summary.
  useEffect(() => {
    const cur = surfaceRef.current;
    const sessionId = activeCallSessionIdRef.current;
    if (!sessionId) return;
    const remoteCount = live.remote.length;
    const wasPresent = previousRemoteCountRef.current > 0;
    if (remoteCount > 0) {
      markRemoteParticipantSeen('snapshot', { remoteCount });
    }
    previousRemoteCountRef.current = remoteCount;

    if (cur.phase !== 'connected') {
      if (live.state === 'disconnected' || live.state === 'failed' || remoteCount === 0) {
        callLog('visitor-ended fallback ignored: not connected yet', {
          sessionId,
          phase: cur.phase,
          liveState: live.state,
          liveConnectPending: liveConnectPendingRef.current,
          remoteCount,
        });
      }
      return;
    }
    if (!hasLiveConnectSucceededRef.current || liveConnectPendingRef.current) {
      callLog('visitor-ended fallback ignored: not connected yet', {
        sessionId,
        phase: cur.phase,
        liveState: live.state,
        hasLiveConnectSucceeded: hasLiveConnectSucceededRef.current,
        liveConnectPending: liveConnectPendingRef.current,
        remoteCount,
      });
      return;
    }
    if (!hasRemoteParticipantEverConnectedRef.current) {
      if (remoteCount === 0 || live.state === 'disconnected' || live.state === 'failed') {
        callLog('visitor-ended fallback ignored: no remote ever seen', {
          sessionId,
          phase: cur.phase,
          liveState: live.state,
          remoteCount,
        });
      }
      return;
    }

    // Trigger only after a real visitor participant was seen and then vanished.
    const remoteVanished = wasPresent && remoteCount === 0;
    const participantDisconnected = realVisitorDisconnectedRef.current && remoteCount === 0;
    if (!remoteVanished && !participantDisconnected) return;

    if (remoteLeftFallbackRef.current) return; // already armed
    callLog('visitor-ended fallback armed', {
      sessionId,
      remoteCount,
      liveState: live.state,
      phase: cur.phase,
      remoteVanished,
      participantDisconnected,
      remoteParticipantSeenAt: remoteParticipantSeenAtRef.current,
      hasRemoteTrackEverSubscribed: hasRemoteTrackEverSubscribedRef.current,
    });
    const armedSessionId = sessionId;
    const armedConversationId = activeCallConversationIdRef.current;
    // 1) IMMEDIATELY flip to terminal 'remote_ended' so the operator no
    //    longer stares at a black/loading video stage. Show a placeholder
    //    duration computed from local connected_at; we'll update it once
    //    /end (or call:ended) returns the canonical value.
    if (!remoteEndedShownRef.current) {
      remoteEndedShownRef.current = true;
      const localDur = connectedAtRef.current
        ? Math.max(0, Math.round((Date.now() - connectedAtRef.current) / 1000))
        : 0;
      // Distinguish a failed visitor connect from a true visitor hangup.
      // If the remote participant appeared but we never received a single
      // TrackSubscribed event, the visitor's WebRTC/media connection never
      // actually established — regardless of elapsed time. Do not label
      // that as "Visitor ended the call".
      const visitorConnectFailed = !hasRemoteTrackEverSubscribedRef.current;
      const terminalKind: TerminalStatus = visitorConnectFailed ? 'connect_failed_remote' : 'remote_ended';
      callLog('visitor-ended terminal shown', {
        sessionId: armedSessionId,
        localDurationSeconds: localDur,
        visitorConnectFailed,
        hasRemoteTrackEverSubscribed: hasRemoteTrackEverSubscribedRef.current,
      });
      setLastEnded({
        ended_by: 'system',
        reason: visitorConnectFailed ? 'visitor_connect_failed' : 'system_ended',
        duration_seconds: visitorConnectFailed ? 0 : localDur,
        ended_at: new Date().toISOString(),
        conversation_id: armedConversationId,
      });
      setSurface((prev) => ({
        ...prev,
        phase: 'terminal',
        terminalStatus: terminalKind,
      }));
      // Tear down our local LiveKit room now — remote is gone, no
      // reason to keep it spinning. Snapshot active refs into "recent"
      // so a late call:ended can still match.
      try { void disconnectLive('visitor_left', armedConversationId); } catch { /* ignore */ }
    }
    // 2) Arm the server reconciliation in the background. /end is
    //    idempotent — if the server already published call:ended this
    //    just returns the existing summary with the canonical duration.
    callLog('visitor-ended fallback /end armed', {
      sessionId: armedSessionId,
    });
    remoteLeftFallbackRef.current = setTimeout(() => {
      remoteLeftFallbackRef.current = null;
      if (activeCallSessionIdRef.current !== armedSessionId) {
        callLog('ignored stale visitor-left fallback', {
          armedSessionId,
          activeCallSessionId: activeCallSessionIdRef.current,
        });
        return;
      }
      // Always poll /end — even if active refs were already cleared by
      // disconnectLive above, the server still owes us the canonical
      // duration for the terminal toast.
      callsApi
        .end(armedSessionId, 'system_ended')
        .then((summary) => {
          callLog('visitor-ended fallback /end success', {
            sessionId: armedSessionId,
            endedBy: summary.ended_by,
            durationSeconds: summary.duration_seconds,
          });
          setLastEnded({
            ended_by: summary.ended_by,
            reason: summary.end_reason,
            duration_seconds: summary.duration_seconds,
            ended_at: summary.ended_at,
            conversation_id: summary.conversation_id ?? armedConversationId,
          });
        })
        .catch((err) => {
          callWarn('visitor-ended fallback /end failed', {
            error: (err as any)?.message,
          });
        });
    }, 1500);

    return undefined;
  }, [live.remote.length, live.state, surface.phase, disconnectLive, markRemoteParticipantSeen]);

  // Hard cleanup ONLY on full provider unmount (sign-out / shutdown).
  useEffect(() => {
    return () => {
      if (activeCallSessionIdRef.current) {
        try {
          live.disconnect('app_shutdown', {
            activeCallSessionId: activeCallSessionIdRef.current,
            activeCallConversationId: activeCallConversationIdRef.current,
            currentConversationId: null,
          });
        } catch { /* ignore */ }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const value = useMemo<OperatorCallContextValue>(() => ({
    surface,
    creating,
    loading,
    live,
    preview: { stream: preview.stream, state: preview.state },
    floatingMode,
    setFloatingMode,
    latestForConversation,
    sendInvite,
    cancelInvite,
    hangup,
    closeTerminal,
    refreshLatest,
    lastEnded,
    clearLastEnded,
    videoQuality: live.videoQuality,
    setVideoQuality: live.setVideoQuality,
  }), [
    surface, creating, loading, live, preview.stream, preview.state,
    floatingMode, latestForConversation, sendInvite, cancelInvite, hangup, closeTerminal, refreshLatest,
    lastEnded, clearLastEnded,
  ]);

  return (
    <OperatorCallContext.Provider value={value}>
      {children}
    </OperatorCallContext.Provider>
  );
}