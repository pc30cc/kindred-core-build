/**
 * Canonical HMAC-SHA256 request signing for plugin ↔ Web Yar machine
 * requests (docs/commerce/SECURITY.md §Request signing).
 *
 * Symmetric: the exact same string-to-sign is computed by the WordPress
 * plugin's Auth/RequestSigner.php for outbound plugin→WebYar calls (events,
 * customer-context) and by this module for outbound WebYar→plugin calls
 * (the Commerce Gateway). Verification is likewise symmetric — this module
 * verifies inbound plugin requests; the plugin's Auth/ReplayGuard.php
 * verifies inbound WebYar requests the same way.
 *
 * The WordPress nonce system is NOT used here — it is CSRF protection for
 * admin-UI form submissions, never server authentication (see SECURITY.md).
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { COMMERCE_PROTOCOL_VERSION } from '../../../shared/commerce/types.js';

export const CLOCK_SKEW_SECONDS = 300;
export const MAX_BODY_BYTES = 256 * 1024;

export interface SignatureInput {
  protocolVersion: string;
  method: string;
  canonicalPath: string;
  installationId: string;
  timestamp: string;
  nonce: string;
  bodySha256Hex: string;
}

export function sha256Hex(body: string | Buffer): string {
  return createHash('sha256').update(body).digest('hex');
}

function stringToSign(input: SignatureInput): string {
  return [
    input.protocolVersion,
    input.method.toUpperCase(),
    input.canonicalPath,
    input.installationId,
    input.timestamp,
    input.nonce,
    input.bodySha256Hex,
  ].join('\n');
}

export function computeSignature(secret: string, input: SignatureInput): string {
  return createHmac('sha256', secret).update(stringToSign(input)).digest('hex');
}

export function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    // Still run a comparison of equal length to avoid a length-based timing
    // side channel distinguishing "wrong length" from "wrong content".
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

export function generateNonce(): string {
  return randomBytes(16).toString('hex');
}

/** Builds the outbound signed headers for a WebYar → plugin call. */
export function buildSignedHeaders(
  secret: string,
  installationId: string,
  method: string,
  canonicalPath: string,
  body: string,
): Record<string, string> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = generateNonce();
  const signature = computeSignature(secret, {
    protocolVersion: COMMERCE_PROTOCOL_VERSION,
    method,
    canonicalPath,
    installationId,
    timestamp,
    nonce,
    bodySha256Hex: sha256Hex(body),
  });
  return {
    'X-WebYar-Installation': installationId,
    'X-WebYar-Timestamp': timestamp,
    'X-WebYar-Nonce': nonce,
    'X-WebYar-Signature': signature,
    'X-WebYar-Protocol': COMMERCE_PROTOCOL_VERSION,
    'Content-Type': 'application/json',
  };
}

export type VerifyOutcome =
  | { ok: true }
  | { ok: false; reason: 'clock_skew' | 'replay' | 'bad_signature' | 'protocol_mismatch' | 'body_too_large' };

/**
 * Verifies an inbound request from the plugin (events, customer-context
 * assertions). `direction` scopes the nonce replay cache independently for
 * inbound vs outbound so the two directions can never share (or exhaust)
 * each other's nonce space.
 */
export async function verifyIncomingSignature(
  config: ServerConfig,
  input: {
    secret: string;
    installationId: string;
    protocolVersion: string;
    method: string;
    canonicalPath: string;
    timestamp: string;
    nonce: string;
    signature: string;
    rawBody: string;
    direction: 'inbound' | 'outbound';
  },
): Promise<VerifyOutcome> {
  if (input.protocolVersion !== COMMERCE_PROTOCOL_VERSION) return { ok: false, reason: 'protocol_mismatch' };
  if (Buffer.byteLength(input.rawBody, 'utf8') > MAX_BODY_BYTES) return { ok: false, reason: 'body_too_large' };

  const ts = Number(input.timestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: 'bad_signature' };
  const skew = Math.abs(Math.floor(Date.now() / 1000) - ts);
  if (skew > CLOCK_SKEW_SECONDS) return { ok: false, reason: 'clock_skew' };

  const expected = computeSignature(input.secret, {
    protocolVersion: input.protocolVersion,
    method: input.method,
    canonicalPath: input.canonicalPath,
    installationId: input.installationId,
    timestamp: input.timestamp,
    nonce: input.nonce,
    bodySha256Hex: sha256Hex(input.rawBody),
  });
  if (!constantTimeEquals(expected, input.signature)) return { ok: false, reason: 'bad_signature' };

  // Replay guard: the unique index (installation_id, direction, nonce) makes
  // this atomic — a concurrent duplicate insert fails, not a race-losing read.
  const sb = getServiceClient(config);
  const { error } = await sb.from('commerce_nonce_cache').insert({
    installation_id: input.installationId,
    direction: input.direction,
    nonce: input.nonce,
  });
  if (error) {
    // Unique violation => replay. Any other DB error fails closed too.
    return { ok: false, reason: 'replay' };
  }

  return { ok: true };
}

/** Best-effort periodic cleanup — nonces older than 2x the clock-skew window can never validate again anyway. */
export async function pruneExpiredNonces(config: ServerConfig): Promise<void> {
  try {
    const sb = getServiceClient(config);
    const cutoff = new Date(Date.now() - CLOCK_SKEW_SECONDS * 2 * 1000).toISOString();
    await sb.from('commerce_nonce_cache').delete().lt('seen_at', cutoff);
  } catch (err) {
    console.warn('[commerce.signing] nonce prune failed:', err instanceof Error ? err.message : err);
  }
}
