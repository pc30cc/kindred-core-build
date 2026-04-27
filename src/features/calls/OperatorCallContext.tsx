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
import { useLocalMediaPreview, type LocalPreviewState } from '@/hooks/useLocalMediaPreview';
import { rtDebug } from '@/realtime/debug';
import { toast } from '@/hooks/use-toast';

export type SurfacePhase = 'idle' | 'waiting' | 'connecting' | 'connected' | 'terminal';
export type TerminalStatus = 'expired' | 'cancelled' | 'declined' | 'failed' | null;

export interface LastEndedSummary {
  ended_by: 'operator' | 'visitor' | 'system';
  reason: 'operator_ended' | 'visitor_ended' | 'system_ended' | 'failed';
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
  /** Force-refresh the latest invitation for a conversation (sidebar polling). */
  refreshLatest(conversationId: string): Promise<void>;
  /** Pass A — last ended summary for "Call ended · mm:ss" UI. */
  lastEnded: LastEndedSummary | null;
  clearLastEnded(): void;
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
  // Latest invitation per conversation — for the sidebar pill. Kept in
  // a ref+state pair so reads are cheap and writes still trigger the
  // sidebar consumers to re-render.
  const [latestMap, setLatestMap] = useState<Record<string, CallInvitation | null>>({});

  const autoCloseRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancellingRef = useRef(false);
  const connectedInvitationIdRef = useRef<string | null>(null);
  const startedConnectInvitationIdRef = useRef<string | null>(null);
  // Active call refs (used for disconnect ctx logging).
  const activeCallSessionIdRef = useRef<string | null>(null);
  const activeCallConversationIdRef = useRef<string | null>(null);

  const live = useLiveKitCall({
    publishMic: true,
    publishCamera: surface.channel === 'video',
  });

  const preview = useLocalMediaPreview({
    enabled: surface.phase === 'waiting',
    wantVideo: surface.channel === 'video',
  });

  const disconnectLive = useCallback((
    reason: Parameters<typeof live.disconnect>[0],
    currentConversationId: string | null = surface.conversationId,
  ) => {
    return live.disconnect(reason, {
      activeCallSessionId: activeCallSessionIdRef.current,
      activeCallConversationId: activeCallConversationIdRef.current,
      currentConversationId,
    });
  }, [live, surface.conversationId]);

  const clearActiveCallRefs = useCallback(() => {
    activeCallConversationIdRef.current = null;
    activeCallSessionIdRef.current = null;
    connectedInvitationIdRef.current = null;
    startedConnectInvitationIdRef.current = null;
  }, []);

  // Auto-close terminal surface after a short delay so it briefly shows
  // the outcome and then reverts to IDLE, exposing the invite buttons.
  const scheduleAutoClose = useCallback((delayMs: number) => {
    if (autoCloseRef.current) clearTimeout(autoCloseRef.current);
    autoCloseRef.current = setTimeout(() => {
      rtDebug('call', 'auto-close terminal disconnect');
      try { void disconnectLive('server_call_ended'); } catch { /* ignore */ }
      clearActiveCallRefs();
      setSurface(INITIAL_SURFACE);
      setFloatingMode('docked');
    }, delayMs);
  }, [clearActiveCallRefs, disconnectLive]);

  useEffect(() => {
    if (surface.phase !== 'terminal') return;
    const delay = surface.terminalStatus === 'cancelled' ? 1800 : 3500;
    scheduleAutoClose(delay);
  }, [surface.phase, surface.terminalStatus, scheduleAutoClose]);

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
    startedConnectInvitationIdRef.current = inv.id;
    let cancelled = false;
    (async () => {
      try {
        const fresh = await callInvitationsApi.get(inv.id)
          .then((r) => r.invitation)
          .catch(() => inv);
        if (cancelled) return;
        const callSessionId = fresh?.call_session_id;
        if (!callSessionId) throw new Error('missing_call_session');
        activeCallConversationIdRef.current = inv.conversation_id;
        activeCallSessionIdRef.current = callSessionId;
        const tok = await callsApi.token(callSessionId);
        if (cancelled) return;
        if (!tok.ws_url) throw new Error('missing_ws_url');
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
        connectedInvitationIdRef.current = inv.id;
        rtDebug('call', 'connected', { invitation_id: inv.id, channel: inv.channel });
        setSurface((prev) => prev.phase === 'connecting' ? { ...prev, phase: 'connected' } : prev);
      } catch (err: any) {
        if (cancelled) return;
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
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [surface.phase, surface.invitation?.id]);

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
  }, [creating, surface.phase]);

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
      // Ignore unrelated calls (e.g. another tab / earlier call).
      if (sessionId && evt.call_session_id && sessionId !== evt.call_session_id) return;
      setLastEnded({
        ended_by: evt.ended_by,
        reason: evt.reason,
        duration_seconds: evt.duration_seconds,
        ended_at: evt.ended_at,
        conversation_id: evt.conversation_id || activeCallConversationIdRef.current,
      });
      // Tear down our local room idempotently — the server already
      // closed the provider room.
      try { void disconnectLive('server_call_ended'); } catch { /* ignore */ }
      clearActiveCallRefs();
      setSurface(INITIAL_SURFACE);
      setFloatingMode('docked');
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const latestForConversation = useCallback(
    (conversationId: string) => latestMap[conversationId] ?? null,
    [latestMap],
  );

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
    refreshLatest,
    lastEnded,
    clearLastEnded,
  }), [
    surface, creating, loading, live, preview.stream, preview.state,
    floatingMode, latestForConversation, sendInvite, cancelInvite, hangup, refreshLatest,
    lastEnded, clearLastEnded,
  ]);

  return (
    <OperatorCallContext.Provider value={value}>
      {children}
    </OperatorCallContext.Provider>
  );
}