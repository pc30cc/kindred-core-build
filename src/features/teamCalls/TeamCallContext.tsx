/**
 * Colleague calls in the web panel (docs/operations/TEAM_CALLS.md, "Web
 * panel"): voice and video calls between two members of a workspace, from
 * the team chat, under the same plan rule and the same API as the phones
 * (server/routes/teamCalls.ts).
 *
 * Mounted ONCE, by the app shell (AppLayout, both frames), so every open
 * panel tab of the callee rings wherever the member is in the panel, and a
 * call stays on screen across navigation. It owns:
 *  - the listener: the member's own realtime channel
 *    `ws:<workspace>:user:<uid>` on the tab's shared realtime connection (no
 *    socket of its own), joined while the workspace's plan has `team_calls`
 *    (no call can ring otherwise), whose `team_call` events are confirmed with
 *    GET /api/team-calls/:id before anything rings or stops; while a call
 *    rings it is also read every 2 s (as the iPhone does), and every 10 s
 *    while it is on, so a lost event never leaves a tab ringing; its
 *    `team_message` events (a message, or the line a call leaves in the
 *    team chat when it ends: TEAM_CALLS.md, "The call in the chat") make the
 *    team chat's list and open thread read again at once, not at their poll;
 *  - the session: placing, ringing, answering, the call, its end;
 *  - the sounds (the ringtone and the caller's ringback, Web Audio, no
 *    files) and the system notification while the tab is hidden;
 *  - this tab's device id (deviceId.ts), sent on accept. The first answer
 *    wins on every surface; a tab whose own answer did not win stops.
 *
 * Its screens (the ringing card, the call window with LiveKit) are a
 * separate file loaded the first time a call rings or is placed, never on
 * page load (TeamCallOverlay.tsx).
 *
 * Ending follows the apps' rule: the caller hangs up (`/hangup`; before the
 * answer the server makes it a cancel); the callee declines while it rings
 * and hangs up once its own answer went through; while that answer is in
 * flight it waits for the verdict and hangs up only if this tab won.
 */
