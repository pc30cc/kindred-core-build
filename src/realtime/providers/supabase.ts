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
 *
 * The Supabase connection itself comes from ./supabaseConnection — the
 * project URL and anon key are the server's to give, never compiled in.
 */

import { getSupabaseRealtimeClient, type RealtimeChannelLike } from './supabaseConnection';
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

/**
 * One joined Supabase channel per topic, shared by every subscriber of it.
 * The Supabase client hands back the SAME channel object for a topic it has
 * already joined, and removeChannel() leaves that topic for everyone, so two
 * subscriptions of one channel (the inbox list and an open thread both hear
 * `ws:<ws>:inbox`) must share a join: the broadcast bindings are made once
 * and fan out to each subscriber, and the topic is left with the last one.
 */
interface SharedTopic {
  ch: RealtimeChannelLike;
  handlers: Set<RealtimeHandlers>;
  /** The status of the join once it settled ('open', 'closed' or 'error'). */
  joined: Promise<'open' | 'closed' | 'error'>;
  reason?: string;
}

const sharedTopics = new Map<string, SharedTopic>();

function joinTopic(
  supabase: NonNullable<Awaited<ReturnType<typeof getSupabaseRealtimeClient>>>,
  topic: string,
): SharedTopic {
  const ch: RealtimeChannelLike = supabase.channel(topic, {
    config: { broadcast: { self: false, ack: false } },
  });
  const handlers = new Set<RealtimeHandlers>();
  const each = (fn: (h: RealtimeHandlers) => void) => handlers.forEach((h) => fn(h));

  ch.on('broadcast', { event: 'message' }, (msg: BroadcastMessage) => {
    const payload = unwrap(msg);
    if (payload) each((h) => h.onMessage?.(payload as unknown as NormalizedMessagePayload));
  });
  ch.on('broadcast', { event: 'typing' }, (msg: BroadcastMessage) => {
    const payload = unwrap(msg) ?? {};
    each((h) => h.onTyping?.(payload));
  });
  ch.on('broadcast', { event: 'seen' }, (msg: BroadcastMessage) => {
    const payload = unwrap(msg) ?? {};
    each((h) => h.onSeen?.(payload));
  });
  // Phase 5 — operator-only event envelope. Forward-safe.
  ch.on('broadcast', { event: 'event' }, (msg: BroadcastMessage) => {
    const payload = unwrap(msg);
    if (payload) each((h) => h.onEvent?.(payload as unknown as OperatorEventPayload));
  });

  const shared: SharedTopic = { ch, handlers, joined: Promise.resolve('open') };
  shared.joined = new Promise((resolve) => {
    let settled = false;
    ch.subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        if (settled) each((h) => h.onStatus?.('open'));
        settled = true;
        resolve('open');
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        const next = status === 'CLOSED' ? 'closed' : 'error';
        shared.reason = status;
        // A closed channel is not joined again by itself: the next
        // subscriber of the topic joins afresh.
        if (status === 'CLOSED' && sharedTopics.get(topic) === shared) sharedTopics.delete(topic);
        // Later changes reach every subscriber; the first one is reported
        // to each as it subscribes. Don't block — the caller already
        // considers polling fallback elsewhere.
        if (settled) each((h) => h.onStatus?.(next, { reason: status }));
        settled = true;
        resolve(next);
      }
    });
  });
  return shared;
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

    const supabase = await getSupabaseRealtimeClient();
    if (!supabase) {
      handlers.onStatus?.('error', { reason: 'supabase_realtime_unavailable' });
      return { unsubscribe: () => { /* nothing was joined */ } };
    }

    let shared = sharedTopics.get(topic);
    if (!shared) {
      shared = joinTopic(supabase, topic);
      sharedTopics.set(topic, shared);
    }
    const mine = shared;
    mine.handlers.add(handlers);
    const status = await mine.joined;
    if (status === 'open') handlers.onStatus?.('open');
    else handlers.onStatus?.(status, { reason: mine.reason });

    let left = false;
    return {
      unsubscribe: () => {
        if (left) return;
        left = true;
        mine.handlers.delete(handlers);
        if (mine.handlers.size === 0 && sharedTopics.get(topic) === mine) {
          sharedTopics.delete(topic);
          try {
            void supabase.removeChannel(mine.ch);
          } catch {
            /* noop */
          }
        }
        handlers.onStatus?.('closed');
      },
    };
  }
}
