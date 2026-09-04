/**
 * Centrifugo client adapter.
 *
 * Wraps the existing Centrifugo v5 bidirectional JSON protocol used by
 * the visitor widget runtime. Connection negotiation and per-channel
 * subscription tokens are obtained from the backend
 * (`/api/realtime/operator-connect`, `/api/realtime/operator-subscribe`)
 * — the same routes the Inbox already uses today, so the wire contract
 * is unchanged.
 *
 * Per-workspace singleton: one WebSocket multiplexes all channel
 * subscriptions in the same browser tab. This avoids opening N sockets
 * when the operator navigates between conversations.
 */

import { supabase } from '@/lib/supabase';
import type {
  ClientRealtimeProvider,
  NormalizedMessagePayload,
  RealtimeHandlers,
  RealtimeNegotiation,
  RealtimeSubscription,
} from '../types';
import { rtDebug, rtWarn } from '../debug';
import { getReconnectBackoffMultiplier } from '../policySnapshot';
import { API_BASE as RESOLVED_API_BASE } from '@/lib/apiBase';

const API_BASE = (RESOLVED_API_BASE as string | undefined) || '';

/**
 * How long before a token's `expires_at` we proactively refresh it.
 * Server now issues 30min TTLs by default; refreshing 2min ahead gives
 * us plenty of margin even on a tab the browser has throttled to 1Hz
 * setTimeout while it was backgrounded.
 */
const TOKEN_REFRESH_LEAD_MS = 120_000;

/** Backoff schedule (ms) for socket reconnect attempts. Capped at 30s. */
const RECONNECT_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000, 15_000, 30_000];

/**
 * Phase 2 — runtime hardening knobs read once per tab from the public
 * `widget_platform_settings` row. These are SAFETY caps and pacing
 * controls; the values fall back to safe defaults if the read fails or
 * the row is missing. Never throws.
 *
 *   • reconnectJitterPct: ±N% jitter applied to RECONNECT_DELAYS_MS so
 *     N tabs from the same operator (or N visitors after a regional
 *     network blip) don't all hammer /api/realtime/*-connect at the
 *     identical millisecond and trigger a thundering herd.
 *   • pendingMax: hard cap on the per-socket `pending` map so a stuck
 *     server can't grow that map unboundedly during a long outage.
 *   • messageDedupeEnabled / Window: drop duplicate `push` frames for
 *     the same `payload.id` before fan-out. Centrifugo CAN replay a
 *     push on resubscribe (rare, but documented), and any future
 *     bridge from a different transport could re-emit the same id.
 *     The ring is per channel and bounded.
 */
interface ClientHardeningSettings {
  reconnectJitterPct: number;
  pendingMax: number;
  messageDedupeEnabled: boolean;
  messageDedupeWindow: number;
}

const HARDENING_DEFAULTS: ClientHardeningSettings = {
  reconnectJitterPct: 20,
  pendingMax: 256,
  messageDedupeEnabled: true,
  messageDedupeWindow: 200,
};

let hardeningCache: ClientHardeningSettings | null = null;
let hardeningInflight: Promise<ClientHardeningSettings> | null = null;

function clampInt(raw: unknown, min: number, max: number, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.trunc(n);
  if (i < min) return min;
  if (i > max) return max;
  return i;
}

async function loadHardening(): Promise<ClientHardeningSettings> {
  if (hardeningCache) return hardeningCache;
  if (hardeningInflight) return hardeningInflight;
  hardeningInflight = (async () => {
    try {
      // Sanitized RPC — the raw table holds secrets (alert_webhook_secret)
      // and is not readable by anon/browser clients.
      const { data: raw } = await supabase.rpc('get_widget_platform_settings');
      const data = (raw ?? null) as Record<string, unknown> | null;
      const value: ClientHardeningSettings = data
        ? {
            reconnectJitterPct: clampInt(data.realtime_reconnect_jitter_pct, 0, 50, 20),
            pendingMax: clampInt(data.realtime_pending_max, 32, 4096, 256),
            messageDedupeEnabled: data.realtime_message_dedupe_enabled !== false,
            messageDedupeWindow: clampInt(data.realtime_message_dedupe_window, 16, 4096, 200),
          }
        : HARDENING_DEFAULTS;

      hardeningCache = value;
      return value;
    } catch {
      hardeningCache = HARDENING_DEFAULTS;
      return HARDENING_DEFAULTS;
    } finally {
      hardeningInflight = null;
    }
  })();
  return hardeningInflight;
}

/**
 * Synchronous accessor — returns the cached value or the safe default.
 * Used inside hot paths (onmessage / scheduleReconnect) where we don't
 * want to await. The async loader is kicked off the first time a
 * connection is built.
 */
function getHardeningSync(): ClientHardeningSettings {
  return hardeningCache || HARDENING_DEFAULTS;
}

/** Apply ±jitterPct% jitter to a base delay. Always >= 0. */
function jitter(baseMs: number, jitterPct: number): number {
  if (!jitterPct || jitterPct <= 0) return baseMs;
  const span = baseMs * (jitterPct / 100);
  const offset = (Math.random() * 2 - 1) * span;
  return Math.max(0, Math.round(baseMs + offset));
}

/**
 * Returns true if `id` was already seen on `channel` within the dedupe
 * window — caller should drop the frame. Otherwise records the id and
 * returns false. Bounded ring per channel.
 */
function rememberAndCheckSeen(
  conn: SharedConnection,
  channel: string,
  id: string,
  window: number,
): boolean {
  let ring = conn.seenByChannel.get(channel);
  if (!ring) {
    ring = new Map();
    conn.seenByChannel.set(channel, ring);
  }
  if (ring.has(id)) return true;
  ring.set(id, true);
  // Evict oldest entries beyond the window.
  while (ring.size > window) {
    const firstKey = ring.keys().next().value as string | undefined;
    if (firstKey === undefined) break;
    ring.delete(firstKey);
  }
  return false;
}

