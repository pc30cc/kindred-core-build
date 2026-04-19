/**
 * Public entry point for the client-side realtime abstraction.
 *
 * Inbox-only on day one. Do not import these from the visitor widget
 * runtime (which has its own transport for bundle-size reasons).
 */
export type {
  ClientRealtimeProvider,
  NormalizedEvent,
  NormalizedEventType,
  NormalizedMessagePayload,
  RealtimeHandlers,
  RealtimeNegotiation,
  RealtimeSubscription,
  RealtimeVendor,
} from './types';
export { resolveClientRealtimeProvider } from './resolveClientRealtimeProvider';
export { CentrifugoClientProvider } from './providers/centrifugo';
export { SupabaseRealtimeClientProvider } from './providers/supabase';
export { PollingClientProvider } from './providers/polling';
