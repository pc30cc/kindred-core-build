/**
 * Supabase Realtime adapter (operator console).
 *
 * Callers keep using the canonical channel names
 * (`ws:<workspace_id>:conv:<conversation_id>`, `ws:<workspace_id>:inbox`,
 * `ws:<workspace_id>:visitors`, `ws:<workspace_id>:operators`) and the SAME
 * envelope shape the backend publishes
 * (`{ type: 'message' | 'typing' | 'seen' | 'event', payload }`).
 *
 * SECURITY — the canonical name is NOT the Supabase topic. Broadcast
 * channels are public (anon key, no Supabase Auth), so the server publishes
 * on unguessable HMAC-derived topics instead
 * (`server/services/realtime/channelTopic.ts`). This adapter asks the
 * authenticated operator endpoint that matches the channel kind
 * (`/api/realtime/operator-*-subscribe` with `transport: 'supabase'`,
 * session cookie + workspace membership enforced server-side) for the
 * concrete topic, then joins it. The topic is never computed client-side.
 * If the server refuses or is unreachable, the subscription reports
 * `error` and the React Query polling fallback keeps the UI correct.
 */

import { supabase } from '@/lib/supabase';
import { API_BASE as RESOLVED_API_BASE } from '@/lib/apiBase';
import type {
  ClientRealtimeProvider,
  NormalizedMessagePayload,
  OperatorEventPayload,
  RealtimeHandlers,
  RealtimeSubscription,
} from '../types';

const API_BASE = (RESOLVED_API_BASE as string | undefined) || '';

type ParsedChannel =
  | { kind: 'conversation'; workspaceId: string; conversationId: string }
  | { kind: 'inbox' | 'visitors' | 'operators'; workspaceId: string };

/** Map a canonical channel name onto the endpoint that authorizes it. */
export function parseSupabaseChannel(channel: string): ParsedChannel | null {
  let m = /^ws:([^:]+):conv:([^:]+)$/.exec(channel);
  if (m) return { kind: 'conversation', workspaceId: m[1], conversationId: m[2] };
  m = /^ws:([^:]+):(inbox|visitors|operators)$/.exec(channel);
  if (m) return { kind: m[2] as 'inbox' | 'visitors' | 'operators', workspaceId: m[1] };
  return null;
}

const ENDPOINT_BY_KIND: Record<ParsedChannel['kind'], string> = {
  conversation: '/api/realtime/operator-subscribe',
  inbox: '/api/realtime/operator-inbox-subscribe',
  visitors: '/api/realtime/operator-visitors-subscribe',
  operators: '/api/realtime/operator-presence-subscribe',
};

/**
 * Ask the server for the concrete Supabase topic of an authorized channel.
 * Returns null on any refusal / failure (never throws).
 */
export async function fetchSupabaseTopic(channel: string): Promise<string | null> {
  const parsed = parseSupabaseChannel(channel);
  if (!parsed) return null;
  const body: Record<string, string> = { workspace_id: parsed.workspaceId, transport: 'supabase' };
  if (parsed.kind === 'conversation') body.conversation_id = parsed.conversationId;
  try {
    const res = await fetch(`${API_BASE}${ENDPOINT_BY_KIND[parsed.kind]}`, {
      credentials: 'include',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { vendor?: string; channel?: string; topic?: string } | null;
    if (!data || data.vendor !== 'supabase' || typeof data.topic !== 'string' || !data.topic) return null;
    // The topic must be an extension of the channel we asked for — never
    // join something the server did not derive for THIS channel.
    if (!data.topic.startsWith(`${channel}:`)) return null;
    return data.topic;
  } catch {
    return null;
  }
}

interface BroadcastMessage {
  payload?: unknown;
}

function unwrap(msg: BroadcastMessage | null | undefined): Record<string, unknown> | null {
  const outer = msg?.payload;
  if (outer && typeof outer === 'object') {
    const inner = (outer as { payload?: unknown }).payload;
    if (inner && typeof inner === 'object') return inner as Record<string, unknown>;
    return outer as Record<string, unknown>;
  }
  return null;
}

export class SupabaseRealtimeClientProvider implements ClientRealtimeProvider {
  readonly vendor = 'supabase' as const;

  async subscribe(channel: string, handlers: RealtimeHandlers): Promise<RealtimeSubscription> {
    handlers.onStatus?.('connecting');

    const topic = await fetchSupabaseTopic(channel);
    if (!topic) {
      handlers.onStatus?.('error', { reason: 'topic_unavailable' });
      return { unsubscribe: () => { /* nothing was joined */ } };
    }

    const ch = supabase.channel(topic, {
      config: { broadcast: { self: false, ack: false } },
    });

    ch.on('broadcast', { event: 'message' }, (msg: BroadcastMessage) => {
      const payload = unwrap(msg);
      if (payload) handlers.onMessage?.(payload as unknown as NormalizedMessagePayload);
    });
    ch.on('broadcast', { event: 'typing' }, (msg: BroadcastMessage) => {
      handlers.onTyping?.(unwrap(msg) ?? {});
    });
    ch.on('broadcast', { event: 'seen' }, (msg: BroadcastMessage) => {
      handlers.onSeen?.(unwrap(msg) ?? {});
    });
    // Phase 5 — operator-only event envelope. Forward-safe.
    ch.on('broadcast', { event: 'event' }, (msg: BroadcastMessage) => {
      const payload = unwrap(msg);
      if (payload) handlers.onEvent?.(payload as unknown as OperatorEventPayload);
    });

    await new Promise<void>((resolve) => {
      ch.subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          handlers.onStatus?.('open');
          resolve();
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          handlers.onStatus?.(status === 'CLOSED' ? 'closed' : 'error', { reason: status });
          resolve(); // Don't block — caller already considers polling fallback elsewhere.
        }
      });
    });

    return {
      unsubscribe: () => {
        try {
          void supabase.removeChannel(ch);
        } catch {
          /* noop */
        }
        handlers.onStatus?.('closed');
      },
    };
  }
}
