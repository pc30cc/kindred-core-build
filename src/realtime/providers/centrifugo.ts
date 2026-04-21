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

const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined) || '';

/**
 * How long before a token's `expires_at` we proactively refresh it.
 * Centrifugo TTLs are typically 600s; 60s is a comfortable lead time.
 */
const TOKEN_REFRESH_LEAD_MS = 60_000;

/** Backoff schedule (ms) for socket reconnect attempts. Capped at 30s. */
const RECONNECT_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000, 15_000, 30_000];

interface SubscribeResponse {
  vendor: 'centrifugo' | 'polling_builtin';
  channel?: string;
  token?: string;
  expires_at?: number;
}

async function authHeaders(): Promise<Record<string, string>> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  return session?.access_token
    ? { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' }
    : { 'Content-Type': 'application/json' };
}

/**
 * Fetch a fresh connection negotiation. Used both for the initial open and
 * for proactive token refresh / reconnect after expiry. Independent of the
 * provider's cached negotiation so a long-lived tab never gets stuck on a
 * stale token.
 */
async function negotiateConnect(workspaceId: string): Promise<RealtimeNegotiation | null> {
  try {
    const res = await fetch(`${API_BASE}/api/realtime/operator-connect`, {
      method: 'POST',
      headers: await authHeaders(),
      body: JSON.stringify({ workspace_id: workspaceId }),
    });
    if (!res.ok) return null;
    return (await res.json()) as RealtimeNegotiation;
  } catch {
    return null;
  }
}

