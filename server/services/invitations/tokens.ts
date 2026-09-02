/**
 * WORKSPACE INVITATIONS v5.1 — secret material.
 *
 * Everything secret about an invitation is produced HERE, in Express, and only
 * ever leaves this process as:
 *   - a sha256 hash persisted in PostgreSQL, or
 *   - a single raw value handed to the invited human (email link, manual link,
 *     OTP code) or to an HttpOnly cookie.
 *
 * Raw tokens/proofs/OTPs are never logged, audited, stored in the database or
 * placed in a URL query string or path (v5.1 §5, §5.5).
 */

import crypto from 'node:crypto';
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';

export const MANUAL_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const EMAIL_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const OTP_TTL_MS = 10 * 60 * 1000;
export const PROOF_TTL_MS = 15 * 60 * 1000;
export const CONTEXT_TTL_MS = 15 * 60 * 1000;

export const PROOF_COOKIE_NAME = 'wi_proof';
export const CONTEXT_COOKIE_NAME = 'wi_ctx';

export function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function tokenPrefix(raw: string): string {
  return raw.slice(0, 8);
}

/** Constant-time comparison for application-level secret checks. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// ── Key ring ────────────────────────────────────────────────────────────
// INVITATION_LINK_SECRET       -> version 1 (default)
// INVITATION_LINK_SECRET_RING  -> optional JSON {"1":"...","2":"..."}
// INVITATION_LINK_KEY_VERSION  -> optional current version (default: highest)

export class DerivationKeyUnavailable extends Error {
  constructor(version: number) {
    super(`DERIVATION_KEY_UNAVAILABLE:${version}`);
    this.name = 'DerivationKeyUnavailable';
  }
}

function keyRing(): Map<number, string> {
  const ring = new Map<number, string>();
  const base = process.env.INVITATION_LINK_SECRET?.trim();
  if (base) ring.set(1, base);

  const raw = process.env.INVITATION_LINK_SECRET_RING?.trim();
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Record<string, string>;
      for (const [k, v] of Object.entries(parsed)) {
        const version = Number.parseInt(k, 10);
        if (Number.isInteger(version) && version > 0 && typeof v === 'string' && v.length >= 16) {
          ring.set(version, v);
        }
      }
    } catch {
      // A malformed ring must never silently downgrade to "no key": the job
      // fails closed below.
    }
  }
  return ring;
}

export function currentKeyVersion(): number {
  const ring = keyRing();
  if (ring.size === 0) throw new DerivationKeyUnavailable(0);
  const configured = Number.parseInt(process.env.INVITATION_LINK_KEY_VERSION || '', 10);
  if (Number.isInteger(configured) && ring.has(configured)) return configured;
  return Math.max(...ring.keys());
}

export function hasDerivationKey(version: number): boolean {
  return keyRing().has(version);
}

function derivedKey(version: number): Buffer {
  const secret = keyRing().get(version);
  if (!secret) throw new DerivationKeyUnavailable(version);
  return Buffer.from(
    crypto.hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.alloc(0),
      Buffer.from('workspace-invitation-email-token-v1', 'utf8'), 32)
  );
}

function lenPrefixed(value: string): Buffer {
  const body = Buffer.from(value, 'utf8');
  const len = Buffer.alloc(2);
  len.writeUInt16BE(body.length);
  return Buffer.concat([len, body]);
}

function uuidBytes(id: string): Buffer {
  return Buffer.from(id.replace(/-/g, ''), 'hex');
}

export interface EmailTokenInput {
  invitationId: string;
  jobId: string;
  notificationGeneration: number;
  emailTokenGeneration: number;
  keyVersion: number;
}

/**
 * Deterministic email-claim token: every retry of the same logical job
 * reproduces the identical link (v5.1 §5).
 */
export function deriveEmailToken(input: EmailTokenInput): string {
  const format = Buffer.from([1]);
  const nGen = Buffer.alloc(4);
  nGen.writeUInt32BE(input.notificationGeneration);
  const eGen = Buffer.alloc(4);
  eGen.writeUInt32BE(input.emailTokenGeneration);
  const kVer = Buffer.alloc(2);
  kVer.writeUInt16BE(input.keyVersion);

  const canonical = Buffer.concat([
    format,
    lenPrefixed('email_claim'),
    uuidBytes(input.invitationId),
    uuidBytes(input.jobId),
    nGen,
    eGen,
    kVer,
  ]);

  return crypto
    .createHmac('sha256', derivedKey(input.keyVersion))
    .update(canonical)
    .digest('base64url');
}

// ── OTP ─────────────────────────────────────────────────────────────────

function otpPepper(): string {
  const pepper = process.env.INVITATION_OTP_PEPPER?.trim()
    || process.env.INVITATION_LINK_SECRET?.trim();
  if (!pepper) throw new Error('INVITATION_OTP_PEPPER_MISSING');
  return pepper;
}

export function generateOtpCode(): string {
  // Rejection-free uniform 6 digits from a 4-byte CSPRNG draw.
  const n = crypto.randomInt(0, 1_000_000);
  return n.toString().padStart(6, '0');
}

export function otpDigest(invitationId: string, code: string): string {
  return crypto
    .createHmac('sha256', otpPepper())
    .update(`${invitationId}:${code}`)
    .digest('hex');
}

// ── Destination hashing (job idempotency, never reversible) ─────────────

export function destinationHash(value: string): string {
  return sha256Hex(`destination:${value.trim().toLowerCase()}`);
}

// ── Public app base URL (dynamic domains, no baked-in host) ─────────────

let cachedAppBase: { value: string | null; at: number } = { value: null, at: 0 };

export async function resolveAppBaseUrl(config: ServerConfig): Promise<string> {
  const now = Date.now();
  if (cachedAppBase.value && now - cachedAppBase.at < 60_000) return cachedAppBase.value;

  let resolved: string | null = null;
  try {
    const sb = getServiceClient(config);
    const { data } = await sb
      .from('platform_domains')
      .select('app_base_url')
      .limit(1)
      .maybeSingle();
    if (data?.app_base_url) resolved = String(data.app_base_url).replace(/\/+$/, '');
  } catch {
    resolved = null;
  }

  if (!resolved) {
    const fallback = config.corsOrigins.find((o) => o && o !== '*');
    resolved = (fallback || 'http://localhost:8080').replace(/\/+$/, '');
  }

  cachedAppBase = { value: resolved, at: now };
  return resolved;
}

/** Fragment-only invitation URL — the token never enters a query or path. */
export function buildInviteUrl(appBaseUrl: string, rawToken: string, purpose: 'email_claim' | 'manual_handoff'): string {
  const p = purpose === 'email_claim' ? 'e' : 'm';
  return `${appBaseUrl}/invite#token=${encodeURIComponent(rawToken)}&p=${p}`;
}
