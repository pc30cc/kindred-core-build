/**
 * Centrifugo driver — server side.
 *  - Issues short-lived HMAC (HS256) connection JWTs.
 *  - Health check via Centrifugo HTTP API `info` command.
 *
 * No raw WebSocket logic in Express. Express only:
 *   1) authorizes the visitor/session,
 *   2) issues a short-lived token,
 *   3) returns the public ws_url + token to the client.
 *
 * The browser then connects directly to Centrifugo over WebSocket.
 */

import jwt from 'jsonwebtoken';
import type { CentrifugoConfig } from './types.js';

export interface CentrifugoTokenSubject {
  sub: string;            // stable subject id (visitor or contact id)
  workspace_id: string;
  conversation_ids?: string[];
  expires_in_seconds?: number;
}

export interface CentrifugoConnectionTokenResult {
  token: string;
  ws_url: string;
  expires_at: number;
  channels: string[];
}

/**
 * Minimal shape of a Centrifugo HTTP API response envelope.
 * Only `result` presence and `error` are consumed here.
 */
export interface CentrifugoApiResponse {
  result?: unknown;
  error?: unknown;
}

export function isCentrifugoApiResponse(value: unknown): value is CentrifugoApiResponse {
  return typeof value === 'object' && value !== null;
}

/** One node as described by Centrifugo's `info` reply. */
export interface CentrifugoNodeInfo {
  /** Stable node name (CENTRIFUGO_NAME / CENTRIFUGO_NODE_NAME). */
  name?: string;
  uid?: string;
  num_clients?: number;
  num_users?: number;
  num_channels?: number;
  version?: string;
}

/** Normalize `info().result.nodes[]` without inventing values. */
export function normalizeCentrifugoNodeInfo(raw: unknown): CentrifugoNodeInfo[] {
  if (!Array.isArray(raw)) return [];
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  return raw
    .filter((n): n is Record<string, unknown> => !!n && typeof n === 'object')
    .map((n) => ({
      name: typeof n.name === 'string' && n.name.trim() ? n.name.trim() : undefined,
      uid: typeof n.uid === 'string' ? n.uid : undefined,
      num_clients: num(n.num_clients),
      num_users: num(n.num_users),
      num_channels: num(n.num_channels),
      version: typeof n.version === 'string' ? n.version : undefined,
    }));
}


/**
 * Phase 2 — fixed JWT identity claims. Centrifugo accepts any HS256 token
 * signed with its shared secret, so the only real defense against a
 * stolen-secret replay across services is to bind every token we mint to
 * a stable issuer/audience pair. Mismatched values on a token presented
 * to anything but our own Centrifugo instance immediately fail the
 * standard `jwt.verify({ issuer, audience })` check on the consumer.
 */
const CENTRIFUGO_JWT_ISSUER = 'lovable-realtime';
const CENTRIFUGO_JWT_AUDIENCE = 'centrifugo';

export class CentrifugoDriver {
  constructor(private readonly cfg: CentrifugoConfig) {}

  /** Issue a short-lived HMAC connection token. */
  issueConnectionToken(subject: CentrifugoTokenSubject): CentrifugoConnectionTokenResult {
    if (!this.cfg.token_hmac_secret) {
      throw new Error('Centrifugo token_hmac_secret not configured');
    }
    if (!this.cfg.ws_url) {
      throw new Error('Centrifugo ws_url not configured');
    }

    // Default TTL = 30min. Long enough to survive normal tab backgrounding
    // (browsers throttle setTimeout on hidden tabs to 1Hz, so a 5min token
    // could die before the proactive-refresh timer fires). The client still
    // proactively refreshes ~60s before expiry; this is a safety floor.
    const ttl = subject.expires_in_seconds ?? this.cfg.token_ttl_seconds ?? 1800;
    const exp = Math.floor(Date.now() / 1000) + ttl;

    // Centrifugo expects { sub, exp } at minimum.
    const token = jwt.sign(
      {
        sub: subject.sub,
        // Carry workspace context inside info for diagnostics. Not used for auth by Centrifugo.
        info: { workspace_id: subject.workspace_id },
      },
      this.cfg.token_hmac_secret,
      {
        algorithm: 'HS256',
        expiresIn: ttl,
        // Phase 2 hardening — issuer/audience binding + nbf clock-skew floor.
        issuer: CENTRIFUGO_JWT_ISSUER,
        audience: CENTRIFUGO_JWT_AUDIENCE,
        notBefore: 0,
      }
    );

    return {
      token,
      ws_url: this.cfg.ws_url,
      expires_at: exp * 1000,
      channels: subject.conversation_ids
        ? subject.conversation_ids.map((cid) => `ws:${subject.workspace_id}:conv:${cid}`)
        : [],
    };
  }

