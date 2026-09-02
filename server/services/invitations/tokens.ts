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
        if (Number.isInteger(version) && version > 0 && typeof v === 'string' && Buffer.byteLength(v, 'utf8') >= 32) {
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

// ── OTP key ring ────────────────────────────────────────────────────────
// INVITATION_OTP_PEPPER        -> version 1 (default)
// INVITATION_OTP_PEPPER_RING   -> optional JSON {"1":"...","2":"..."}
// INVITATION_OTP_KEY_VERSION   -> optional current version (default: highest)
//
// Phase 0.5: a queued OTP job must still be deliverable after a pepper
// rotation, so the NON-SECRET version travels inside the stored digest
// ("v<version>:<hmac>"). The worker derives the code with that version; when
// the version is no longer configured it fails CLOSED (the OTP is atomically
// revoked and the job records DERIVATION_KEY_UNAVAILABLE) — a code that could
// never verify is never e-mailed. Old keys must stay in the ring for at least
// the maximum OTP lifetime (10 minutes) plus the job retry window.

function otpKeyRing(): Map<number, string> {
  const ring = new Map<number, string>();
  const base = process.env.INVITATION_OTP_PEPPER?.trim();
  if (base) ring.set(1, base);
  const raw = process.env.INVITATION_OTP_PEPPER_RING?.trim();
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Record<string, string>;
      for (const [k, v] of Object.entries(parsed)) {
        const version = Number.parseInt(k, 10);
        if (Number.isInteger(version) && version > 0 && typeof v === 'string' && Buffer.byteLength(v, 'utf8') >= 32) {
          ring.set(version, v);
        }
      }
    } catch {
      // malformed ring never downgrades to "no key": derivation fails closed.
    }
  }
  return ring;
}

export function currentOtpKeyVersion(): number {
  const ring = otpKeyRing();
  if (ring.size === 0) throw new Error('INVITATION_OTP_PEPPER_MISSING');
  const configured = Number.parseInt(process.env.INVITATION_OTP_KEY_VERSION || '', 10);
  if (Number.isInteger(configured) && ring.has(configured)) return configured;
  return Math.max(...ring.keys());
}

export function hasOtpKey(version: number): boolean {
  return otpKeyRing().has(version);
}

function otpPepper(version: number = currentOtpKeyVersion()): string {
  const pepper = otpKeyRing().get(version);
  if (!pepper) throw new DerivationKeyUnavailable(version);
  return pepper;
}

export function validateInvitationSecrets(): void {
  const otpRing = otpKeyRing();
  if (otpRing.size === 0) throw new Error('INVITATION_OTP_PEPPER_MISSING');
  for (const [version, pepper] of otpRing) {
    if (Buffer.byteLength(pepper, 'utf8') < 32) {
      throw new Error(`INVITATION_OTP_PEPPER version ${version} must contain at least 32 bytes`);
    }
  }
  const ring = keyRing();
  if (ring.size === 0) throw new Error('INVITATION_LINK_SECRET_MISSING');
  for (const [version, key] of ring) {
    if (Buffer.byteLength(key, 'utf8') < 32) {
      throw new Error(`INVITATION_LINK_SECRET version ${version} must contain at least 32 bytes`);
    }
    for (const pepper of otpRing.values()) {
      if (safeEqual(key, pepper)) {
        throw new Error('INVITATION_OTP_PEPPER must be distinct from every invitation link key');
      }
    }
  }
}

export function generateOtpCode(): string {
  // Rejection-free uniform 6 digits from a 4-byte CSPRNG draw.
  const n = crypto.randomInt(0, 1_000_000);
  return n.toString().padStart(6, '0');
}

/**
 * Deterministic OTP code for the durable delivery outbox (v5.1 B.5).
 *
 * The database stores ONLY the keyed digest of the code. The delivery worker
 * must still be able to e-mail the very same code after a crash, so the code
 * is derived from non-secret job material (invitation id + otp id) plus the
 * OTP pepper of the recorded key version. Nothing recoverable from a database
 * dump: without the pepper the code cannot be derived, and the digest cannot
 * be brute-forced because it is keyed by the same pepper.
 */
export function deriveOtpCode(invitationId: string, otpId: string, version: number = currentOtpKeyVersion()): string {
  const digest = crypto
    .createHmac('sha256', otpPepper(version))
    .update(`wi-otp-code-v1|${invitationId}|${otpId}`, 'utf8')
    .digest();
  return String(digest.readUInt32BE(0) % 1_000_000).padStart(6, '0');
}

/** `v<version>:<hmac>` — the version is non-secret and stays queryable in SQL. */
export function otpDigest(invitationId: string, code: string, version: number = currentOtpKeyVersion()): string {
  const mac = crypto
    .createHmac('sha256', otpPepper(version))
    .update(`${invitationId}:${code}`)
    .digest('hex');
  return `v${version}:${mac}`;
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