import {
  Component,
  lazy,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { QueryClientContext } from '@tanstack/react-query';
import { resolveClientRealtimeProvider } from '@/realtime';
import { usePlanAccess } from '@/hooks/useEntitlements';
import type { RealtimeSubscription } from '@/realtime';
import { toast } from '@/lib/toast';
import { useTranslation } from '@/i18n';
import {
  teamCallsApi,
  TeamCallApiError,
  type TeamCall,
  type TeamCallChannel,
  type TeamCallPeer,
} from '@/lib/team-calls-api';
// The colleague call's own ringback switch: a visitor call's surface never
// stops it, and this call never stops the visitor's (callSound.ts).
import { startRingtone, startTeamRingback, stopRingtone, stopTeamRingback } from '@/features/calls/callSound';
import { teamCallDeviceId } from './deviceId';
import {
  peerDisplayName,
  TeamCallContext,
  type TeamCallContextValue,
  type TeamCallSession,
} from './teamCallState';
import { teamCallErrorKey } from './teamCallErrors';
import { askNotificationPermissionOnce, watchRingNotification } from './teamCallNotify';

/** How often a ringing call is read again, and a call that is on. */
export const TEAM_CALL_RING_POLL_MS = 2_000;
export const TEAM_CALL_LIVE_POLL_MS = 10_000;
/** A ring's confirming read that failed is tried again this many times, this far apart. */
const TEAM_CALL_CONFIRM_RETRIES = 2;
const TEAM_CALL_CONFIRM_RETRY_MS = 1_500;
/** How long the "call ended" line stays before the window closes. */
const ENDED_LINGER_MS = 2_500;

export type { TeamCallContextValue, TeamCallPhase, TeamCallSession } from './teamCallState';

// The call screens, downloaded the first time a call rings or is placed.
// A failed download is tried again once; React.lazy remembers a rejection,
// so the boundary below makes a fresh one for the next call.
const loadOverlay = () =>
  import('./TeamCallOverlay').catch(
    () => new Promise<typeof import('./TeamCallOverlay')>((resolve, reject) => {
      setTimeout(() => { import('./TeamCallOverlay').then(resolve, reject); }, 800);
    }),
  );
let LazyOverlay = lazy(loadOverlay);

class OverlayBoundary extends Component<{ children: ReactNode; onFail: () => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    LazyOverlay = lazy(loadOverlay);
    this.props.onFail();
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

let sessionCounter = 0;
const nextKey = () => `tc-${Date.now().toString(36)}-${(sessionCounter += 1)}`;

interface TeamCallEvent {
  kind?: unknown;
  workspace_id?: unknown;
  call_id?: unknown;
  state?: unknown;
}

export function TeamCallProvider({
  workspaceId,
  userId,
  children,
}: {
  workspaceId: string | null | undefined;
  userId: string | null | undefined;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  // Read without useQueryClient: a shell without a query client still rings.
  const queryClient = useContext(QueryClientContext);
  // Nothing can ring a member of a workspace whose plan has no colleague
  // calls, so its tabs do not listen (a call already on is followed by its
  // own reads, whatever the plan says now).
  const listen = usePlanAccess(workspaceId).feature('team_calls');
  const [session, setSessionState] = useState<TeamCallSession | null>(null);
  const sessionRef = useRef<TeamCallSession | null>(null);
  /** Calls this tab has finished with (declined, hung up, another tab's own call): their events change nothing. */
  const doneRef = useRef<Set<string>>(new Set());
  /** Missed calls already told, so two events never make two toasts. */
  const toldRef = useRef<Set<string>>(new Set());
  /** A hang-up asked for while this tab's answer was in flight. */
  const hangUpAfterAnswerRef = useRef(false);
  const tRef = useRef(t);
  tRef.current = t;

  const setSession = useCallback((next: TeamCallSession | null) => {
    sessionRef.current = next;
    setSessionState(next);
  }, []);

  /** Changes the session only while it is still the one [key] names. */
  const patch = useCallback((key: string, change: Partial<TeamCallSession>) => {
    const current = sessionRef.current;
    if (!current || current.key !== key) return;
    setSession({ ...current, ...change });
  }, [setSession]);

  const silence = useCallback((reason: string) => {
    stopRingtone(reason);
    stopTeamRingback(reason);
  }, []);

  const fallbackName = useCallback(() => tRef.current('teamCall.colleague'), []);

  const tellMissed = useCallback((call: TeamCall, peer?: TeamCallPeer) => {
    if (toldRef.current.has(call.id)) return;
    toldRef.current.add(call.id);
    const name = peerDisplayName(peer ?? call.peer, fallbackName());
    toast.info(tRef.current(call.channel === 'video' ? 'teamCall.missedVideo' : 'teamCall.missedVoice'), {
      description: tRef.current('teamCall.missedFrom', { name }),
    });
  }, [fallbackName]);

  /** Ends the session's call on screen (the window says why), or closes it at once. */
  const finish = useCallback((s: TeamCallSession, call: TeamCall | null, notice: TeamCallSession['notice']) => {
    silence('finished');
    if (call) doneRef.current.add(call.id);
    if (!notice) {
      setSession(null);
      return;
    }
    setSession({ ...s, call: call ?? s.call, phase: 'ended', notice });
  }, [silence, setSession]);

  /**
   * The server's word on the session's call: follow it. A ringing tab stops
   * when the call moved past ringing and its own answer is not the one that
   * moved it; the caller's side joins once it is answered.
   */
  const apply = useCallback((call: TeamCall) => {
    const s = sessionRef.current;
    if (!s || !s.call || s.call.id !== call.id || s.phase === 'ended') return;
    const peer = call.peer?.name || call.peer?.avatar_url ? call.peer : s.peer;
    if (call.state === 'ringing') {
      setSession({ ...s, call, peer });
      return;
    }
    if (call.state === 'connecting' || call.state === 'active') {
      if (s.role === 'caller') {
        if (s.phase === 'outgoing') {
          stopTeamRingback('answered');
          setSession({ ...s, call, peer, phase: 'connecting' });
        } else {
          setSession({ ...s, call, peer });
        }
        return;
      }
      // The callee: an answer this tab did not give was given elsewhere.
      if (s.phase === 'incoming') {
        finish(s, call, null);
        return;
      }
      // While this tab's own answer is in flight, its verdict decides.
      if (s.phase === 'answering') return;
      setSession({ ...s, call, peer });
      return;
    }
    // Over.
    if (s.phase === 'answering') return; // the accept's answer says what happened
    const name = peerDisplayName(peer, fallbackName());
    if (s.role === 'callee') {
      if (s.phase === 'incoming') {
        if (call.outcome === 'missed' || call.outcome === 'cancelled') tellMissed(call, peer);
        finish(s, call, null);
        return;
      }
      finish(s, call, { key: 'teamCall.ended' });
      return;
    }
    // The caller.
    if (s.phase === 'outgoing' || s.phase === 'placing') {
      if (call.outcome === 'declined') finish(s, call, { key: 'teamCall.declined', params: { name } });
      else if (call.outcome === 'missed') finish(s, call, { key: 'teamCall.noAnswer' });
      else if (call.outcome === 'failed') finish(s, call, { key: 'teamCall.errors.connectFailed' });
      else finish(s, call, null);
      return;
    }
    finish(s, call, { key: call.outcome === 'failed' ? 'teamCall.errors.connectFailed' : 'teamCall.ended' });
  }, [finish, setSession, fallbackName, tellMissed]);

  const refresh = useCallback(async (callId: string) => {
    try {
      apply(await teamCallsApi.get(callId));
    } catch (err) {
      // 404: the call is not this member's (or gone). Anything else: the
      // next read tries again.
      if (err instanceof TeamCallApiError && err.status === 404) {
        const s = sessionRef.current;
        if (s?.call?.id === callId && s.phase !== 'ended') finish(s, s.call, null);
      }
    }
  }, [apply, finish]);

  /** A ring announced on the member's channel: confirmed before anything rings. */
  const consider = useCallback(async (callId: string, state: string) => {
    // The event comes once: a read that fails (a blip, a deploy's 503) is
    // tried again a little later, or this tab would never ring for it. A
    // 404 is final: not this member's call.
    let call: TeamCall | null = null;
    for (let attempt = 0; !call; attempt += 1) {
      const busy = sessionRef.current && sessionRef.current.phase !== 'ended';
      if (busy || doneRef.current.has(callId)) return;
      try {
        call = await teamCallsApi.get(callId);
      } catch (err) {
        const final = err instanceof TeamCallApiError && err.status === 404;
        if (final || attempt >= TEAM_CALL_CONFIRM_RETRIES) return;
        await new Promise((resolve) => setTimeout(resolve, TEAM_CALL_CONFIRM_RETRY_MS));
      }
    }
    if (call.role !== 'callee') {
      // The member's own call, placed in another tab or on a phone: not rung here.
      doneRef.current.add(call.id);
      return;
    }
    if (call.state === 'ringing') {
      // The server's word on whether it still rings (a read past its end
      // marks it missed), never this computer's clock.
      const current = sessionRef.current;
      if (current && current.phase !== 'ended') return;
      setSession({
        key: nextKey(),
        call,
        role: 'callee',
        channel: call.channel,
        peer: call.peer,
        workspaceId: call.workspace_id,
        phase: 'incoming',
        withCamera: call.channel === 'video',
        notice: null,
      });
      return;
    }
    // A ring that ended before this tab saw it ringing: still a missed call.
    if (state !== 'ringing' && (call.outcome === 'missed' || call.outcome === 'cancelled')) {
      doneRef.current.add(call.id);
      tellMissed(call);
    }
  }, [setSession, tellMissed]);

  const onEvent = useCallback((payload: TeamCallEvent) => {
    if (payload?.kind === 'team_message') {
      // The team chat changed for this member (a call's line included): its
      // list and threads (useTeamChat.ts) read again now.
      if (!workspaceId || payload.workspace_id !== workspaceId || !queryClient) return;
      void queryClient.invalidateQueries({ queryKey: ['team-chat', 'colleagues', workspaceId] });
      void queryClient.invalidateQueries({ queryKey: ['team-chat', 'thread', workspaceId] });
      return;
    }
    if (!payload || payload.kind !== 'team_call') return;
    const callId = typeof payload.call_id === 'string' ? payload.call_id : '';
    const state = typeof payload.state === 'string' ? payload.state : '';
    if (!callId) return;
    if (workspaceId && typeof payload.workspace_id === 'string' && payload.workspace_id !== workspaceId) return;
    const s = sessionRef.current;
    if (s?.call?.id === callId) {
      if (s.phase !== 'ended') void refresh(callId);
      return;
    }
    if (doneRef.current.has(callId)) return;
    if (state === 'ringing' || state === 'missed' || state === 'cancelled') void consider(callId, state);
  }, [workspaceId, refresh, consider, queryClient]);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  // ─── The listener: the member's own channel, on the shared connection ───
  useEffect(() => {
    if (!workspaceId || !userId || !listen) return;
    let disposed = false;
    let sub: RealtimeSubscription | null = null;
    let joining = false;
    let attempt = 0;
    let retry: ReturnType<typeof setTimeout> | null = null;
    const channel = `ws:${workspaceId}:user:${userId}`;

    const scheduleRetry = () => {
      if (disposed || retry) return;
      const delay = Math.min(30_000, 2_000 * 2 ** Math.min(attempt, 4));
      attempt += 1;
      retry = setTimeout(() => { retry = null; void join(); }, delay);
    };
    const join = async () => {
      if (disposed || sub || joining) return;
      joining = true;
      try {
        const provider = await resolveClientRealtimeProvider(workspaceId);
        if (disposed) return;
        // Polling / disabled: nothing to listen to; a call this member places
        // is still followed by its own reads.
        if (provider.vendor === 'polling' || provider.vendor === 'disabled') return;
        // A subscribe that fails on its way (no token yet, the socket not
        // open) still answers with a handle, after it said so: that handle
        // never hears a ring and, once kept, nothing joins again (join()
        // sees a handle). It is dropped and the join tried again instead.
        let answered = false;
        let failedOnTheWay = false;
        const s = await provider.subscribe(channel, {
          onEvent: (payload) => onEventRef.current(payload as unknown as TeamCallEvent),
          onStatus: (status) => {
            if (disposed) return;
            if (status === 'open') { attempt = 0; failedOnTheWay = false; return; }
            if (status === 'error' || status === 'closed') {
              if (!answered) { failedOnTheWay = true; return; }
              // As the presence channel does: drop the handle and join again.
              const old = sub;
              sub = null;
              try { old?.unsubscribe(); } catch { /* ignore */ }
              scheduleRetry();
            }
          },
        });
        answered = true;
        if (disposed) { s.unsubscribe(); return; }
        if (failedOnTheWay) {
          try { s.unsubscribe(); } catch { /* ignore */ }
          scheduleRetry();
          return;
        }
        sub = s;
      } catch {
        scheduleRetry();
      } finally {
        joining = false;
      }
    };
    void join();
    return () => {
      disposed = true;
      if (retry) clearTimeout(retry);
      try { sub?.unsubscribe(); } catch { /* ignore */ }
      sub = null;
    };
  }, [workspaceId, userId, listen]);

  // ─── Reads while a call rings or is on ───
  const phase = session?.phase;
  const callId = session?.call?.id ?? null;
  useEffect(() => {
    if (!callId) return;
    const ringing = phase === 'incoming' || phase === 'outgoing';
    const live = phase === 'connecting' || phase === 'active';
    if (!ringing && !live) return;
    const id = setInterval(() => { void refresh(callId); }, ringing ? TEAM_CALL_RING_POLL_MS : TEAM_CALL_LIVE_POLL_MS);
    return () => clearInterval(id);
  }, [callId, phase, refresh]);

  // ─── A ring never outlasts its end, whatever the network does ───
  // The reads above stop it when the server says so. When none gets
  // through, this tab stops on its own a little after the ring's length
  // (the server's own two times, so this computer's clock does not matter).
  const ringMs = session?.call
    ? Date.parse(session.call.expires_at) - Date.parse(session.call.created_at)
    : NaN;
  useEffect(() => {
    if (!callId || (phase !== 'incoming' && phase !== 'outgoing')) return;
    const length = Number.isFinite(ringMs) ? Math.min(Math.max(ringMs, 10_000), 90_000) : 45_000;
    const stop = setTimeout(() => {
      const s = sessionRef.current;
      if (!s || s.call?.id !== callId || (s.phase !== 'incoming' && s.phase !== 'outgoing')) return;
      if (s.role === 'callee') {
        if (s.call) tellMissed(s.call, s.peer);
        finish(s, s.call, null);
      } else {
        void teamCallsApi.hangup(callId).catch(() => { /* the ticker marks it missed */ });
        finish(s, s.call, { key: 'teamCall.noAnswer' });
      }
    }, length + 6_000);
    return () => clearTimeout(stop);
    // ringMs is fixed for a call; the timer starts when it starts ringing here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [callId, phase, finish, tellMissed]);

  // ─── The ringtone and the system notification of a ring here ───
  const ringingHere = phase === 'incoming';
  const ringPeerName = session?.peer?.name ?? null;
  const ringPeerAvatar = session?.peer?.avatar_url ?? null;
  const ringChannel = session?.channel ?? 'audio';
  useEffect(() => {
    if (!ringingHere || !callId) return;
    startRingtone();
    const stopNotice = watchRingNotification({
      title: ringPeerName?.trim() || tRef.current('teamCall.colleague'),
      body: tRef.current(ringChannel === 'video' ? 'teamCall.incomingVideo' : 'teamCall.incomingVoice'),
      tag: `team-call-${callId}`,
      icon: ringPeerAvatar,
    });
    return () => {
      stopRingtone('ring_over');
      stopNotice();
    };
  }, [ringingHere, callId, ringPeerName, ringPeerAvatar, ringChannel]);

  // ─── An ended window closes on its own ───
  const sessionKey = session?.key ?? null;
  useEffect(() => {
    if (phase !== 'ended' || !sessionKey) return;
    const id = setTimeout(() => {
      if (sessionRef.current?.key === sessionKey) setSession(null);
    }, ENDED_LINGER_MS);
    return () => clearTimeout(id);
  }, [phase, sessionKey, setSession]);

  // ─── Leaving the page ends this tab's call (the webhook would, later) ───
  useEffect(() => {
    if (!callId) return;
    const mine = phase === 'outgoing' || phase === 'connecting' || phase === 'active';
    if (!mine) return;
    const onExit = () => teamCallsApi.hangupOnExit(callId);
    window.addEventListener('pagehide', onExit);
    return () => window.removeEventListener('pagehide', onExit);
  }, [callId, phase]);

  // Signing out or leaving the workspace: nothing keeps ringing.
  useEffect(() => () => {
    stopRingtone('unmount');
    stopTeamRingback('unmount');
  }, []);

  // ─── Actions ───
  const placeCall = useCallback(async (input: { workspaceId: string; peer: TeamCallPeer; channel: TeamCallChannel }) => {
    const current = sessionRef.current;
    if (current && current.phase !== 'ended') return;
    askNotificationPermissionOnce();
    const key = nextKey();
    setSession({
      key,
      call: null,
      role: 'caller',
      channel: input.channel,
      peer: input.peer,
      workspaceId: input.workspaceId,
      phase: 'placing',
      withCamera: input.channel === 'video',
      notice: null,
    });
    // In the click's own turn, so the browser lets the page play it.
    startTeamRingback();
    try {
      const call = await teamCallsApi.place({
        workspace_id: input.workspaceId,
        callee_id: input.peer.user_id,
        channel: input.channel,
      });
      const s = sessionRef.current;
      if (!s || s.key !== key) {
        // Hung up while it was being placed.
        doneRef.current.add(call.id);
        void teamCallsApi.hangup(call.id).catch(() => { /* the ring times out */ });
        return;
      }
      const peer = call.peer?.name || call.peer?.avatar_url ? call.peer : input.peer;
      setSession({ ...s, call, peer, phase: 'outgoing' });
      if (call.state !== 'ringing') apply(call);
    } catch (err) {
      stopTeamRingback('place_failed');
      const s = sessionRef.current;
      if (s && s.key === key) setSession(null);
      const name = peerDisplayName(input.peer, fallbackName());
      toast.error(tRef.current(teamCallErrorKey(err), { name }));
    }
  }, [apply, setSession, fallbackName]);

  const answer = useCallback(async (withCamera: boolean) => {
    const s = sessionRef.current;
    if (!s || s.phase !== 'incoming' || !s.call) return;
    const callId = s.call.id;
    const deviceId = teamCallDeviceId();
    hangUpAfterAnswerRef.current = false;
    stopRingtone('answering');
    setSession({ ...s, phase: 'answering', withCamera: s.channel === 'video' && withCamera });
    let call: TeamCall | null = null;
    let lost = false;
    try {
      call = await teamCallsApi.accept(callId, deviceId);
    } catch (err) {
      if (err instanceof TeamCallApiError && err.code === 'not_ringing') {
        const now = err.call;
        if (now && (now.state === 'connecting' || now.state === 'active') && now.answered_device_id === deviceId) {
          call = now; // a retried answer of this tab's own
        } else {
          lost = true;
          call = now;
        }
      } else {
        // The answer may have gone through even though its reply did not
        // arrive (a network drop): the call says whether this tab won.
        let now: TeamCall | null = null;
        try { now = await teamCallsApi.get(callId); } catch { now = null; }
        if (now && (now.state === 'connecting' || now.state === 'active') && now.answered_device_id === deviceId) {
          call = now;
        } else {
          const current = sessionRef.current;
          if (current?.key === s.key) {
            doneRef.current.add(callId);
            setSession(null);
            toast.error(tRef.current(teamCallErrorKey(err), { name: peerDisplayName(s.peer, fallbackName()) }));
          }
          return;
        }
      }
    }
    const current = sessionRef.current;
    if (!current || current.key !== s.key) return;
    if (!lost && call && call.answered_device_id && call.answered_device_id !== deviceId) lost = true;
    if (lost || !call) {
      // Answered on another tab or phone, declined there, or over.
      if (call && (call.outcome === 'missed' || call.outcome === 'cancelled')) tellMissed(call, s.peer);
      finish(current, call, null);
      return;
    }
    if (hangUpAfterAnswerRef.current) {
      // The member hung up while the answer was in flight, and this tab won.
      hangUpAfterAnswerRef.current = false;
      finish(current, call, null);
      void teamCallsApi.hangup(callId).catch(() => { /* the room check ends it */ });
      return;
    }
    setSession({ ...current, call, phase: 'connecting' });
  }, [setSession, finish, fallbackName, tellMissed]);

  const decline = useCallback(async () => {
    const s = sessionRef.current;
    if (!s || s.phase !== 'incoming' || !s.call) return;
    const id = s.call.id;
    finish(s, s.call, null);
    try {
      await teamCallsApi.decline(id);
    } catch { /* idempotent; the ring times out otherwise */ }
  }, [finish]);

  const hangUp = useCallback(async () => {
    const s = sessionRef.current;
    if (!s) return;
    if (s.phase === 'ended') { setSession(null); return; }
    if (s.phase === 'incoming') { await decline(); return; }
    if (s.phase === 'answering') {
      // Wait for the verdict: hang up only if this tab's answer won.
      hangUpAfterAnswerRef.current = true;
      return;
    }
    if (s.phase === 'placing' || !s.call) {
      // The placement's answer hangs the call up (placeCall).
      silence('cancelled');
      setSession(null);
      return;
    }
    const id = s.call.id;
    const talking = s.phase === 'connecting' || s.phase === 'active';
    finish(s, s.call, talking ? { key: 'teamCall.ended' } : null);
    try {
      await teamCallsApi.hangup(id);
    } catch { /* idempotent; the webhook or the room check ends it */ }
  }, [decline, finish, setSession, silence]);

  const markJoined = useCallback(() => {
    const s = sessionRef.current;
    if (s && s.phase === 'connecting') patch(s.key, { phase: 'active' });
  }, [patch]);

  const failJoin = useCallback(async (err: unknown) => {
    const s = sessionRef.current;
    if (!s || !s.call || (s.phase !== 'connecting' && s.phase !== 'active')) return;
    const id = s.call.id;
    const key = teamCallErrorKey(err);
    finish(s, s.call, { key: key === 'teamCall.errors.generic' ? 'teamCall.errors.connectFailed' : key });
    try {
      await teamCallsApi.hangup(id);
    } catch { /* the room check ends it */ }
  }, [finish]);

  const dismiss = useCallback(() => {
    const s = sessionRef.current;
    if (s?.phase === 'ended') setSession(null);
  }, [setSession]);

  const onOverlayFail = useCallback(() => {
    // The call screens could not be downloaded: do not leave a ring nobody
    // can answer here (the member's other tabs and phones go on ringing).
    const s = sessionRef.current;
    if (!s) return;
    if (s.phase === 'incoming') {
      finish(s, s.call, null);
    } else if (s.phase !== 'ended') {
      void hangUp();
    }
    toast.error(tRef.current('teamCall.errors.connectFailed'));
  }, [finish, hangUp]);

  const value = useMemo<TeamCallContextValue>(() => ({
    session,
    placeCall,
    answer,
    decline,
    hangUp,
    markJoined,
    failJoin,
    dismiss,
  }), [session, placeCall, answer, decline, hangUp, markJoined, failJoin, dismiss]);

  return (
    <TeamCallContext.Provider value={value}>
      {children}
      {session && (
        <OverlayBoundary key={session.key} onFail={onOverlayFail}>
          <Suspense fallback={null}>
            <LazyOverlay />
          </Suspense>
        </OverlayBoundary>
      )}
    </TeamCallContext.Provider>
  );
}
