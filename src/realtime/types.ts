/**
 * Client-side realtime abstraction — types and contracts.
 *
 * One stable envelope for the Inbox UI regardless of underlying transport
 * (Centrifugo / Supabase Realtime / Polling).
 *
 * The shape mirrors the backend publish envelope already produced by
 * `server/services/realtime/publish.ts → buildMessageEnvelope` so callers
 * never have to branch on transport.
 */

export type RealtimeVendor = 'centrifugo' | 'supabase' | 'polling' | 'disabled';

export type NormalizedEventType = 'message' | 'typing' | 'seen';

export interface NormalizedMessagePayload {
  id: string;
  conversation_id: string;
  role: 'visitor' | 'agent' | 'system';
  /** DB enum value — preserved end-to-end so consumers can distinguish AI. */
  sender_type: 'agent' | 'contact' | 'system' | 'bot' | 'ai';
  text: string;
  body: string;
  time: string | null;
  created_at: string | null;
  seen_at: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface NormalizedEvent {
  type: NormalizedEventType;
  /** Always shaped like the backend envelope payload. */
  payload: NormalizedMessagePayload | Record<string, unknown>;
}

export interface RealtimeHandlers {
  onMessage?: (payload: NormalizedMessagePayload) => void;
  onTyping?: (payload: Record<string, unknown>) => void;
  onSeen?: (payload: Record<string, unknown>) => void;
  /** Lifecycle (optional, advisory). Adapters MAY emit. UI MAY ignore. */
  onStatus?: (status: 'connecting' | 'open' | 'closed' | 'error', info?: { reason?: string }) => void;
}

export interface RealtimeSubscription {
  unsubscribe(): void;
}

/**
 * Narrow contract — every adapter must satisfy this.
 *
 * `subscribe` is the only mandatory operation; lifecycle is implicit.
 * Adapters open the underlying connection lazily on first subscribe and
 * tear it down when the last subscription is released.
 */
export interface ClientRealtimeProvider {
  readonly vendor: RealtimeVendor;
  subscribe(channel: string, handlers: RealtimeHandlers): Promise<RealtimeSubscription>;
}

/**
 * Resolution context returned by the server's negotiation endpoint
 * (`POST /api/realtime/operator-connect`). The resolver dispatches on
 * `vendor` and passes the rest to the chosen adapter.
 */
export interface RealtimeNegotiation {
  vendor: RealtimeVendor;
  /** Centrifugo only. */
  ws_url?: string;
  /** Centrifugo connection token (short-lived). */
  token?: string;
  expires_at?: number;
  capabilities?: Record<string, boolean>;
}
