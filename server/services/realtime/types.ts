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

/**
 * Deployment topology of the Centrifugo layer.
 *
 *  • single_memory      — one Centrifugo, memory engine, no Redis.
 *                         The historical (and default) shape. Any config
 *                         written before topology existed normalizes here.
 *  • app_routed_redis   — N Centrifugo nodes sharing one Redis engine. The
 *                         backend picks a node and returns THAT node's
 *                         ws_url; the browser still connects DIRECTLY to
 *                         Centrifugo (never through the backend).
 *  • load_balanced_redis— N Centrifugo nodes sharing one Redis engine behind
 *                         a single public load balancer URL. The client only
 *                         ever sees the LB URL.
 */
export type CentrifugoDeploymentMode =
  | 'single_memory'
  | 'app_routed_redis'
  | 'load_balanced_redis';

export const CENTRIFUGO_DEPLOYMENT_MODES: CentrifugoDeploymentMode[] = [
  'single_memory',
  'app_routed_redis',
  'load_balanced_redis',
];

/** Operational state of a single Centrifugo node. */
export type CentrifugoNodeHealthStatus =
  | 'healthy'
  | 'degraded'
  | 'down'
  | 'draining'
  | 'maintenance'
  | 'unknown';

/**
 * One Centrifugo node in an `app_routed_redis` (or `load_balanced_redis`
 * operational view) cluster.
 *
 * Secrets are deliberately ABSENT: every node of a cluster shares the
 * cluster-level `token_hmac_secret` + `api_key` from CentrifugoConfig, so a
 * JWT minted by this backend is accepted by any node. Redis credentials are
 * never stored here — Redis is Centrifugo's own infrastructure dependency.
 */
export interface CentrifugoNode {
  id: string;                  // stable node id, e.g. "rt-node-01"
  name: string;                // display name
  ws_url: string;              // public websocket url handed to browsers
  api_url: string;             // server-to-server HTTP API url
  enabled: boolean;            // admin master switch for this node
  accepting_new_connections: boolean;
  draining: boolean;           // no NEW connections; existing ones untouched
  weight: number;              // relative selection weight (>= 0)
  region?: string;
  created_at?: string;
  updated_at?: string;
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

  // ── Topology (additive; absent ⇒ single_memory) ────────────────────
  deployment_mode?: CentrifugoDeploymentMode;
  /** Node registry — only meaningful for multi-node modes. */
  nodes?: CentrifugoNode[];
  /** Public LB websocket url — only meaningful for load_balanced_redis. */
  load_balancer_ws_url?: string;
}

export interface RealtimeProviderConfig {
  vendor: RealtimeVendor;
  enabled: boolean;
  fallback_policy: FallbackPolicy;            // 'lenient' (default) | 'strict'
  fallback_vendor: 'polling_builtin' | null;
  centrifugo?: Partial<CentrifugoConfig>;
}

/** Effective deployment mode of a (possibly legacy) config. Never throws. */
export function resolveDeploymentMode(
  cfg?: Partial<CentrifugoConfig> | null
): CentrifugoDeploymentMode {
  const mode = cfg?.deployment_mode;
  return mode && CENTRIFUGO_DEPLOYMENT_MODES.includes(mode) ? mode : 'single_memory';
}

/** Normalize an arbitrary stored node record into a complete CentrifugoNode. */
export function normalizeNode(raw: unknown, index = 0): CentrifugoNode | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const ws_url = typeof r.ws_url === 'string' ? r.ws_url.trim() : '';
  const api_url = typeof r.api_url === 'string' ? r.api_url.trim() : '';
  if (!ws_url || !api_url) return null;
  const rawWeight = Number(r.weight);
  return {
    id: typeof r.id === 'string' && r.id.trim() ? r.id.trim() : `rt-node-${String(index + 1).padStart(2, '0')}`,
    name: typeof r.name === 'string' && r.name.trim() ? r.name.trim() : `Node ${index + 1}`,
    ws_url,
    api_url,
    enabled: r.enabled !== false,
    accepting_new_connections: r.accepting_new_connections !== false,
    draining: r.draining === true,
    weight: Number.isFinite(rawWeight) && rawWeight >= 0 ? rawWeight : 1,
    region: typeof r.region === 'string' && r.region.trim() ? r.region.trim() : undefined,
    created_at: typeof r.created_at === 'string' ? r.created_at : undefined,
    updated_at: typeof r.updated_at === 'string' ? r.updated_at : undefined,
  };
}

/** Normalize a stored node list, dropping unusable entries. */
export function normalizeNodes(raw: unknown): CentrifugoNode[] {
  if (!Array.isArray(raw)) return [];
  const out: CentrifugoNode[] = [];
  const seen = new Set<string>();
  raw.forEach((entry, i) => {
    const node = normalizeNode(entry, i);
    if (!node || seen.has(node.id)) return;
    seen.add(node.id);
    out.push(node);
  });
  return out;
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
  // Phase 1.2 — strict pattern match. Loose prefix matching is rejected:
  // only the three sanctioned channel shapes are valid for a workspace.
  //   ws:{workspaceId}:inbox
  //   ws:{workspaceId}:visitors
  //   ws:{workspaceId}:conv:{conversationId}        (conversationId is opaque
  //     but constrained to safe URL chars — letters/digits/_-)
  if (!channel || typeof channel !== 'string') return false;
  if (!workspaceId || typeof workspaceId !== 'string') return false;
  if (channel === `ws:${workspaceId}:inbox`) return true;
  if (channel === `ws:${workspaceId}:visitors`) return true;
  if (channel === `ws:${workspaceId}:operators`) return true;
  // Conversation channel — the conversation id segment must be non-empty
  // and contain only safe characters (UUIDs and short opaque ids).
  const convPrefix = `ws:${workspaceId}:conv:`;
  if (channel.startsWith(convPrefix)) {
    const convId = channel.slice(convPrefix.length);
    if (!convId) return false;
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(convId)) return false;
    return true;
  }
  return false;
}

/**
 * Returns true iff the channel is the operator-only inbox channel for the
 * given workspace. Used by token issuers to refuse minting widget tokens
 * for this channel.
 */
export function isInboxChannel(channel: string, workspaceId: string): boolean {
  return channel === `ws:${workspaceId}:inbox`;
}

/**
 * Build the operator-only Visitor Intelligence channel name for a workspace.
 * Carries `visitor.upsert` / `visitor.remove` envelopes for the live visitor
 * list and map. Widget tokens MUST NOT be issuable for this channel.
 */
export function buildVisitorsChannelName(workspaceId: string): string {
  return `ws:${workspaceId}:visitors`;
}

/**
 * Returns true iff the channel is the operator-only visitors channel for
 * the given workspace.
 */
export function isVisitorsChannel(channel: string, workspaceId: string): boolean {
  return channel === `ws:${workspaceId}:visitors`;
}

/**
 * Build the operator-only LIVE PRESENCE channel for a workspace.
 *
 * Membership of this channel IS the live-presence signal: the operator
 * panel subscribes while its tab is visible and unsubscribes when the tab
 * is hidden or closed. Centrifugo's presence API over this channel is the
 * primary source of truth for "who is connected right now" — PostgreSQL is
 * only a fallback. Widget/visitor tokens MUST NEVER be issuable here.
 */
export function buildOperatorPresenceChannelName(workspaceId: string): string {
  return `ws:${workspaceId}:operators`;
}

/** Returns true iff the channel is the operator-only presence channel. */
export function isOperatorPresenceChannel(channel: string, workspaceId: string): boolean {
  return channel === `ws:${workspaceId}:operators`;
}
