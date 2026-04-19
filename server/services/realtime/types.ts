/**
 * Realtime Provider Types — global, admin-controlled.
 * No workspace-level overrides in this phase.
 */

export type RealtimeVendor = 'centrifugo' | 'supabase' | 'polling_builtin' | 'disabled';
export type FallbackPolicy = 'lenient' | 'strict';

export interface RealtimeCapabilities {
  supportsRealtime: boolean;
  supportsTyping: boolean;
  supportsPresence: boolean;
  supportsHistoryLoad: boolean;
  supportsReconnectSignals: boolean;
}

export interface CentrifugoConfig {
  ws_url: string;            // public websocket url given to clients (wss://...)
  api_url: string;           // server-to-server HTTP API url (http://centrifugo:8000/api)
  api_key: string;           // server-to-server admin API key
  token_hmac_secret: string; // HMAC secret shared with Centrifugo for connection JWTs
  allowed_origins?: string[];
  connect_timeout_ms?: number;
  subscribe_timeout_ms?: number;
  presence_enabled?: boolean;
  typing_enabled?: boolean;
  token_ttl_seconds?: number;
}

export interface RealtimeProviderConfig {
  vendor: RealtimeVendor;
  enabled: boolean;
  fallback_policy: FallbackPolicy;            // 'lenient' (default) | 'strict'
  fallback_vendor: 'polling_builtin' | null;
  centrifugo?: Partial<CentrifugoConfig>;
}

export interface ResolvedRealtimeProvider {
  effective_vendor: RealtimeVendor;
  source: 'global_default' | 'fallback' | 'disabled' | 'failed_closed';
  capabilities: RealtimeCapabilities;
  /** Public-only fields. Never includes secrets. */
  public_config: {
    ws_url?: string;
    allowed_origins?: string[];
    connect_timeout_ms?: number;
    subscribe_timeout_ms?: number;
    presence_enabled?: boolean;
    typing_enabled?: boolean;
  };
  fallback_policy: FallbackPolicy;
  health: {
    status: 'healthy' | 'degraded' | 'down' | 'unknown';
    checked_at?: number;
    message?: string;
  };
}

export const POLLING_CAPABILITIES: RealtimeCapabilities = {
  supportsRealtime: false,
  supportsTyping: false,
  supportsPresence: false,
  supportsHistoryLoad: true,
  supportsReconnectSignals: true,
};

export const CENTRIFUGO_CAPABILITIES: RealtimeCapabilities = {
  supportsRealtime: true,
  supportsTyping: true,
  supportsPresence: true,
  supportsHistoryLoad: true,
  supportsReconnectSignals: true,
};

export const DISABLED_CAPABILITIES: RealtimeCapabilities = {
  supportsRealtime: false,
  supportsTyping: false,
  supportsPresence: false,
  supportsHistoryLoad: true,   // history is REST, always available
  supportsReconnectSignals: false,
};

/** Build a multi-tenant safe channel name for per-conversation traffic. */
export function buildChannelName(workspaceId: string, conversationId: string): string {
  // Explicit, readable, multi-tenant safe.
  // ws:{workspace_id}:conv:{conversation_id}
  return `ws:${workspaceId}:conv:${conversationId}`;
}

/**
 * Build the operator-only inbox channel name for a workspace.
 * Carries `event` envelopes for conversation-list updates (status, priority,
 * assignee, tags). Widget tokens MUST NOT be issuable for this channel.
 */
export function buildInboxChannelName(workspaceId: string): string {
  return `ws:${workspaceId}:inbox`;
}

/** Validate that a channel name belongs to the given workspace. */
export function channelBelongsToWorkspace(channel: string, workspaceId: string): boolean {
  return channel.startsWith(`ws:${workspaceId}:`);
}

/**
 * Returns true iff the channel is the operator-only inbox channel for the
 * given workspace. Used by token issuers to refuse minting widget tokens
 * for this channel.
 */
export function isInboxChannel(channel: string, workspaceId: string): boolean {
  return channel === `ws:${workspaceId}:inbox`;
}