interface SubscribeResponse {
  vendor: 'centrifugo' | 'polling_builtin';
  channel?: string;
  token?: string;
  expires_at?: number;
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

/**
 * Fetch a fresh connection negotiation. Callers pass the real lifecycle
 * stage explicitly — 'refresh' for scheduleTokenRefresh's proactive
 * re-negotiation on a still-healthy socket, 'reconnect' for
 * scheduleReconnect's re-negotiation after the socket actually closed.
 * Independent of the provider's cached negotiation so a long-lived tab
 * never gets stuck on a stale token.
 */
async function negotiateConnect(
  workspaceId: string,
  intent: 'initial' | 'refresh' | 'reconnect',
): Promise<RealtimeNegotiation | null> {
  try {
    const res = await fetch(`${API_BASE}/api/realtime/operator-connect`, {
      credentials: 'include',
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ workspace_id: workspaceId, intent }),
    });
    if (!res.ok) return null;
    return (await res.json()) as RealtimeNegotiation;
  } catch {
    return null;
  }
}

/**
 * Lightweight reconnect telemetry — the "genuine first reconnect with a
 * still-valid token" case. Reports the reconnect to the server WITHOUT
 * negotiating (and thus minting) a new Centrifugo token, since the
 * existing token is about to be reused directly by openSocket(). Fire-
 * and-forget: a failure here must never block or delay the actual
 * reconnect attempt.
 */
function sendReconnectSignal(workspaceId: string): void {
  fetch(`${API_BASE}/api/realtime/operator-reconnect-signal`, {
    credentials: 'include',
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ workspace_id: workspaceId }),
  }).catch(() => {
    /* best-effort telemetry only */
  });
}

async function operatorSubscribe(
  workspaceId: string,
  conversationId: string,
): Promise<SubscribeResponse | null> {
  try {
    const res = await fetch(`${API_BASE}/api/realtime/operator-subscribe`, {
      credentials: 'include',
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ workspace_id: workspaceId, conversation_id: conversationId }),
    });
    if (!res.ok) return null;
    return (await res.json()) as SubscribeResponse;
  } catch {
    return null;
  }
}

async function operatorInboxSubscribe(workspaceId: string): Promise<SubscribeResponse | null> {
  try {
    const res = await fetch(`${API_BASE}/api/realtime/operator-inbox-subscribe`, {
      credentials: 'include',
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ workspace_id: workspaceId }),
    });
    if (!res.ok) return null;
    return (await res.json()) as SubscribeResponse;
  } catch {
    return null;
  }
}

async function operatorVisitorsSubscribe(workspaceId: string): Promise<SubscribeResponse | null> {
  try {
    const res = await fetch(`${API_BASE}/api/realtime/operator-visitors-subscribe`, {
      credentials: 'include',
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ workspace_id: workspaceId }),
    });
    if (!res.ok) return null;
    return (await res.json()) as SubscribeResponse;
  } catch {
    return null;
  }
}

async function operatorPresenceSubscribe(workspaceId: string): Promise<SubscribeResponse | null> {
  try {
    const res = await fetch(`${API_BASE}/api/realtime/operator-presence-subscribe`, {
      credentials: 'include',
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ workspace_id: workspaceId }),
    });
    if (!res.ok) return null;
    return (await res.json()) as SubscribeResponse;
  } catch {
    return null;
  }
}

/**
 * Parse a workspace channel and decide which subscription endpoint to use.
 *  - ws:<wsId>:conv:<convId> → per-conversation token endpoint
 *  - ws:<wsId>:inbox         → operator inbox token endpoint
 *  - ws:<wsId>:visitors      → operator visitors token endpoint
 */
type ParsedChannel =
  | { kind: 'conversation'; workspaceId: string; conversationId: string }
  | { kind: 'inbox'; workspaceId: string }
  | { kind: 'visitors'; workspaceId: string }
  | { kind: 'operators'; workspaceId: string };

function parseChannel(channel: string): ParsedChannel | null {
  let m = /^ws:([^:]+):conv:(.+)$/.exec(channel);
  if (m) return { kind: 'conversation', workspaceId: m[1], conversationId: m[2] };
  m = /^ws:([^:]+):inbox$/.exec(channel);
  if (m) return { kind: 'inbox', workspaceId: m[1] };
  m = /^ws:([^:]+):visitors$/.exec(channel);
  if (m) return { kind: 'visitors', workspaceId: m[1] };
  m = /^ws:([^:]+):operators$/.exec(channel);
  if (m) return { kind: 'operators', workspaceId: m[1] };
  return null;
}

/** Per-tab connection cache keyed by ws_url so we share one socket. */
interface SharedConnection {
  ws: WebSocket;
  ready: Promise<void>;
  nextId: number;
  pending: Record<number, (reply: any) => void>;
  subs: Map<string, Set<RealtimeHandlers>>; // channel → handlers
  /** Per-channel sub token cache so we can re-subscribe after reconnect. */
  subTokens: Map<string, { channel: string; token: string; expiresAt: number; refresh: () => Promise<SubscribeResponse | null> }>;
  closed: boolean;
  /** Workspace this connection belongs to (for token refresh). */
  workspaceId: string;
  /** Currently negotiated connection token + expiry (ms epoch). */
  token: string;
  tokenExpiresAt: number;
  wsUrl: string;
  /** Reconnect bookkeeping. */
  reconnectAttempt: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  refreshTimer: ReturnType<typeof setTimeout> | null;
  /** Set true when caller asked to permanently tear down. */
  disposed: boolean;
  /**
   * Monotonic generation counter — incremented every time a NEW socket is
   * opened. Async tasks (notably `resubscribeAll`) capture the generation
   * they started with and bail out the moment they detect the live
   * generation has moved on. This prevents stale resubscribe loops from
   * spamming `socket_closed` warnings against a connection that has
   * already been replaced.
   */
  generation: number;
  /**
   * Phase 2 — per-channel message dedupe ring. Bounded by
   * messageDedupeWindow from platform settings. Plain Map (insertion
   * order) lets us evict the oldest in O(1) without a separate LRU lib.
   */
  seenByChannel: Map<string, Map<string, true>>;
  /**
   * Set right before scheduleTokenRefresh() intentionally closes the
   * socket to rotate onto a freshly-refreshed token. The resulting
   * onclose → scheduleReconnect() must NOT report this as a real
   * reconnect (nothing was unexpectedly lost) — consumed (read once,
   * reset to false) by scheduleReconnect's very next timer callback.
   */
  expectingCloseForRefresh: boolean;
  /**
   * True once this shared connection has completed at least one successful
   * Centrifugo CONNECT handshake (sendOnConn(conn, 'connect', ...)
   * resolving in openSocket's onOpen). This is the ONLY source of truth for
   * "did a connection ever exist" — token presence, a live WebSocket,
   * onopen firing, or reconnectAttempt are NOT proof, since all of those
   * can happen while the very first CONNECT is still pending or gets
   * rejected. Before this flips true, scheduleReconnect's retries are
   * initial-connection recovery and must emit zero reconnect telemetry.
   */
  everConnected: boolean;
}

