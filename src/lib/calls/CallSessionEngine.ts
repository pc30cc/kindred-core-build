/**
 * Phase — Inbox Call Hardening · Pass 1 + Unification Pass A
 *
 * CallSessionEngine — single deterministic owner of an operator-side call
 * lifecycle. UI surfaces (Inbox today, Call Center tomorrow) subscribe to
 * its state; they NEVER mutate it directly.
 *
 * Design rules:
 *  - One engine instance owns ONE call attempt at a time.
 *  - All transitions go through `transition()` so they are loggable and
 *    serial. Out-of-order signals (e.g. a late media-failure after we
 *    already ended) are dropped silently.
 *  - Every terminal path (`ended`, `failed`, `declined`, `missed`,
 *    `expired`) MUST call `releaseBusy()` exactly once. This is the
 *    contract that guarantees the operator does not stay locked.
 *  - Transport (LiveKit) is injected, not imported, so the engine can be
 *    unit-tested and reused by the future Call Center surface.
 *
 * Unification Pass A adds first-class incoming-call ownership:
 *   - receiveIncoming(offer)  → moves engine into `incoming_ringing`
 *   - acceptIncoming()        → fetches token + connects transport
 *   - declineIncoming(reason) → notifies queue + clears state
 *   - cancelIncoming(reason)  → external (remote/queue) cancellation
 *   - expireIncoming()        → offer timeout
 * The signal source (queue poll today, realtime tomorrow) is now an
 * adapter that calls these commands. Surfaces no longer own lifecycle.
 */
import { callsApi, type CallType, type CreateCallInput } from '@/lib/calls-api';
import { callQueueApi } from '@/lib/call-queue-api';

export type CallPhase =
  | 'idle'
  | 'preparing'        // server create() in flight
  | 'outgoing_ringing' // invite sent, waiting for remote join / accept
  | 'incoming_ringing' // future Pass 3 — included now so machine is stable
  | 'connecting'       // we have a token, joining the room
  | 'connected'        // media is flowing
  | 'reconnecting'
  | 'ending'
  | 'ended'
  | 'failed'
  | 'declined'
  | 'missed'
  | 'expired';

const TERMINAL: ReadonlySet<CallPhase> = new Set([
  'ended',
  'failed',
  'declined',
  'missed',
  'expired',
]);

export interface CallSessionState {
  phase: CallPhase;
  callId: string | null;
  callType: CallType;
  /** Last failure reason (only set when phase enters a terminal failure). */
  errorMessage: string | null;
  /** Stable code so UI can localize: 'media_denied' | 'token_failed' | 'connect_failed' | 'no_answer' | 'remote_declined' | 'remote_hangup' | 'cancelled' | 'unknown'. */
  errorCode: string | null;
  /** True while the engine considers the operator "busy" (owns the lock). */
  busy: boolean;
  startedAt: number | null;
  /** Direction of the active attempt — 'outgoing' | 'incoming' | null. */
  direction: 'outgoing' | 'incoming' | null;
  /** Active incoming offer (queue entry) — only populated for incoming. */
  incomingOffer: IncomingOffer | null;
  /** Conversation context if known — used by the UI to focus the right thread. */
  conversationId: string | null;
}

export type Listener = (s: CallSessionState) => void;

const INITIAL: CallSessionState = {
  phase: 'idle',
  callId: null,
  callType: 'audio',
  errorMessage: null,
  errorCode: null,
  busy: false,
  startedAt: null,
  direction: null,
  incomingOffer: null,
  conversationId: null,
};

/** Default no-answer window for outgoing calls (ms). */
const DEFAULT_RING_TIMEOUT_MS = 35_000;

/** Soft fallback so a stuck `ending` cannot trap the UI. */
const ENDING_TIMEOUT_MS = 6_000;

/**
 * Hard watchdog for the pre-connected join window. The LiveKit SDK
 * internally retries (region fallback, v1→v0 path fallback, websocket
 * reconnect) and may sit in those retries long enough to trap the engine
 * in `connecting`. This watchdog forces a terminal failure if we do not
 * reach `connected` within the budget.
 *
 * Applies to both outgoing (after token success) and incoming
 * (acceptIncoming) flows. Cleared on every transition out of
 * preparing/connecting/outgoing_ringing.
 */