  /** Issue a per-channel subscription token (used when client subscribes to private channels). */
  issueSubscriptionToken(params: {
    sub: string;
    channel: string;
    workspaceId: string;
    expiresInSeconds?: number;
  }): { token: string; expires_at: number } {
    if (!this.cfg.token_hmac_secret) {
      throw new Error('Centrifugo token_hmac_secret not configured');
    }
    const ttl = params.expiresInSeconds ?? this.cfg.token_ttl_seconds ?? 1800;
    const exp = Math.floor(Date.now() / 1000) + ttl;
    const token = jwt.sign(
      {
        sub: params.sub,
        channel: params.channel,
        info: { workspace_id: params.workspaceId },
      },
      this.cfg.token_hmac_secret,
      {
        algorithm: 'HS256',
        expiresIn: ttl,
        issuer: CENTRIFUGO_JWT_ISSUER,
        audience: CENTRIFUGO_JWT_AUDIENCE,
        notBefore: 0,
      }
    );
    return { token, expires_at: exp * 1000 };
  }

  /** Health check: hits Centrifugo HTTP API `info`. */
  async health(): Promise<{ status: 'healthy' | 'degraded' | 'down'; message: string }> {
    if (!this.cfg.api_url || !this.cfg.api_key) {
      return { status: 'down', message: 'API URL or API key not configured' };
    }
    try {
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 5000);
      const res = await fetch(this.cfg.api_url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': this.cfg.api_key,
        },
        body: JSON.stringify({ method: 'info', params: {} }),
        signal: ctrl.signal,
      });
      clearTimeout(timeout);
      if (!res.ok) {
        return { status: 'down', message: `HTTP ${res.status}` };
      }
      const data: unknown = await res.json().catch(() => null);
      if (isCentrifugoApiResponse(data) && (!!data.result || !data.error)) {
        return { status: 'healthy', message: 'Centrifugo info OK' };
      }
      return { status: 'degraded', message: 'Unexpected response shape' };
    } catch (err: any) {
      return { status: 'down', message: err?.message || 'Connection failed' };
    }
  }

  /**
   * Richer variant of `health()` used by the node router.
   *
   * Centrifugo's `info` reply describes EVERY node of the cluster, not just
   * the node that answered the HTTP call. Summing `num_clients` across
   * `result.nodes[]` therefore yields the CLUSTER total, which must never be
   * attributed to a single node. So:
   *
   *   • `nodes`              — normalized per-node records as reported.
   *   • `cluster_num_clients`— the cluster-wide total (explicitly labelled).
   *   • `num_clients`        — the count of THIS node only, resolved by exact
   *                            Centrifugo node name (`options.nodeName`).
   *                            Left `undefined` when the name is unknown or
   *                            not present in the reply — an unknown load is
   *                            reported as unknown, never faked with the
   *                            cluster number.
   *
   * Live connection counts are READ from Centrifugo, never stored in PostgreSQL.
   */
  /**
   * List currently ACTIVE channels matching a pattern.
   *
   * SCALE WARNING (from Centrifugo's own docs): this returns every matching
   * active channel with no pagination, so it is only acceptable for small,
   * single-node deployments. Multi-node deployments must use the Redis
   * candidate index instead — see services/visitors/candidateIndex.ts.
   */
  async channels(pattern: string, limit = 1_000): Promise<string[] | null> {
    if (!this.cfg.api_url || !this.cfg.api_key) return null;
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 4000);
    try {
      const res = await fetch(this.cfg.api_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': this.cfg.api_key },
        body: JSON.stringify({ method: 'channels', params: { pattern } }),
        signal: ctrl.signal,
      });
      if (!res.ok) return null;
      const json: unknown = await res.json().catch(() => null);
      if (!isCentrifugoApiResponse(json) || json.error) return null;
      const channels = (json.result as { channels?: Record<string, unknown> } | undefined)?.channels;
      if (!channels || typeof channels !== 'object') return null;
      return Object.keys(channels).slice(0, limit);
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  async info(options: { nodeName?: string } = {}): Promise<{

    status: 'healthy' | 'degraded' | 'down';
    message: string;
    nodes: CentrifugoNodeInfo[];
    num_clients?: number;
    cluster_num_clients?: number;
    num_nodes?: number;
    node_name_matched?: boolean;
  }> {
    if (!this.cfg.api_url || !this.cfg.api_key) {
      return { status: 'down', message: 'API URL or API key not configured', nodes: [] };
    }
    try {
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 5000);
      const res = await fetch(this.cfg.api_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': this.cfg.api_key },
        body: JSON.stringify({ method: 'info', params: {} }),
        signal: ctrl.signal,
      });
      clearTimeout(timeout);
      if (!res.ok) return { status: 'down', message: `HTTP ${res.status}`, nodes: [] };
      const data: unknown = await res.json().catch(() => null);
      if (!isCentrifugoApiResponse(data) || data.error) {
        return { status: 'degraded', message: 'Unexpected response shape', nodes: [] };
      }
      const result = data.result as { nodes?: unknown[] } | undefined;
      const nodes = normalizeCentrifugoNodeInfo(result?.nodes);
      const clusterTotal = nodes.reduce(
        (sum, n) => sum + (typeof n.num_clients === 'number' ? n.num_clients : 0),
        0
      );
      const wanted = options.nodeName?.trim();
      const self = wanted ? nodes.find((n) => n.name === wanted) : undefined;
      return {
        status: 'healthy',
        message: 'Centrifugo info OK',
        nodes,
        num_clients: typeof self?.num_clients === 'number' ? self.num_clients : undefined,
        cluster_num_clients: nodes.length ? clusterTotal : undefined,
        num_nodes: nodes.length || undefined,
        node_name_matched: wanted ? !!self : undefined,
      };
    } catch (err: any) {
      return { status: 'down', message: err?.message || 'Connection failed', nodes: [] };
    }
  }




  /**
   * Server-side presence read for a channel.
   *
   * Returns the distinct `user` (JWT `sub`) values currently subscribed to
   * the channel — Centrifugo deduplicates nothing for us, so multiple tabs
   * of the same operator appear as multiple clients under one `user`.
   * `null` means "presence could not be read" (transport error, presence
   * disabled on the namespace) and MUST NOT be interpreted as "nobody is
   * online" — callers fall back to the PostgreSQL lease instead.
   */
  async presenceUsers(channel: string): Promise<string[] | null> {
    if (!this.cfg.api_url || !this.cfg.api_key) return null;
    try {
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 4000);
      const res = await fetch(this.cfg.api_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': this.cfg.api_key },
        body: JSON.stringify({ method: 'presence', params: { channel } }),
        signal: ctrl.signal,
      });
      clearTimeout(timeout);
      if (!res.ok) return null;
      const json: unknown = await res.json().catch(() => null);
      if (!isCentrifugoApiResponse(json) || json.error) return null;
      const presence = (json.result as { presence?: Record<string, { user?: string }> } | undefined)?.presence;
      if (!presence || typeof presence !== 'object') return null;
      const users = new Set<string>();
      for (const client of Object.values(presence)) {
        if (client && typeof client.user === 'string' && client.user) users.add(client.user);
      }
      return [...users];
    } catch {
      return null;
    }
  }

  /**
   * Bounded presence read for MANY channels in ONE request.
   *
   * Uses Centrifugo's `batch` API with `presence_stats`, which returns only
   * `num_clients` / `num_users` per channel — no member payload. That is the
   * property that makes visitor presence scale: the response size is
   * proportional to the number of channels ASKED FOR, never to how many
   * visitors the workspace has online.
   *
   * Returns a map channel → client count. Channels the reply could not answer
   * are simply absent (a per-channel error is not an outage). `null` means the
   * whole request failed and the caller must fall back to the database —
   * "unreadable" is never "nobody is online".
   */
  async presenceStatsBatch(channels: string[]): Promise<Map<string, number> | null> {
    if (!this.cfg.api_url || !this.cfg.api_key) return null;
    const list = [...new Set(channels)].filter(Boolean);
    if (!list.length) return new Map();

    const commands = list.map((channel) => ({ presence_stats: { channel } }));
    const headers = { 'Content-Type': 'application/json', 'X-API-Key': this.cfg.api_key };
    const base = this.cfg.api_url.replace(/\/+$/, '');

    const parseReplies = (json: unknown): Map<string, number> | null => {
      if (!isCentrifugoApiResponse(json)) return null;
      const replies = (json as { replies?: unknown[] }).replies
        ?? ((json.result as { replies?: unknown[] } | undefined)?.replies);
      if (!Array.isArray(replies) || replies.length !== list.length) return null;
      const out = new Map<string, number>();
      replies.forEach((reply, i) => {
        if (!reply || typeof reply !== 'object') return;
        const r = reply as Record<string, any>;
        if (r.error) return; // per-channel error → unknown, not offline
        const stats = r.presence_stats ?? r.result?.presence_stats ?? r.result;
        const n = stats && typeof stats.num_clients === 'number' ? stats.num_clients : undefined;
        if (typeof n === 'number') out.set(list[i], n);
      });
      return out;
    };

    const post = async (url: string, body: unknown): Promise<unknown | null> => {
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 4000);
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
        if (!res.ok) return null;
        return await res.json().catch(() => null);
      } catch {
        return null;
      } finally {
        clearTimeout(timeout);
      }
    };

    // 1) Native batch endpoint (Centrifugo v5+): POST {api_base}/batch
    const native = parseReplies(await post(`${base}/batch`, { commands, parallel: true }));
    if (native) return native;

    // 2) Legacy single-endpoint form ({method, params}) for older deployments.
    const legacy = parseReplies(
      await post(base, { method: 'batch', params: { commands, parallel: true } }),
    );
    if (legacy) return legacy;

    // 3) Last resort: sequential per-channel stats, bounded so a broken batch
    //    endpoint can never turn one page read into hundreds of round trips.
    if (list.length > 8) return null;
    const out = new Map<string, number>();
    for (const channel of list) {
      const json = await post(base, { method: 'presence_stats', params: { channel } });
      if (!isCentrifugoApiResponse(json) || json.error) continue;
      const stats = json.result as { num_clients?: number } | undefined;
      if (typeof stats?.num_clients === 'number') out.set(channel, stats.num_clients);
    }
    return out;
  }

  /** Server-to-server publish (used by backend to broadcast new messages, optional). */


  async publish(channel: string, data: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> {
    if (!this.cfg.api_url || !this.cfg.api_key) {
      return { ok: false, error: 'Centrifugo API not configured' };
    }
    try {
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 5000);
      const res = await fetch(this.cfg.api_url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': this.cfg.api_key,
        },
        body: JSON.stringify({ method: 'publish', params: { channel, data } }),
        signal: ctrl.signal,
      });
      clearTimeout(timeout);
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      const json: unknown = await res.json().catch(() => null);
      if (isCentrifugoApiResponse(json) && !!json.error) {
        const err = json.error;
        const message = typeof err === 'object' && err !== null && 'message' in err
          ? (err as { message?: unknown }).message
          : undefined;
        return { ok: false, error: String(message ?? err) };
      }
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Publish failed' };
    }
  }
}