const sharedConns = new Map<string, SharedConnection>();

function buildConnection(workspaceId: string, negotiation: RealtimeNegotiation): SharedConnection {
  const conn: SharedConnection = {
    ws: null as unknown as WebSocket, // assigned by openSocket()
    nextId: 1,
    pending: {},
    subs: new Map(),
    subTokens: new Map(),
    closed: false,
    workspaceId,
    token: negotiation.token!,
    // Server emits `expires_at` already in epoch milliseconds
    // (see server/services/realtime/centrifugo.ts: `expires_at: exp * 1000`).
    // Do NOT multiply again — doing so produced a value ~1.78e21 which,
    // when passed to setTimeout in `scheduleTokenRefresh`, exceeded the
    // 32-bit timer max and was clamped to ~1ms by the browser, causing
    // a steady-state 2s connect/refresh storm against /api/realtime/operator-connect.
    tokenExpiresAt: negotiation.expires_at || Date.now() + 9 * 60_000,
    wsUrl: negotiation.ws_url!,
    reconnectAttempt: 0,
    reconnectTimer: null,
    refreshTimer: null,
    disposed: false,
    ready: Promise.resolve(),
    generation: 0,
    seenByChannel: new Map(),
    expectingCloseForRefresh: false,
    everConnected: false,
  };
  // Phase 2 — kick off the hardening-settings prefetch (non-blocking).
  // First connection on this tab will use defaults; subsequent reconnects
  // pick up the platform-configured values.
  loadHardening();
  conn.ready = openSocket(conn);
  return conn;
}

/**
 * Open (or re-open) the underlying WebSocket and perform the Centrifugo
 * `connect` handshake. On success: clears reconnect counters, resubscribes
 * to every channel that was active before the disconnect, and schedules a
 * proactive token refresh.
 */
function openSocket(conn: SharedConnection): Promise<void> {
  conn.closed = false;
  // Bump the connection generation. Any in-flight async task bound to the
  // PREVIOUS generation (e.g. a resubscribeAll loop that started against
  // the old socket and was still running when onclose fired) will compare
  // its captured generation against this new value and bail out instead
  // of spamming `socket_closed` errors against the dead socket.
  conn.generation += 1;
  conn.ws = new WebSocket(conn.wsUrl);
  attachSocketHandlers(conn);
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const onOpen = async () => {
      try {
        await sendOnConn(conn, 'connect', { token: conn.token, name: 'inbox' });
        // Authoritative proof a connection now exists — see the field doc
        // on SharedConnection.everConnected. Set unconditionally on every
        // successful CONNECT ack, not just the first, so it stays true.
        conn.everConnected = true;
        conn.reconnectAttempt = 0;
        scheduleTokenRefresh(conn);
        // Re-subscribe to every channel that survived the disconnect.
        await resubscribeAll(conn);
        // Notify any waiting handlers that we're back online.
        conn.subs.forEach((set) => set.forEach((h) => h.onStatus?.('open')));
        if (!settled) { settled = true; resolve(); }
      } catch (err) {
        // Surface the real Centrifugo error message so scheduleReconnect
        // can detect token-related failures and force a re-negotiation.
        const e: any = err;
        const msg = e?.message || e?.reason || (typeof e === 'string' ? e : 'connect_failed');
        if (!settled) { settled = true; reject(new Error(msg)); }
      }
    };
    const onErr = () => {
      if (!settled) { settled = true; reject(new Error('ws_error')); }
    };
    conn.ws.addEventListener('open', onOpen, { once: true });
    conn.ws.addEventListener('error', onErr, { once: true });
  });
}

function attachSocketHandlers(conn: SharedConnection): void {
  const ws = conn.ws;
  ws.onmessage = (ev) => {
    const lines = String(ev.data || '').split('\n');
    for (const line of lines) {
      if (!line) continue;
      let frame: any;
      try {
        frame = JSON.parse(line);
      } catch {
        continue;
      }
      // Centrifugo keepalive (empty object) → echo back.
      if (!frame.id && !frame.push && !frame.error) {
        try {
          ws.send('{}');
        } catch {
          /* noop */
        }
        continue;
      }
      if (frame.id && conn.pending[frame.id]) {
        const cb = conn.pending[frame.id];
        delete conn.pending[frame.id];
        cb(frame);
        continue;
      }
      if (frame.push?.pub?.data && frame.push.channel) {
        const channel = frame.push.channel as string;
        const data = frame.push.pub.data;
        const handlersSet = conn.subs.get(channel);
        if (!handlersSet) continue;
        if (data?.type === 'message' && data.payload) {
          const payload = data.payload as NormalizedMessagePayload;
          // Phase 2 — message dedupe. Centrifugo can replay a recent push
          // on resubscribe; drop duplicates by payload.id before fan-out.
          const { messageDedupeEnabled, messageDedupeWindow } = getHardeningSync();
          if (messageDedupeEnabled && (payload as any)?.id) {
            if (rememberAndCheckSeen(conn, channel, String((payload as any).id), messageDedupeWindow)) {
              continue;
            }
          }
          handlersSet.forEach((h) => h.onMessage?.(payload));
        } else if (data?.type === 'typing') {
          handlersSet.forEach((h) => h.onTyping?.(data.payload || {}));
        } else if (data?.type === 'seen') {
          handlersSet.forEach((h) => h.onSeen?.(data.payload || {}));
        } else if (data?.type === 'event' && data.payload) {
          // Phase 5 — operator-only event envelope.
          handlersSet.forEach((h) => h.onEvent?.(data.payload));
        }
        // Unknown envelope types are silently dropped (forward-safe).
      }
      // Centrifugo server may push a disconnect frame (e.g. on token expiry).
      // Treat it as a soft signal to refresh the token and reconnect.
      if (frame.push?.disconnect) {
        rtWarn('centrifugo', 'server disconnect push', {
          code: frame.push.disconnect.code,
          reason: frame.push.disconnect.reason,
        });
        // Force a fresh negotiation on the next open.
        conn.tokenExpiresAt = 0;
      }
    }
  };
  ws.onclose = (ev) => {
    conn.closed = true;
    if (conn.refreshTimer) { clearTimeout(conn.refreshTimer); conn.refreshTimer = null; }
    // Reject any in-flight commands so callers don't hang forever.
    const pendingIds = Object.keys(conn.pending);
    for (const idStr of pendingIds) {
      const id = Number(idStr);
      try { conn.pending[id]({ error: { message: 'socket_closed' } }); } catch { /* noop */ }
      delete conn.pending[id];
    }
    rtDebug('centrifugo', 'socket closed', { code: ev?.code, reason: ev?.reason });
    conn.subs.forEach((set) => set.forEach((h) => h.onStatus?.('closed')));
    if (!conn.disposed) scheduleReconnect(conn);
  };
  ws.onerror = () => {
    rtWarn('centrifugo', 'socket error');
    conn.subs.forEach((set) => set.forEach((h) => h.onStatus?.('error')));
    // onclose will follow → reconnect logic runs there.
  };
}