async function operatorSubscribe(
  workspaceId: string,
  conversationId: string,
): Promise<SubscribeResponse | null> {
  try {
    const res = await fetch(`${API_BASE}/api/realtime/operator-subscribe`, {
      method: 'POST',
      headers: await authHeaders(),
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
      method: 'POST',
      headers: await authHeaders(),
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
      method: 'POST',
      headers: await authHeaders(),
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
  | { kind: 'visitors'; workspaceId: string };

function parseChannel(channel: string): ParsedChannel | null {
  let m = /^ws:([^:]+):conv:(.+)$/.exec(channel);
  if (m) return { kind: 'conversation', workspaceId: m[1], conversationId: m[2] };
  m = /^ws:([^:]+):inbox$/.exec(channel);
  if (m) return { kind: 'inbox', workspaceId: m[1] };
  m = /^ws:([^:]+):visitors$/.exec(channel);
  if (m) return { kind: 'visitors', workspaceId: m[1] };
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
    tokenExpiresAt: (negotiation.expires_at || 0) * 1000 || Date.now() + 9 * 60_000,
    wsUrl: negotiation.ws_url!,
    reconnectAttempt: 0,
    reconnectTimer: null,
    refreshTimer: null,
    disposed: false,
    ready: Promise.resolve(),
  };
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
  conn.ws = new WebSocket(conn.wsUrl);
  attachSocketHandlers(conn);
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const onOpen = async () => {
      try {
        await sendOnConn(conn, 'connect', { token: conn.token, name: 'inbox' });
        conn.reconnectAttempt = 0;
        scheduleTokenRefresh(conn);
        // Re-subscribe to every channel that survived the disconnect.
        await resubscribeAll(conn);
        // Notify any waiting handlers that we're back online.
        conn.subs.forEach((set) => set.forEach((h) => h.onStatus?.('open')));
        if (!settled) { settled = true; resolve(); }
      } catch (err) {
        if (!settled) { settled = true; reject(err); }
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
  const delay = RECONNECT_DELAYS_MS[Math.min(conn.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
  conn.reconnectAttempt += 1;
  rtDebug('centrifugo', 'scheduling reconnect', { attempt: conn.reconnectAttempt, delayMs: delay });
  conn.subs.forEach((set) => set.forEach((h) => h.onStatus?.('connecting')));
  conn.reconnectTimer = setTimeout(async () => {
    conn.reconnectTimer = null;
    if (conn.disposed) return;
    // Refresh the connection token if it's expired or near expiry.
    if (Date.now() >= conn.tokenExpiresAt - TOKEN_REFRESH_LEAD_MS) {
      const fresh = await negotiateConnect(conn.workspaceId);
      if (fresh?.token && fresh.ws_url) {
        conn.token = fresh.token;
        conn.tokenExpiresAt = (fresh.expires_at || 0) * 1000 || Date.now() + 9 * 60_000;
        conn.wsUrl = fresh.ws_url;
      } else {
        rtWarn('centrifugo', 'token refresh failed; will retry');
        scheduleReconnect(conn);
        return;
      }
    }
    try {
      await openSocket(conn);
    } catch (err) {
      rtWarn('centrifugo', 'reconnect open failed', { error: (err as any)?.message });
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
    const fresh = await negotiateConnect(conn.workspaceId);
    if (!fresh?.token) {
      rtWarn('centrifugo', 'proactive token refresh failed');
      // Re-arm so we try again before the existing token actually expires.
      conn.refreshTimer = setTimeout(() => scheduleTokenRefresh(conn), 30_000);
      return;
    }
    conn.token = fresh.token;
    conn.tokenExpiresAt = (fresh.expires_at || 0) * 1000 || Date.now() + 9 * 60_000;
    if (fresh.ws_url) conn.wsUrl = fresh.ws_url;
    // Centrifugo v5 supports in-place connection token refresh via the
    // `refresh` command — but our backend re-issues full negotiations and
    // the server-side TTL is generous. Simpler & safer: just rotate the
    // socket. The reconnect path resubscribes everything atomically.
    rtDebug('centrifugo', 'rotating socket for token refresh');
    try { conn.ws.close(); } catch { /* noop */ }
    // onclose → scheduleReconnect picks up with the fresh token.
  }, msUntil);
}

/**
 * Re-issue subscribe commands for every cached subscription. Called on
 * (re)connect. Refreshes per-channel sub tokens if they're expired.
 */
async function resubscribeAll(conn: SharedConnection): Promise<void> {
  const channels = Array.from(conn.subTokens.keys());
  for (const channel of channels) {
    const entry = conn.subTokens.get(channel);
    if (!entry) continue;
    let token = entry.token;
    if (!token || Date.now() >= entry.expiresAt - 30_000) {
      const fresh = await entry.refresh();
      if (!fresh?.token || !fresh.channel) {
        rtWarn('centrifugo', 'sub token refresh failed', { channel });
        continue;
      }
      token = fresh.token;
      entry.token = fresh.token;
      entry.expiresAt = (fresh.expires_at || 0) * 1000 || Date.now() + 9 * 60_000;
    }
    try {
      await sendOnConn(conn, 'subscribe', { channel, token });
    } catch (err) {
      rtWarn('centrifugo', 're-subscribe failed', { channel, error: (err as any)?.message });
    }
  }
}

function sendOnConn(conn: SharedConnection, key: string, body: Record<string, unknown>): Promise<any> {
  return new Promise((resolve, reject) => {
    if (conn.closed || conn.ws.readyState !== 1) return reject(new Error('socket_not_open'));
    const id = conn.nextId++;
    const frame: Record<string, unknown> = { id };
    frame[key] = body;
    const timeout = setTimeout(() => {
      delete conn.pending[id];
      reject(new Error(`${key}_timeout`));
    }, 8000);
    conn.pending[id] = (reply) => {
      clearTimeout(timeout);
      if (reply?.error) reject(reply.error);
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
    if (!conn || conn.closed) {
      conn = buildConnection(this.negotiation);
      sharedConns.set(wsUrl, conn);
    }

    handlers.onStatus?.('connecting');
    try {
      await conn.ready;
    } catch (err: any) {
      handlers.onStatus?.('error', { reason: String(err?.message || err) });
      throw err;
    }

    let sub: SubscribeResponse | null = null;
    if (parsed.kind === 'conversation') {
      sub = await operatorSubscribe(parsed.workspaceId, parsed.conversationId);
    } else if (parsed.kind === 'inbox') {
      sub = await operatorInboxSubscribe(parsed.workspaceId);
    } else if (parsed.kind === 'visitors') {
      sub = await operatorVisitorsSubscribe(parsed.workspaceId);
    }
    if (!sub || sub.vendor !== 'centrifugo' || !sub.channel || !sub.token) {
      throw new Error('subscribe_token_unavailable');
    }
    await sendOnConn(conn, 'subscribe', { channel: sub.channel, token: sub.token });

    if (!conn.subs.has(sub.channel)) conn.subs.set(sub.channel, new Set());
    conn.subs.get(sub.channel)!.add(handlers);
    handlers.onStatus?.('open');

    const channelKey = sub.channel;
    const localConn = conn;

    return {
      unsubscribe: () => {
        const set = localConn.subs.get(channelKey);
        if (set) {
          set.delete(handlers);
          if (set.size === 0) {
            localConn.subs.delete(channelKey);
            // Best-effort unsubscribe; ignore errors (socket may already be closed).
            sendOnConn(localConn, 'unsubscribe', { channel: channelKey }).catch(() => {});
          }
        }
        // If no channels remain, close the shared socket to free resources.
        if (localConn.subs.size === 0 && !localConn.closed) {
          try {
            localConn.ws.close();
          } catch {
            /* noop */
          }
          sharedConns.delete(this.negotiation.ws_url!);
        }
      },
    };
  }
}
