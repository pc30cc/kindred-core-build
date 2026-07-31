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
