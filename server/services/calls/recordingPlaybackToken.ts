/**
 * Short-lived HMAC playback tokens for super-admin recording playback.
 *
 * Why this exists:
 *   Native <audio>/<video> elements cannot attach an `Authorization: Bearer`
 *   header when the browser issues Range requests, so the bearer-protected
 *   admin proxy at `/api/admin/calls/recordings/:id/file` cannot be used as a
 *   media `src=` directly. This module mints a narrow ephemeral grant —
 *   bound to one recording id, one disposition, one TTL — that the existing
 *   tokenized streaming route validates without exposing provider URLs or
 *   credentials. Tokens are stateless (HMAC, no DB row) so expiry is
 *   enforced purely by the embedded `exp` claim.
 *
 * Scope locked:
 *   • bound to a single recording id
 *   • bound to a single disposition (`inline` | `attachment`)
 *   • TTL is short (default 300s, cap 900s)
 *   • signing key derives from the server-only service-role secret, never
 *     exposed to the browser
 *   • the token is reusable within its TTL — playback streaming MUST be
 *     able to issue many Range requests against the same URL — but expires
 *     hard after TTL with no client-side cleanup required
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ServerConfig } from '../../config.js';

export type PlaybackDisposition = 'inline' | 'attachment';

const TOKEN_VERSION = 'v1';
const DEFAULT_TTL_SECONDS = 300;
const MAX_TTL_SECONDS = 900;

function b64uEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function b64uDecode(str: string): Buffer {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

function signingKey(config: ServerConfig): Buffer {
  // Domain-separated derivation from the server-only service-role secret.
  // Keeps tokens unforgeable from anything the browser sees, and rotates
  // automatically if the service-role secret is rotated.
  return createHmac('sha256', config.supabaseServiceRoleKey)
    .update('admin-recording-playback/v1')
    .digest();
}

function sign(payload: string, key: Buffer): string {
  return b64uEncode(createHmac('sha256', key).update(payload).digest());
}

export interface MintedPlaybackToken {
  token: string;
  expires_at: string;
  ttl_seconds: number;
  disposition: PlaybackDisposition;
}

export function mintPlaybackToken(
  config: ServerConfig,
  input: {
    recordingId: string;
    disposition?: PlaybackDisposition;
    ttlSeconds?: number;
  },
): MintedPlaybackToken {
  const disposition: PlaybackDisposition =
    input.disposition === 'attachment' ? 'attachment' : 'inline';
  const ttl = Math.min(
    MAX_TTL_SECONDS,
    Math.max(30, Math.floor(input.ttlSeconds || DEFAULT_TTL_SECONDS)),
  );
  const exp = Math.floor(Date.now() / 1000) + ttl;
  const payload = `${TOKEN_VERSION}.${input.recordingId}.${disposition}.${exp}`;
  const sig = sign(payload, signingKey(config));
  return {
    token: `${TOKEN_VERSION}.${disposition}.${exp}.${sig}`,
    expires_at: new Date(exp * 1000).toISOString(),
    ttl_seconds: ttl,
    disposition,
  };
}

export type PlaybackTokenError =
  | 'missing_token'
  | 'malformed_token'
  | 'unknown_version'
  | 'bad_signature'
  | 'expired';

export interface VerifiedPlaybackToken {
  recordingId: string;
  disposition: PlaybackDisposition;
  expiresAt: number;
}

export function verifyPlaybackToken(
  config: ServerConfig,
  recordingId: string,
  token: string | undefined,
): { ok: true; claims: VerifiedPlaybackToken } | { ok: false; reason: PlaybackTokenError } {
  if (!token) return { ok: false, reason: 'missing_token' };
  const parts = token.split('.');
  if (parts.length !== 4) return { ok: false, reason: 'malformed_token' };
  const [version, disposition, expStr, sig] = parts;
  if (version !== TOKEN_VERSION) return { ok: false, reason: 'unknown_version' };
  if (disposition !== 'inline' && disposition !== 'attachment') {
    return { ok: false, reason: 'malformed_token' };
  }
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp <= 0) return { ok: false, reason: 'malformed_token' };

  const payload = `${TOKEN_VERSION}.${recordingId}.${disposition}.${exp}`;
  const expected = sign(payload, signingKey(config));
  const a = b64uDecode(sig);
  const b = b64uDecode(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: 'bad_signature' };
  }
  if (Math.floor(Date.now() / 1000) >= exp) {
    return { ok: false, reason: 'expired' };
  }
  return {
    ok: true,
    claims: { recordingId, disposition: disposition as PlaybackDisposition, expiresAt: exp },
  };
}

export const __test_constants = { DEFAULT_TTL_SECONDS, MAX_TTL_SECONDS, TOKEN_VERSION };