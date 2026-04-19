/**
 * Inbox realtime subscription — provider-driven.
 *
 * Subscribes the operator inbox to the SAME conversation channel the
 * visitor widget listens to (`ws:<workspace_id>:conv:<conversation_id>`)
 * via the globally configured realtime provider.
 *
 * Architecture:
 *   1. Calls POST /api/realtime/connect to discover the active vendor
 *      and obtain a short-lived connection token (Centrifugo) — same
 *      endpoint the widget uses, so there is exactly one realtime
 *      negotiation path.
 *   2. If vendor === 'centrifugo', opens a raw WebSocket using the
 *      Centrifugo v5 bidirectional JSON protocol (mirrors
 *      public/widget/runtime-rt-centrifugo.js).
 *   3. POST /api/realtime/subscribe → per-channel subscription token,
 *      then sends the `subscribe` command.
 *   4. On `message` push, calls onMessage with the decoded payload.
 *
 * If vendor !== 'centrifugo' (polling/disabled), the hook does nothing
 * and the existing React Query polling path continues to deliver
 * messages — graceful degradation.
 *
 * No hardcoded Supabase realtime. No edge-function dependency.
 */

import { useEffect, useRef } from 'react';
import { supabase } from '@/lib/supabase';

const API_BASE = import.meta.env.VITE_API_BASE_URL || '';

interface ConnectResponse {
  vendor: 'centrifugo' | 'polling_builtin' | 'disabled';
  ws_url?: string;
  token?: string;
  expires_at?: number;
  capabilities?: Record<string, boolean>;
}

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
 * Operator-side realtime: uses the workspace member's Supabase JWT to
 * negotiate a Centrifugo connection. Server route accepts either a
 * widget session token (visitor) or a workspace member JWT (operator).
 *
 * NOTE: The current /api/realtime/connect requires X-Widget-Token. To
 * keep this PR small and avoid breaking the widget contract, we route
 * the operator subscription through a thin operator-specific path:
 * POST /api/realtime/operator-connect (added below). If that endpoint
 * is missing, we fall back to silent no-op and React Query polling
 * continues to drive the inbox UI — never a hard failure.
 */
async function operatorConnect(workspaceId: string): Promise<ConnectResponse | null> {
  try {
    const res = await fetch(`${API_BASE}/api/realtime/operator-connect`, {
      method: 'POST',
      headers: await authHeaders(),
      body: JSON.stringify({ workspace_id: workspaceId }),
    });
    if (!res.ok) return null;
    return (await res.json()) as ConnectResponse;
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

export interface InboxRealtimeOptions {
  workspaceId: string | undefined;
  conversationId: string | undefined;
  onMessage: (payload: unknown) => void;
  onTyping?: (payload: unknown) => void;
  enabled?: boolean;
}

/**
 * Subscribe the inbox to the conversation channel via the active realtime
 * provider. Returns nothing — side-effect only. Cleans up on unmount and
 * when conversationId changes.
 */
export function useInboxRealtime(opts: InboxRealtimeOptions) {
  const { workspaceId, conversationId, onMessage, onTyping, enabled = true } = opts;
  const handlersRef = useRef({ onMessage, onTyping });
  handlersRef.current = { onMessage, onTyping };

  useEffect(() => {
    if (!enabled || !workspaceId || !conversationId) return;

    let ws: WebSocket | null = null;
    let cancelled = false;
    let nextId = 1;
    const pending: Record<number, (reply: any) => void> = {};

    const send = (key: string, body: Record<string, unknown>): Promise<any> =>
      new Promise((resolve, reject) => {
        if (!ws || ws.readyState !== 1) return reject(new Error('socket_not_open'));
        const id = nextId++;
        const frame: Record<string, unknown> = { id };
        frame[key] = body;
        const timeout = setTimeout(() => {
          delete pending[id];
          reject(new Error(`${key}_timeout`));
        }, 8000);
        pending[id] = (reply) => {
          clearTimeout(timeout);
          if (reply?.error) reject(reply.error);
          else resolve(reply?.[key] ?? {});
        };
        try {
          ws.send(JSON.stringify(frame));
        } catch (err) {
          clearTimeout(timeout);
          delete pending[id];
          reject(err);
        }
      });

    (async () => {
      const conn = await operatorConnect(workspaceId);
      if (cancelled || !conn || conn.vendor !== 'centrifugo' || !conn.ws_url || !conn.token) {
        // Polling/disabled or operator-connect endpoint not available →
        // silent no-op, polling already covers the inbox UI.
        return;
      }
      try {
        ws = new WebSocket(conn.ws_url);
      } catch {
        return;
      }
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
          // Server keepalive (empty object) → echo.
          if (!frame.id && !frame.push && !frame.error) {
            try {
              ws?.send('{}');
            } catch { }
            continue;
          }
          if (frame.id && pending[frame.id]) {
            const cb = pending[frame.id];
            delete pending[frame.id];
            cb(frame);
            continue;
          }
          if (frame.push?.pub?.data) {
            const data = frame.push.pub.data;
            if (data?.type === 'message') {
              handlersRef.current.onMessage?.(data.payload);
            } else if (data?.type === 'typing') {
              handlersRef.current.onTyping?.(data.payload);
            }
          }
        }
      };
      ws.onopen = async () => {
        try {
          await send('connect', { token: conn.token!, name: 'inbox' });
          const sub = await operatorSubscribe(workspaceId, conversationId);
          if (!sub || sub.vendor !== 'centrifugo' || !sub.channel || !sub.token) return;
          await send('subscribe', { channel: sub.channel, token: sub.token });
        } catch (err) {
          console.warn('[inbox-rt] connect/subscribe failed', err);
        }
      };
      ws.onclose = () => {
        ws = null;
      };
      ws.onerror = () => {
        // Centrifugo unreachable from the operator's network →
        // polling continues to deliver messages.
      };
    })();

    return () => {
      cancelled = true;
      if (ws) {
        try {
          ws.close();
        } catch { }
        ws = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, conversationId, enabled]);
}