function scheduleReconnect(conn: SharedConnection): void {
  if (conn.disposed) return;
  if (conn.reconnectTimer) return;
  // If no subscribers remain, there's nothing to reconnect for.
  if (conn.subs.size === 0) return;
  const baseDelay = RECONNECT_DELAYS_MS[Math.min(conn.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
  // Phase 6C — multiply base delay by the effective policy multiplier
  // BEFORE jitter, then cap at 60s (2x the existing 30s cap) so a
  // misconfigured multiplier can never produce minute-scale stalls.
  const multiplier = getReconnectBackoffMultiplier();
  const scaled = Math.min(60_000, baseDelay * multiplier);
  // Phase 2 — apply ±jitterPct% randomness so a region-wide outage doesn't
  // produce N tabs reconnecting at the identical millisecond.
  const { reconnectJitterPct } = getHardeningSync();
  const delay = jitter(scaled, reconnectJitterPct);
  conn.reconnectAttempt += 1;
  rtDebug('centrifugo', 'scheduling reconnect', {
    attempt: conn.reconnectAttempt,
    baseDelayMs: baseDelay,
    multiplier,
    scaledMs: scaled,
    delayMs: delay,
    jitterPct: reconnectJitterPct,
  });
  conn.subs.forEach((set) => set.forEach((h) => h.onStatus?.('connecting')));
  conn.reconnectTimer = setTimeout(async () => {
    conn.reconnectTimer = null;
    if (conn.disposed) return;
    // Decide whether we MUST re-negotiate before opening a new socket.
    // We don't trust the local `tokenExpiresAt` alone — server clock skew
    // or a previous server-side rejection of our token can leave us with
    // a "locally fresh" but server-rejected token, which would loop
    // forever. Force a re-negotiation when:
    //   1) the token is at/near expiry by our clock, OR
    //   2) we've already failed to (re)open the socket at least once
    //      (reconnectAttempt > 1) — the previous failure was almost
    //      certainly a token issue at the server, even if we think the
    //      token is still valid.
    const localExpired = Date.now() >= conn.tokenExpiresAt - TOKEN_REFRESH_LEAD_MS;
    const mustRefreshDueToFailure = conn.reconnectAttempt > 1;
    // Consume the self-inflicted-close flag exactly once, before either
    // branch below runs — it must never leak into a later, genuine close.
    const wasIntentionalRefreshRotation = conn.expectingCloseForRefresh;
    conn.expectingCloseForRefresh = false;

    if (!conn.everConnected) {
      // No successful CONNECT ack has EVER landed on this shared
      // connection — there is nothing to "reconnect" to yet. Every retry
      // here is initial-connection recovery: zero reconnect telemetry, and
      // any required re-negotiation uses 'initial' intent, never
      // 'reconnect'. WebSocket onopen / a live socket / token presence /
      // reconnectAttempt are NOT proof a connection previously existed —
      // only conn.everConnected (set from a successful CONNECT ack) is.
      if (localExpired || mustRefreshDueToFailure) {
        try {
          const { invalidateClientRealtimeCache } = await import('../resolveClientRealtimeProvider');
          invalidateClientRealtimeCache(conn.workspaceId);
        } catch { /* noop */ }
        const fresh = await negotiateConnect(conn.workspaceId, 'initial');
        if (fresh?.token && fresh.ws_url) {
          conn.token = fresh.token;
          conn.tokenExpiresAt = fresh.expires_at || Date.now() + 9 * 60_000;
          conn.wsUrl = fresh.ws_url;
          rtDebug('centrifugo', 'initial connection recovery: fresh token negotiated', {
            expiresInMs: conn.tokenExpiresAt - Date.now(),
          });
        } else {
          rtWarn('centrifugo', 'initial token negotiation failed; will retry');
          scheduleReconnect(conn);
          return;
        }
      }
      // No reconnect signal, no intent:'reconnect' — this is still initial
      // recovery even if the token happened to still look locally valid.
      try {
        await openSocket(conn);
      } catch (err) {
        const msg = String((err as any)?.message || err || '');
        rtWarn('centrifugo', 'initial connection recovery open failed', { error: msg });
        if (/token|expired|unauthorized|401/i.test(msg)) {
          conn.tokenExpiresAt = 0;
        }
        // Loop will continue via onclose → scheduleReconnect.
      }
      return;
    }

    // conn.everConnected === true: a previously established connection was
    // genuinely lost — real reconnect accounting applies from here on.
    if (localExpired || mustRefreshDueToFailure) {
      // Bust the per-workspace negotiation cache so we don't get a stale
      // token handed back from a memoized resolver.
      try {
        const { invalidateClientRealtimeCache } = await import('../resolveClientRealtimeProvider');
        invalidateClientRealtimeCache(conn.workspaceId);
      } catch { /* noop */ }
      const fresh = await negotiateConnect(conn.workspaceId, 'reconnect');
      if (fresh?.token && fresh.ws_url) {
        conn.token = fresh.token;
        // expires_at is already epoch ms from the server — do not scale.
        conn.tokenExpiresAt = fresh.expires_at || Date.now() + 9 * 60_000;
        conn.wsUrl = fresh.ws_url;
        rtDebug('centrifugo', 'reconnect: fresh token negotiated', {
          expiresInMs: conn.tokenExpiresAt - Date.now(),
          reason: localExpired ? 'local_expired' : 'prior_failure',
        });
      } else {
        rtWarn('centrifugo', 'token refresh failed; will retry');
        scheduleReconnect(conn);
        return;
      }
    } else if (!wasIntentionalRefreshRotation) {
      // Genuine first reconnect with a still-valid token: the socket was
      // unexpectedly lost (network blip, server restart, tab wake) and
      // we're about to reuse the existing token rather than re-negotiate.
      // Report it via the lightweight signal so it isn't silently
      // undercounted — but don't force a token mint just for telemetry.
      sendReconnectSignal(conn.workspaceId);
    }
    // else: this close was self-inflicted by scheduleTokenRefresh's
    // proactive rotation — nothing was lost, so no reconnect is reported.
    try {
      await openSocket(conn);
    } catch (err) {
      const msg = String((err as any)?.message || err || '');
      rtWarn('centrifugo', 'reconnect open failed', { error: msg });
      // If the failure looks like a token problem, mark the local expiry
      // as past so the NEXT scheduleReconnect cycle definitely re-negotiates.
      if (/token|expired|unauthorized|401/i.test(msg)) {
        conn.tokenExpiresAt = 0;
      }
      // Loop will continue via onclose → scheduleReconnect.
    }
  }, delay);
}

function scheduleTokenRefresh(conn: SharedConnection): void {
  if (conn.refreshTimer) { clearTimeout(conn.refreshTimer); conn.refreshTimer = null; }
  const msUntil = conn.tokenExpiresAt - Date.now() - TOKEN_REFRESH_LEAD_MS;
  if (msUntil <= 0) return; // No useful expiry — let server pushes drive reconnect.
  conn.refreshTimer = setTimeout(async () => {
    conn.refreshTimer = null;
    if (conn.disposed || conn.closed) return;
    const fresh = await negotiateConnect(conn.workspaceId, 'refresh');
    if (!fresh?.token) {
      rtWarn('centrifugo', 'proactive token refresh failed');
      // Re-arm so we try again before the existing token actually expires.
      conn.refreshTimer = setTimeout(() => scheduleTokenRefresh(conn), 30_000);
      return;
    }
    conn.token = fresh.token;
    // expires_at is already epoch ms from the server — do not scale.
    conn.tokenExpiresAt = fresh.expires_at || Date.now() + 9 * 60_000;
    if (fresh.ws_url) conn.wsUrl = fresh.ws_url;
    // Centrifugo v5 supports in-place connection token refresh via the
    // `refresh` command — but our backend re-issues full negotiations and
    // the server-side TTL is generous. Simpler & safer: just rotate the
    // socket. The reconnect path resubscribes everything atomically.
    rtDebug('centrifugo', 'rotating socket for token refresh');
    // Mark this close as self-inflicted so the onclose → scheduleReconnect
    // path it triggers doesn't report a real reconnect — the token is
    // already fresh and nothing was unexpectedly lost.
    conn.expectingCloseForRefresh = true;
    try { conn.ws.close(); } catch { /* noop */ }
    // onclose → scheduleReconnect picks up with the fresh token.
  }, msUntil);
}

/**
 * Re-issue subscribe commands for every cached subscription. Called on
 * (re)connect. Refreshes per-channel sub tokens if they're expired.
 *
 * Token-expiry handling: if Centrifugo rejects a subscribe with a token-
 * related error (code 109, or any message matching token / expired /
 * unauthorized), we cannot trust the cached subscription token even if
 * our local clock says it's still valid — the server may have rotated
 * keys, the operator's session may have rolled, or the previous refresh
 * call returned a stale cached value. In that case we forcibly invalidate
 * the entry (`expiresAt = 0`), call `entry.refresh()` once to obtain a
 * brand-new token, and retry the subscribe exactly once. If the retry
 * still fails we surface the error and stop — the outer reconnect loop
 * will take over rather than spinning a tight per-channel loop with a
 * dead token.
 */
async function resubscribeAll(conn: SharedConnection): Promise<void> {
  // Capture the generation we started with. If the socket dies and is
  // replaced mid-loop, every subsequent iteration becomes a no-op and we
  // exit quickly. The NEW socket's openSocket will run resubscribeAll
  // again from scratch — that path is the single source of truth for
  // recovery on a fresh connection.
  const startGeneration = conn.generation;
  const isStale = (): boolean => {
    if (conn.disposed) return true;
    if (conn.generation !== startGeneration) return true;
    if (conn.closed) return true;
    if (!conn.ws || conn.ws.readyState !== 1) return true;
    return false;
  };

  const channels = Array.from(conn.subTokens.keys());
  for (const channel of channels) {
    // Hard guard before each network round-trip: if the socket died or
    // got replaced, abandon the loop instead of marching through every
    // remaining channel and emitting `socket_closed` per channel.
    if (isStale()) {
      rtDebug('centrifugo', 'resubscribe loop aborted — connection stale', {
        startGeneration,
        currentGeneration: conn.generation,
        disposed: conn.disposed,
        closed: conn.closed,
        readyState: conn.ws?.readyState,
        remaining: channels.length - channels.indexOf(channel),
      });
      return;
    }
    const entry = conn.subTokens.get(channel);
    if (!entry) continue;
    let token = entry.token;
    if (!token || Date.now() >= entry.expiresAt - 30_000) {
      const fresh = await entry.refresh();
      if (isStale()) {
        rtDebug('centrifugo', 'resubscribe loop aborted post-refresh — connection stale', {
          channel,
        });
        return;
      }
      if (!fresh?.token || !fresh.channel) {
        rtWarn('centrifugo', 'sub token refresh failed', { channel });
        continue;
      }
      token = fresh.token;
      entry.token = fresh.token;
      // Server emits epoch ms — do not scale (see buildConnection note).
      entry.expiresAt = fresh.expires_at || Date.now() + 9 * 60_000;
    }
    try {
      await sendOnConn(conn, 'subscribe', { channel, token });
    } catch (err) {
      const e: any = err;
      const code = Number(e?.code) || 0;
      const msg = String(e?.message || '');
      // socket_closed / socket_not_open here means the underlying socket
      // died DURING the resubscribe pass. Don't log per-channel — bail
      // out of the loop. The reconnect path (onclose → scheduleReconnect)
      // already owns recovery and will run resubscribeAll again on the
      // next successful open.
      if (/socket_closed|socket_not_open/i.test(msg)) {
        rtDebug('centrifugo', 'resubscribe loop aborted — socket died mid-pass', {
          channel,
          message: msg,
        });
        return;
      }
      // Already-subscribed is BENIGN. Centrifugo emits this when the same
      // channel is in our local subTokens map AND the server still has the
      // subscription from a previous open that didn't reach onclose on our
      // side. Treat it as success and move on — do NOT fail the channel,
      // do NOT close the socket, do NOT mark inbox as error.
      const isAlreadySubscribed =
        code === 105 || /already\s*subscribed/i.test(msg);
      if (isAlreadySubscribed) {
        rtDebug('centrifugo', 're-subscribe: already subscribed (idempotent)', { channel });
        continue;
      }
      const isTokenError =
        code === 109 || /token|expired|unauthorized|401/i.test(msg);

      if (!isTokenError) {
        rtWarn('centrifugo', 're-subscribe failed', { channel, error: msg, code });
        continue;
      }

      // Token-expired path: invalidate the cached entry hard, refresh
      // once, retry the subscribe exactly once. This breaks the tight
      // loop where the cached (but server-rejected) token kept being
      // re-sent on every reconnect cycle.
      rtDebug('centrifugo', 're-subscribe token expired; forcing refresh', {
        channel,
        code,
        message: msg,
      });
      entry.expiresAt = 0;
      entry.token = '';

      const retryFresh = await entry.refresh();
      if (isStale()) {
        rtDebug('centrifugo', 'resubscribe loop aborted before token-retry — connection stale', {
          channel,
        });
        return;
      }
      if (!retryFresh?.token || !retryFresh.channel) {
        rtWarn('centrifugo', 'sub token forced refresh failed', { channel });
        continue;
      }
      entry.token = retryFresh.token;
      // Server emits epoch ms — do not scale.
      entry.expiresAt = retryFresh.expires_at || Date.now() + 9 * 60_000;

      try {
        await sendOnConn(conn, 'subscribe', { channel, token: retryFresh.token });
        rtDebug('centrifugo', 're-subscribe succeeded after token refresh', { channel });
      } catch (retryErr) {
        const re: any = retryErr;
        const reMsgEarly = String(re?.message || '');
        if (/socket_closed|socket_not_open/i.test(reMsgEarly)) {
          rtDebug('centrifugo', 'resubscribe retry aborted — socket died', {
            channel,
            message: reMsgEarly,
          });
          return;
        }
        // Same idempotency rule on retry — server may have accepted the
        // first subscribe between the rejection and our retry.
        const reCode = Number(re?.code) || 0;
        const reMsg = String(re?.message || '');
        if (reCode === 105 || /already\s*subscribed/i.test(reMsg)) {
          rtDebug('centrifugo', 're-subscribe retry: already subscribed (idempotent)', { channel });
          continue;
        }
        rtWarn('centrifugo', 're-subscribe failed after forced refresh', {
          channel,
          error: re?.message,
          code: re?.code,
        });
        // Surface to the outer reconnect path: clear the entry so the
        // next openSocket cycle re-negotiates from scratch instead of
        // hammering with the same dead state.
        entry.expiresAt = 0;
        entry.token = '';
      }
    }
  }
}

function sendOnConn(conn: SharedConnection, key: string, body: Record<string, unknown>): Promise<any> {
  return new Promise((resolve, reject) => {
    if (conn.closed || conn.ws.readyState !== 1) return reject(new Error('socket_not_open'));
    // Phase 2 — hard cap on in-flight pending callbacks. Prevents the
    // pending map from growing unboundedly during a long-running server
    // hang where replies never arrive. Drop the oldest entry (it would
    // have timed out on its own in 8s anyway).
    const { pendingMax } = getHardeningSync();
    const pendingKeys = Object.keys(conn.pending);
    if (pendingKeys.length >= pendingMax) {
      const oldestId = Number(pendingKeys[0]);
      const cb = conn.pending[oldestId];
      delete conn.pending[oldestId];
      try { cb({ error: { message: 'pending_cap_exceeded' } }); } catch { /* noop */ }
    }
    const id = conn.nextId++;
    const frame: Record<string, unknown> = { id };
    frame[key] = body;
    const timeout = setTimeout(() => {
      delete conn.pending[id];
      reject(new Error(`${key}_timeout`));
    }, 8000);
    conn.pending[id] = (reply) => {
      clearTimeout(timeout);
      if (reply?.error) {
        // Build a real Error so callers (and our reconnect heuristics) get
        // a stable `.message`. Centrifugo error shape: { code, message }.
        const e = reply.error;
        const err = new Error(e?.message || `centrifugo_error_${e?.code || 'unknown'}`);
        (err as any).code = e?.code;
        reject(err);
      }
      else resolve(reply?.[key] ?? {});
    };
    try {
      conn.ws.send(JSON.stringify(frame));
    } catch (err) {
      clearTimeout(timeout);
      delete conn.pending[id];
      reject(err);
    }
  });
}

export class CentrifugoClientProvider implements ClientRealtimeProvider {
  readonly vendor = 'centrifugo' as const;
  private negotiation: RealtimeNegotiation;

  constructor(negotiation: RealtimeNegotiation) {
    if (!negotiation.ws_url || !negotiation.token) {
      throw new Error('centrifugo_negotiation_incomplete');
    }
    this.negotiation = negotiation;
  }

  async subscribe(channel: string, handlers: RealtimeHandlers): Promise<RealtimeSubscription> {
    const parsed = parseChannel(channel);
    if (!parsed) throw new Error(`invalid_channel:${channel}`);

    const wsUrl = this.negotiation.ws_url!;
    let conn = sharedConns.get(wsUrl);
    if (!conn || conn.disposed) {
      conn = buildConnection(parsed.workspaceId, this.negotiation);
      sharedConns.set(wsUrl, conn);
    } else {
      // The cached `conn.ready` Promise is set ONCE in buildConnection() and is
      // NEVER re-assigned by scheduleReconnect → openSocket(conn). If the very
      // first openSocket attempt rejected (e.g. transient `ws_error` during a
      // network blip), every subsequent subscribe() call would `await` that
      // already-rejected Promise and surface `ws_error` forever, even after
      // the auto-reconnect loop has successfully re-opened the socket.
      //
      // Detect this case and refresh `conn.ready` to a Promise tied to the
      // CURRENT socket state:
      //   • socket already open → resolve immediately
      //   • socket closed/never opened → reuse the in-flight reconnect by
      //     awaiting the next 'open' status push (or trigger one)
      if (conn.ws && conn.ws.readyState === 1) {
        conn.ready = Promise.resolve();
      } else if (conn.closed || !conn.ws || conn.ws.readyState === 3) {
        // Either the initial open failed or the socket closed. Force a fresh
        // open cycle and bind `conn.ready` to it so this and future
        // subscribers don't keep awaiting a stale rejected Promise.
        conn.ready = new Promise<void>((resolve, reject) => {
          let settled = false;
          const onResolved = () => { if (!settled) { settled = true; resolve(); } };
          const onRejected = (e: any) => { if (!settled) { settled = true; reject(e); } };
          // Kick the reconnect loop immediately (it self-debounces via
          // reconnectTimer) and resolve once any subscriber sees 'open'.
          // We piggy-back on the existing handler fan-out by injecting a
          // synthetic listener registered against a sentinel channel slot.
          const sentinel: Set<RealtimeHandlers> = new Set();
          const handler: RealtimeHandlers = {
            onStatus: (s) => {
              if (s === 'open') {
                conn!.subs.get('__ready_sentinel')?.delete(handler);
                if (conn!.subs.get('__ready_sentinel')?.size === 0) {
                  conn!.subs.delete('__ready_sentinel');
                }
                onResolved();
              } else if (s === 'error' || s === 'closed') {
                // Don't reject — the reconnect loop will keep trying. The
                // outer caller's own onStatus will surface progress.
              }
            },
          };
          if (!conn!.subs.has('__ready_sentinel')) conn!.subs.set('__ready_sentinel', sentinel);
          conn!.subs.get('__ready_sentinel')!.add(handler);
          // Safety timeout so we never hang a subscribe() promise indefinitely.
          setTimeout(() => { onRejected(new Error('ws_open_timeout')); }, 15_000);
          scheduleReconnect(conn!);
        });
      }
      // readyState === 0 (CONNECTING) → leave existing conn.ready alone; it's
      // either the original Promise still pending its first 'open' event, or
      // a recovery Promise from this same branch on a prior call.
    }

    // Build a refresh closure so the reconnect loop can re-issue subscribe
    // tokens transparently after socket rotation / token expiry.
    const refresh = (): Promise<SubscribeResponse | null> => {
      if (parsed.kind === 'conversation') return operatorSubscribe(parsed.workspaceId, parsed.conversationId);
      if (parsed.kind === 'inbox') return operatorInboxSubscribe(parsed.workspaceId);
      if (parsed.kind === 'operators') return operatorPresenceSubscribe(parsed.workspaceId);
      return operatorVisitorsSubscribe(parsed.workspaceId);
    };

    // Compute the channel name up front. `refresh()` will return the same
    // channel string the server validates against, but we need a stable key
    // for the subs map BEFORE the network round-trip so resubscribeAll can
    // pick it up if the socket closes mid-flight.
    const expectedChannel =
      parsed.kind === 'conversation'
        ? `ws:${parsed.workspaceId}:conv:${parsed.conversationId}`
        : parsed.kind === 'inbox'
          ? `ws:${parsed.workspaceId}:inbox`
          : parsed.kind === 'operators'
            ? `ws:${parsed.workspaceId}:operators`
            : `ws:${parsed.workspaceId}:visitors`;

    handlers.onStatus?.('connecting');

    // ── Idempotency guard: if we already have a live subscription token
    //    for this channel from a prior subscribe() call (e.g. React hook
    //    re-mount, duplicate effect), DO NOT re-send the Centrifugo
    //    `subscribe` frame — the server would reject it with
    //    "already subscribed" and our error handler used to close the
    //    socket, taking down every other channel with it.
    //
    //    We still register the new handler so it receives push events,
    //    and we surface 'open' immediately if the socket is already up.
    const existingTokens = conn.subTokens.get(expectedChannel);
    const alreadySubscribed = !!(existingTokens && existingTokens.token);
    if (alreadySubscribed) {
      if (!conn.subs.has(expectedChannel)) conn.subs.set(expectedChannel, new Set());
      conn.subs.get(expectedChannel)!.add(handlers);
      if (conn.ws && conn.ws.readyState === 1) {
        handlers.onStatus?.('open');
      } else {
        // Socket is reconnecting — resubscribeAll will surface 'open' once it lands.
        handlers.onStatus?.('connecting');
      }
      rtDebug('centrifugo', 'subscribe: reusing existing channel subscription', { channel: expectedChannel });
      return buildUnsubscribe(conn, expectedChannel, handlers, this.negotiation.ws_url!);
    }

    // Register the handler + a placeholder sub-token entry IMMEDIATELY.
    // This guarantees that if the socket dies before we finish subscribing,
    // the reconnect loop's `resubscribeAll` will refresh + re-issue this
    // subscription on its own. No more "stuck on error after token expiry".
    if (!conn.subs.has(expectedChannel)) conn.subs.set(expectedChannel, new Set());
    conn.subs.get(expectedChannel)!.add(handlers);
    if (!conn.subTokens.has(expectedChannel)) {
      conn.subTokens.set(expectedChannel, {
        channel: expectedChannel,
        token: '',
        expiresAt: 0,
        refresh,
      });
    }

    // Wait for the socket. If the initial open fails, the auto-reconnect
    // loop is already armed (via onclose → scheduleReconnect) and will
    // pick up our pre-registered subscription on next success.
    try {
      await conn.ready;
    } catch (err: any) {
      handlers.onStatus?.('error', { reason: String(err?.message || err) });
      // Force a reconnect cycle so we don't sit indefinitely on a dead
      // negotiation. scheduleReconnect re-negotiates the token if needed.
      conn.tokenExpiresAt = 0;
      scheduleReconnect(conn);
      return buildUnsubscribe(conn, expectedChannel, handlers, this.negotiation.ws_url!);
    }

    // Fresh subscribe path. If it fails (e.g. server-side token expiry,
    // transient 401 from operator-subscribe) we keep the pre-registered
    // entry so the reconnect / refresh loop handles it. We never throw.
    try {
      const sub = await refresh();
      if (sub && sub.vendor === 'centrifugo' && sub.channel && sub.token) {
        // Defer-on-not-ready: if the socket isn't open at this exact
        // moment (race between conn.ready resolving and a fresh onclose),
        // do NOT throw. Cache the token; resubscribeAll will pick it up
        // on the next successful open.
        if (conn.closed || !conn.ws || conn.ws.readyState !== 1) {
          conn.subTokens.set(sub.channel, {
            channel: sub.channel,
            token: sub.token,
            // Server emits epoch ms — do not scale.
            expiresAt: sub.expires_at || Date.now() + 9 * 60_000,
            refresh,
          });
          rtDebug('centrifugo', 'subscribe deferred — socket not ready', { channel: sub.channel });
          handlers.onStatus?.('connecting');
          return buildUnsubscribe(conn, sub.channel, handlers, this.negotiation.ws_url!);
        }
        try {
          await sendOnConn(conn, 'subscribe', { channel: sub.channel, token: sub.token });
        } catch (subErr: any) {
          // Already-subscribed is benign (race with another caller / a
          // resubscribeAll that just ran). Treat as success.
          const subCode = Number(subErr?.code) || 0;
          const subMsg = String(subErr?.message || '');
          if (subCode !== 105 && !/already\s*subscribed/i.test(subMsg)) {
            throw subErr;
          }
          rtDebug('centrifugo', 'subscribe: server says already subscribed (idempotent)', { channel: sub.channel });
        }
        conn.subTokens.set(sub.channel, {
          channel: sub.channel,
          token: sub.token,
          // Server emits epoch ms — do not scale.
          expiresAt: sub.expires_at || Date.now() + 9 * 60_000,
          refresh,
        });
        // If the server returned a different channel string than we
        // pre-registered, migrate the handlers across.
        if (sub.channel !== expectedChannel) {
          const existing = conn.subs.get(expectedChannel);
          if (existing) {
            const dest = conn.subs.get(sub.channel) || new Set();
            existing.forEach((h) => dest.add(h));
            conn.subs.set(sub.channel, dest);
            conn.subs.delete(expectedChannel);
            conn.subTokens.delete(expectedChannel);
          }
        }
        handlers.onStatus?.('open');
        return buildUnsubscribe(conn, sub.channel, handlers, this.negotiation.ws_url!);
      }
      // Token negotiation failed — keep the placeholder, surface degraded
      // status, and let resubscribeAll retry on the next reconnect cycle.
      rtWarn('centrifugo', 'subscribe deferred — no token yet', { channel: expectedChannel });
      handlers.onStatus?.('error', { reason: 'subscribe_token_unavailable' });
    } catch (err: any) {
      const errMsg = String(err?.message || err);
      // socket_not_open is a transient race during reconnect — do NOT
      // surface as a hard error or kill the socket. The reconnect loop
      // owns recovery; resubscribeAll will retry our pre-registered entry.
      if (/socket_not_open/i.test(errMsg)) {
        rtDebug('centrifugo', 'subscribe deferred — socket_not_open (will retry on reconnect)', {
          channel: expectedChannel,
        });
        handlers.onStatus?.('connecting');
        return buildUnsubscribe(conn, expectedChannel, handlers, this.negotiation.ws_url!);
      }
      rtWarn('centrifugo', 'subscribe failed — will retry on reconnect', {
        channel: expectedChannel,
        error: errMsg,
      });
      handlers.onStatus?.('error', { reason: errMsg });
      // Drop the socket so the reconnect loop runs through fresh negotiation.
      conn.tokenExpiresAt = 0;
      try { conn.ws.close(); } catch { /* noop */ }
    }

    return buildUnsubscribe(conn, expectedChannel, handlers, this.negotiation.ws_url!);
  }
}

/** Shared unsubscribe builder so all early-return paths use the same logic. */
function buildUnsubscribe(
  conn: SharedConnection,
  channelKey: string,
  handlers: RealtimeHandlers,
  wsUrlForCleanup: string,
): RealtimeSubscription {
  return {
    unsubscribe: () => {
      const set = conn.subs.get(channelKey);
      if (set) {
        set.delete(handlers);
        if (set.size === 0) {
          conn.subs.delete(channelKey);
          conn.subTokens.delete(channelKey);
          // Phase 2 — release per-channel dedupe ring on unsubscribe.
          conn.seenByChannel.delete(channelKey);
          // Best-effort unsubscribe; ignore errors (socket may already be closed).
          if (conn.ws && conn.ws.readyState === 1) {
            sendOnConn(conn, 'unsubscribe', { channel: channelKey }).catch(() => {});
          }
        }
      }
      // If no channels remain, close the shared socket to free resources.
      if (conn.subs.size === 0 && !conn.disposed) {
        conn.disposed = true;
        if (conn.reconnectTimer) { clearTimeout(conn.reconnectTimer); conn.reconnectTimer = null; }
        if (conn.refreshTimer) { clearTimeout(conn.refreshTimer); conn.refreshTimer = null; }
        try {
          conn.ws?.close();
        } catch {
          /* noop */
        }
        sharedConns.delete(wsUrlForCleanup);
      }
    },
  };
}