const CONNECT_WATCHDOG_MS = 20_000;

/**
 * Compact description of an incoming offer, derived from the existing
 * call_queue_entries row. Surfaces consume this — they MUST NOT poll the
 * queue independently.
 */
export interface IncomingOffer {
  /** Queue entry id — used by accept/decline/cancel queue calls. */
  offerId: string;
  workspaceId: string;
  callType: CallType;             // mapped from queue.channel
  conversationId: string | null;
  callSessionId: string | null;   // server-side call id, if already linked
  visitorName: string | null;
  country: string | null;
  /** ISO timestamp when the offer expires (queue offer timeout). */
  expiresAt: string | null;
}

export interface AcceptIncomingInput {
  /** Operator display name shown to the visitor. */
  displayName?: string;
}

export interface MediaTransport {
  /** Join the room. Throws on any unrecoverable error. */
  connect(input: {
    wsUrl: string;
    token: string;
    iceServers?: RTCIceServer[];
    iceTransportPolicy?: 'all' | 'relay';
    /** Whether to publish camera at join. */
    publishCamera: boolean;
  }): Promise<void>;
  disconnect(): Promise<void>;
}

export interface StartOutgoingInput {
  workspaceId: string;
  conversationId: string | null;
  callType: CallType;
  /** Display name handed to the token endpoint. */
  displayName?: string;
}

export interface EngineOptions {
  transport: MediaTransport;
  /** Override the no-answer timeout. */
  ringTimeoutMs?: number;
  /** Optional debug logger. */
  log?: (msg: string, extra?: unknown) => void;
}

function classifyError(e: unknown): { code: string; message: string } {
  const err = e as { message?: string; code?: string; reason?: number; reasonName?: string; name?: string } | undefined;
  const msg = err?.message || String(e);
  const lower = msg.toLowerCase();
  // Caller-provided codes (e.g. config_missing throws) win.
  if (err?.code && typeof err.code === 'string') {
    return { code: err.code, message: msg };
  }
  // LiveKit SDK ConnectionError — most reliable signal we have.
  // reasonName is set by livekit-client/ConnectionError.
  const reasonName = err?.reasonName;
  if (reasonName === 'ServiceNotFound' || /v1 rtc path not found|service.*not.*found/i.test(msg)) {
    return { code: 'rtc_path_not_found', message: 'Call server is incompatible with the current client.' };
  }
  if (reasonName === 'ServerUnreachable' || /websocket|ws_error|1006|connection refused|server unreachable|networkerror/i.test(msg)) {
    return { code: 'ws_connection_refused', message: 'Could not reach the call server.' };
  }
  if (reasonName === 'Timeout' || lower.includes('timeout') || lower.includes('timed out')) {
    return { code: 'connect_timeout', message: 'Call connection timed out.' };
  }
  if (reasonName === 'NotAllowed' || lower.includes('permission') || lower.includes('notallowed')) {
    return { code: 'media_denied', message: msg };
  }
  if (reasonName === 'Cancelled' || lower.includes('cancelled') || lower.includes('canceled')) {
    return { code: 'cancelled', message: msg };
  }
  if (lower.includes('closed peer connection') || lower.includes('createoffer')) {
    return { code: 'peer_connection_closed', message: 'Could not establish media connection.' };
  }
  if (lower.includes('token')) return { code: 'token_failed', message: msg };
  if (lower.includes('ws_url') || lower.includes('rtc url') || lower.includes('config')) {
    return { code: 'config_missing', message: msg };
  }
  if (lower.includes('connect')) return { code: 'connect_failed', message: msg };
  return { code: 'unknown', message: msg };
}

export class CallSessionEngine {
  private state: CallSessionState = { ...INITIAL };
  private listeners = new Set<Listener>();
  private opts: Required<Pick<EngineOptions, 'ringTimeoutMs'>> & EngineOptions;
  private ringTimer: ReturnType<typeof setTimeout> | null = null;
  private endingTimer: ReturnType<typeof setTimeout> | null = null;
  private incomingTimer: ReturnType<typeof setTimeout> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Generation counter — every new call attempt bumps this. Async callbacks
   * compare against the captured value and bail if the engine has moved on.
   * This is what prevents stale token / connect resolutions from clobbering
   * a fresh state.
   */
  private gen = 0;
  /** Set true while we are actively cleaning up to avoid re-entrant cleanups. */
  private releasing = false;

