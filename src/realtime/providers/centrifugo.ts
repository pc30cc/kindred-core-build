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

const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined) || '';

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

/** Parse `ws:<workspaceId>:conv:<conversationId>` → ids. */
function parseChannel(channel: string): { workspaceId: string; conversationId: string } | null {
  const m = /^ws:([^:]+):conv:(.+)$/.exec(channel);
  if (!m) return null;
  return { workspaceId: m[1], conversationId: m[2] };
}

/** Per-tab connection cache keyed by ws_url so we share one socket. */
interface SharedConnection {
  ws: WebSocket;
  ready: Promise<void>;
  nextId: number;
  pending: Record<number, (reply: any) => void>;
  subs: Map<string, Set<RealtimeHandlers>>; // channel → handlers
  closed: boolean;
}

const sharedConns = new Map<string, SharedConnection>();

function buildConnection(negotiation: RealtimeNegotiation): SharedConnection {
  const ws = new WebSocket(negotiation.ws_url!);
  const conn: SharedConnection = {
    ws,
    nextId: 1,
    pending: {},
    subs: new Map(),
    closed: false,
    ready: new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', async () => {
        try {
          await sendOnConn(conn, 'connect', { token: negotiation.token!, name: 'inbox' });
          resolve();
        } catch (err) {
          reject(err);
        }
      });
      ws.addEventListener('error', () => reject(new Error('ws_error')));
    }),
  };

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
        }
      }
    }
  };
  ws.onclose = () => {
    conn.closed = true;
    conn.subs.forEach((set) => set.forEach((h) => h.onStatus?.('closed')));
  };
  ws.onerror = () => {
    conn.subs.forEach((set) => set.forEach((h) => h.onStatus?.('error')));
  };

  return conn;
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

    const sub = await operatorSubscribe(parsed.workspaceId, parsed.conversationId);
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
