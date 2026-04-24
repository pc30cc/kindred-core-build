/**
 * Phase — Inbox Call Hardening · Pass 1
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
 * NOT in scope for this pass:
 *  - Audio/Video UI surface split (Pass 4)
 *  - Ringing/ringback audio (Pass 3)
 *  - Incoming call subscription (Pass 3)
 */
import { callsApi, type CallType, type CreateCallInput } from '@/lib/calls-api';

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
};

/** Default no-answer window for outgoing calls (ms). */
const DEFAULT_RING_TIMEOUT_MS = 35_000;

/** Soft fallback so a stuck `ending` cannot trap the UI. */
const ENDING_TIMEOUT_MS = 6_000;

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
  const msg = (e as { message?: string })?.message || String(e);
  const lower = msg.toLowerCase();
  if (lower.includes('permission') || lower.includes('notallowed') || lower.includes('denied')) {
    return { code: 'media_denied', message: msg };
  }
  if (lower.includes('token')) return { code: 'token_failed', message: msg };
  if (lower.includes('ws_url') || lower.includes('rtc')) return { code: 'config_missing', message: msg };
  if (lower.includes('connect')) return { code: 'connect_failed', message: msg };
  return { code: 'unknown', message: msg };
}

export class CallSessionEngine {
  private state: CallSessionState = { ...INITIAL };
  private listeners = new Set<Listener>();
  private opts: Required<Pick<EngineOptions, 'ringTimeoutMs'>> & EngineOptions;
  private ringTimer: ReturnType<typeof setTimeout> | null = null;
  private endingTimer: ReturnType<typeof setTimeout> | null = null;
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
    this.transition({ phase: 'preparing', callType: input.callType, busy: true, errorMessage: null, errorCode: null });

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
    if (!TERMINAL.has(this.state.phase) && this.state.phase !== 'idle') {
      const id = this.state.callId;
      if (id) {
        try { await callsApi.hangup(id); } catch { /* ignore */ }
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
      try { await this.opts.transport.disconnect(); } catch { /* ignore */ }
      this.transition({ phase: terminal, errorMessage: detail, errorCode: detail ? 'remote_hangup' : null });
      this.releaseBusy();
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
      try { await this.opts.transport.disconnect(); } catch { /* ignore */ }
      this.transition({ phase: terminal, errorCode: code, errorMessage: message });
      this.releaseBusy();
    } finally {
      this.releasing = false;
    }
  }

  /** Final guarantee: clear busy AFTER terminal phase has been published. */
  private releaseBusy(): void {
    if (this.state.busy) this.transition({ busy: false });
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