  constructor(opts: EngineOptions) {
    this.opts = { ringTimeoutMs: DEFAULT_RING_TIMEOUT_MS, ...opts };
  }

  /** Subscribe. Returns unsubscribe. */
  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.state);
    return () => { this.listeners.delete(fn); };
  }

  getState(): CallSessionState { return this.state; }

  // ─── Public commands ────────────────────────────────────────────────────

  async startOutgoing(input: StartOutgoingInput): Promise<void> {
    if (this.state.phase !== 'idle') {
      this.log('startOutgoing ignored — engine not idle', this.state.phase);
      return;
    }
    const myGen = ++this.gen;
    this.transition({
      phase: 'preparing',
      callType: input.callType,
      busy: true,
      errorMessage: null,
      errorCode: null,
      direction: 'outgoing',
      conversationId: input.conversationId,
      incomingOffer: null,
    });

    let createdId: string | null = null;
    try {
      const payload: CreateCallInput = {
        workspace_id: input.workspaceId,
        call_type: input.callType,
        context_type: 'conversation',
        context_id: input.conversationId,
      };
      const created = await callsApi.create(payload);
      if (this.gen !== myGen) return; // cancelled mid-flight
      createdId = created.id;
      this.transition({ callId: created.id });

      await callsApi.invite(created.id, { participant_type: 'visitor' });
      if (this.gen !== myGen) return;

      this.transition({ phase: 'outgoing_ringing' });
      this.armRingTimeout(myGen);

      const tok = await callsApi.token(created.id, {
        display_name: input.displayName || 'Operator',
        ttl_seconds: 600,
      });
      if (this.gen !== myGen) return;
      if (!tok.ws_url) {
        throw Object.assign(
          new Error('RTC ws_url missing — configure the call provider in admin'),
          { code: 'config_missing' },
        );
      }

      const iceServers: RTCIceServer[] = [];
      if (tok.turn?.urls?.length) {
        iceServers.push({
          urls: tok.turn.urls,
          username: tok.turn.username || undefined,
          credential: tok.turn.credential || undefined,
        });
      }

      this.transition({ phase: 'connecting' });
      this.armConnectWatchdog(myGen);
      await this.opts.transport.connect({
        wsUrl: tok.ws_url,
        token: tok.token,
        iceServers: iceServers.length ? iceServers : undefined,
        iceTransportPolicy: tok.ice_policy,
        publishCamera: input.callType === 'video',
      });
      if (this.gen !== myGen) {
        // We were cancelled while joining; tear the freshly-joined room down.
        try { await this.opts.transport.disconnect(); } catch { /* ignore */ }
        return;
      }

      // Server-side: tell the API we accepted on our side. Non-fatal.
      try { await callsApi.accept(created.id); } catch { /* ignore */ }

      this.clearRingTimeout();
      this.clearConnectWatchdog();
      this.transition({ phase: 'connected', startedAt: Date.now() });
    } catch (err) {
      if (this.gen !== myGen) return; // a newer attempt already took over
      const { code, message } = classifyError(err);
      this.log('startOutgoing failed', { code, message });
      // Best-effort server hangup so the visitor side doesn't keep ringing.
      if (createdId) {
        try { await callsApi.hangup(createdId); } catch { /* ignore */ }
      }
      await this.failTo('failed', code, message, myGen);
    }
  }

  /** Operator-initiated end. Safe at any phase. */
  async hangup(): Promise<void> {
    const id = this.state.callId;
    const myGen = this.gen;
    if (TERMINAL.has(this.state.phase) || this.state.phase === 'idle') {
      // Already done — make sure busy is cleared and transport is gone.
      this.clearRingTimeout();
      this.clearEndingTimeout();
      this.clearIncomingTimeout();
      this.clearConnectWatchdog();
      try { await this.opts.transport.disconnect(); } catch { /* ignore */ }
      this.releaseBusy();
      return;
    }
    this.transition({ phase: 'ending' });
    this.armEndingTimeout(myGen);
    if (id) {
      try { await callsApi.hangup(id); } catch { /* ignore */ }
    }
    await this.fullCleanup('ended', null);
  }

  // ─── Incoming-call commands (Unification Pass A) ──────────────────────

  /**
   * Move the engine into incoming_ringing for `offer`. Idempotent for the
   * same offerId — repeated polls do not bump phase or reset the timer.
   * If the engine is already busy with anything else (outgoing call,
   * different offer), the new offer is dropped to keep one-call-at-a-time.
   */
  receiveIncoming(offer: IncomingOffer): void {
    if (this.state.phase === 'incoming_ringing'
        && this.state.incomingOffer?.offerId === offer.offerId) {
      // Same offer, just refresh metadata in case visitor name resolved late.
      this.transition({ incomingOffer: offer });
      return;
    }
    if (this.state.phase !== 'idle') {
      this.log('receiveIncoming ignored — engine not idle', this.state.phase);
      return;
    }
    const myGen = ++this.gen;
    this.transition({
      phase: 'incoming_ringing',
      callType: offer.callType,
      callId: offer.callSessionId,
      busy: true,
      direction: 'incoming',
      conversationId: offer.conversationId,
      incomingOffer: offer,
      errorMessage: null,
      errorCode: null,
    });
    this.armIncomingTimeout(offer, myGen);
  }

  /**
   * Operator accepted the incoming call. This is the critical path that
   * was previously missing: queue accept ➜ token fetch ➜ media connect.
   * Every failure branch releases busy.
   */
  async acceptIncoming(input: AcceptIncomingInput = {}): Promise<void> {
    const offer = this.state.incomingOffer;
    if (this.state.phase !== 'incoming_ringing' || !offer) {
      this.log('acceptIncoming ignored — no active offer');
      return;
    }
    const myGen = this.gen;
    this.clearIncomingTimeout();
    this.transition({ phase: 'connecting' });
    this.armConnectWatchdog(myGen);

    let acceptedCallId: string | null = offer.callSessionId;
    try {
      // 1) Confirm queue ownership server-side. Server links the call_session
      //    if it wasn't already on the offer.
      const accepted = await callQueueApi.accept(offer.workspaceId, offer.offerId);
      if (this.gen !== myGen) return;
      acceptedCallId = accepted.entry.call_session_id ?? acceptedCallId;
      if (!acceptedCallId) {
        throw new Error('Queue accept did not return a call session id');
      }
      this.transition({ callId: acceptedCallId, conversationId: accepted.entry.conversation_id ?? this.state.conversationId });

      // 2) Fetch token from the resolver-backed endpoint.
      const tok = await callsApi.token(acceptedCallId, {
        display_name: input.displayName || 'Operator',
        ttl_seconds: 600,
      });
      if (this.gen !== myGen) return;
      if (!tok.ws_url) {
        throw Object.assign(
          new Error('RTC ws_url missing — configure the call provider in admin'),
          { code: 'config_missing' },
        );
      }

      const iceServers: RTCIceServer[] = [];
      if (tok.turn?.urls?.length) {
        iceServers.push({
          urls: tok.turn.urls,
          username: tok.turn.username || undefined,
          credential: tok.turn.credential || undefined,
        });
      }

      // 3) Connect media. publishCamera flips on for video calls.
      await this.opts.transport.connect({
        wsUrl: tok.ws_url,
        token: tok.token,
        iceServers: iceServers.length ? iceServers : undefined,
        iceTransportPolicy: tok.ice_policy,
        publishCamera: offer.callType === 'video',
      });
      if (this.gen !== myGen) {
        try { await this.opts.transport.disconnect(); } catch { /* ignore */ }
        return;
      }

      // 4) Ack the call session itself (non-fatal).
      try { await callsApi.accept(acceptedCallId); } catch { /* ignore */ }

      this.transition({ phase: 'connected', startedAt: Date.now() });
    } catch (err) {
      if (this.gen !== myGen) return;
      const { code, message } = classifyError(err);
      this.log('acceptIncoming failed', { code, message });
      // Best-effort server hangup so the visitor side stops ringing.
      if (acceptedCallId) {
        try { await callsApi.hangup(acceptedCallId); } catch { /* ignore */ }
      }
      // Best-effort queue cancel — if accept partially succeeded but media
      // failed, we want the queue entry to terminate cleanly.
      try { await callQueueApi.cancel(offer.workspaceId, offer.offerId, 'accept_failed'); } catch { /* ignore */ }
      await this.failTo('failed', code, message, myGen);
    }
  }

  /** Operator declined the incoming offer. */
  async declineIncoming(reason: string = 'operator_declined'): Promise<void> {
    const offer = this.state.incomingOffer;
    if (this.state.phase !== 'incoming_ringing' || !offer) return;
    this.clearIncomingTimeout();
    try {
      await callQueueApi.cancel(offer.workspaceId, offer.offerId, reason);
    } catch { /* network blip — engine still terminates */ }
    await this.fullCleanup('declined', null);
  }

  /**
   * Signal source detected the offer is gone (visitor cancelled, queue
   * timeout server-side, accepted by another operator). Idempotent.
   */
  async cancelIncoming(reason: string = 'remote_cancelled'): Promise<void> {
    if (this.state.phase !== 'incoming_ringing') return;
    this.clearIncomingTimeout();
    this.log('cancelIncoming', reason);
    await this.fullCleanup('expired', reason);
  }

  /** Local offer expiry (we never saw a server cancellation in time). */
  async expireIncoming(): Promise<void> {
    if (this.state.phase !== 'incoming_ringing') return;
    this.clearIncomingTimeout();
    await this.fullCleanup('missed', 'no_answer');
  }

  /** Transport-side disconnect signal (e.g. LiveKit Disconnected event). */
  async onTransportDisconnected(reason: 'remote' | 'failure' | 'unknown' = 'unknown'): Promise<void> {
    if (TERMINAL.has(this.state.phase)) return;
    if (this.state.phase === 'idle') return;
    if (reason === 'failure') {
      await this.failTo('failed', 'connect_failed', 'Connection lost', this.gen);
    } else {
      await this.fullCleanup('ended', null);
    }
  }

  onTransportReconnecting(): void {
    if (this.state.phase === 'connected') this.transition({ phase: 'reconnecting' });
  }

  onTransportReconnected(): void {
    if (this.state.phase === 'reconnecting') this.transition({ phase: 'connected' });
  }

  /** Hard reset. Used by host unmount as a final guarantee against busy leaks. */
  async dispose(): Promise<void> {
    this.gen++; // invalidate any in-flight async work
    this.clearRingTimeout();
    this.clearEndingTimeout();
    this.clearIncomingTimeout();
    if (!TERMINAL.has(this.state.phase) && this.state.phase !== 'idle') {
      const id = this.state.callId;
      if (id) {
        try { await callsApi.hangup(id); } catch { /* ignore */ }
      }
      // For an unaccepted incoming offer, also tell the queue we're gone.
      const offer = this.state.incomingOffer;
      if (this.state.phase === 'incoming_ringing' && offer) {
        try { await callQueueApi.cancel(offer.workspaceId, offer.offerId, 'operator_unmounted'); } catch { /* ignore */ }
      }
    }
    try { await this.opts.transport.disconnect(); } catch { /* ignore */ }
    this.listeners.clear();
    // Force-clear busy regardless of phase — host is going away.
    this.state = { ...INITIAL };
  }

  // ─── Internals ──────────────────────────────────────────────────────────

  private transition(patch: Partial<CallSessionState>): void {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) {
      try { fn(this.state); } catch (e) { this.log('listener error', e); }
    }
  }

  /**
   * Move to a terminal state, ensure transport is torn down and busy is
   * released. Idempotent — re-entrant calls are dropped.
   */
  private async fullCleanup(terminal: 'ended' | 'expired' | 'declined' | 'missed', detail: string | null): Promise<void> {
    if (this.releasing) return;
    this.releasing = true;
    try {
      this.clearRingTimeout();
      this.clearEndingTimeout();
      this.clearIncomingTimeout();
      try { await this.opts.transport.disconnect(); } catch { /* ignore */ }
      this.transition({ phase: terminal, errorMessage: detail, errorCode: detail ? 'remote_hangup' : null });
      this.releaseBusy();
      // After a beat in a terminal state, return to idle so the engine
      // accepts the next call. UI may keep showing the terminal label
      // for a moment via its own logic (toast, etc).
      this.scheduleIdleReset();
    } finally {
      this.releasing = false;
    }
  }

  private async failTo(terminal: 'failed', code: string, message: string, myGen: number): Promise<void> {
    if (this.gen !== myGen) return;
    if (this.releasing) return;
    this.releasing = true;
    try {
      this.clearRingTimeout();
      this.clearEndingTimeout();
      this.clearIncomingTimeout();
      try { await this.opts.transport.disconnect(); } catch { /* ignore */ }
      this.transition({ phase: terminal, errorCode: code, errorMessage: message });
      this.releaseBusy();
      this.scheduleIdleReset();
    } finally {
      this.releasing = false;
    }
  }

  /** Final guarantee: clear busy AFTER terminal phase has been published. */
  private releaseBusy(): void {
    if (this.state.busy) this.transition({ busy: false });
  }

  /** Drop back to idle so a follow-up call can start. ~3s grace for UI toast. */
  private idleResetTimer: ReturnType<typeof setTimeout> | null = null;
  private scheduleIdleReset(): void {
    if (this.idleResetTimer) clearTimeout(this.idleResetTimer);
    this.idleResetTimer = setTimeout(() => {
      this.idleResetTimer = null;
      if (TERMINAL.has(this.state.phase)) {
        this.state = { ...INITIAL };
        for (const fn of this.listeners) {
          try { fn(this.state); } catch { /* */ }
        }
      }
    }, 3000);
  }

  private armRingTimeout(myGen: number): void {
    this.clearRingTimeout();
    this.ringTimer = setTimeout(() => {
      if (this.gen !== myGen) return;
      if (this.state.phase !== 'outgoing_ringing' && this.state.phase !== 'connecting') return;
      this.log('ring timeout — no answer');
      const id = this.state.callId;
      if (id) { void callsApi.hangup(id).catch(() => { /* ignore */ }); }
      void this.fullCleanup('missed', 'no_answer');
    }, this.opts.ringTimeoutMs);
  }

  private clearRingTimeout(): void {
    if (this.ringTimer) { clearTimeout(this.ringTimer); this.ringTimer = null; }
  }

  private armEndingTimeout(myGen: number): void {
    this.clearEndingTimeout();
    this.endingTimer = setTimeout(() => {
      if (this.gen !== myGen) return;
      if (this.state.phase !== 'ending') return;
      this.log('ending timeout — forcing cleanup');
      void this.fullCleanup('ended', null);
    }, ENDING_TIMEOUT_MS);
  }

  private clearEndingTimeout(): void {
    if (this.endingTimer) { clearTimeout(this.endingTimer); this.endingTimer = null; }
  }

  private armIncomingTimeout(offer: IncomingOffer, myGen: number): void {
    this.clearIncomingTimeout();
    // Local safety net — server typically expires the offer first, but if
    // the signal source doesn't see the cancellation we still terminate.
    let ms = this.opts.ringTimeoutMs;
    if (offer.expiresAt) {
      const remain = new Date(offer.expiresAt).getTime() - Date.now();
      if (remain > 0) ms = Math.min(ms, remain + 1500);
    }
    this.incomingTimer = setTimeout(() => {
      if (this.gen !== myGen) return;
      if (this.state.phase !== 'incoming_ringing') return;
      this.log('incoming offer timed out');
      void this.expireIncoming();
    }, Math.max(2000, ms));
  }

  private clearIncomingTimeout(): void {
    if (this.incomingTimer) { clearTimeout(this.incomingTimer); this.incomingTimer = null; }
  }

  private log(msg: string, extra?: unknown): void {
    this.opts.log?.(msg, extra);
  }
}

/** Convenience: terminal-phase predicate. */
export function isTerminalPhase(phase: CallPhase): boolean {
  return TERMINAL.has(phase);
}

/** Convenience: human label per phase (untranslated; UI may localize). */
export function describePhase(state: CallSessionState): string {
  switch (state.phase) {
    case 'idle': return '';
    case 'preparing': return 'Starting call...';
    case 'outgoing_ringing': return 'Ringing...';
    case 'incoming_ringing': return 'Incoming call...';
    case 'connecting': return 'Connecting...';
    case 'connected': return state.callType === 'video' ? 'In call (video)' : 'In call';
    case 'reconnecting': return 'Reconnecting...';
    case 'ending': return 'Ending...';
    case 'ended': return 'Call ended';
    case 'failed': return state.errorMessage || 'Call failed';
    case 'declined': return 'Call declined';
    case 'missed': return 'No answer';
    case 'expired': return 'Call expired';
  }
}