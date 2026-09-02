/**
 * Generic Verification Core v1 — cryptography.
 *
 * ALL hashing/HMAC happens here, in Node. Postgres (see
 * database/migrations/098_generic_verification_core.sql) never hashes
 * anything itself — it only stores and compares the opaque hex strings this
 * module produces. This mirrors the already-proven Workspace Invitations
 * v5.1 design (server/services/invitations/tokens.ts), generalized to be
 * purpose-agnostic and keyed by its OWN, entirely separate secret material:
 *
 *   GENERIC_VERIFICATION_PEPPER          (required, >= 32 bytes) — key version 1
 *   GENERIC_VERIFICATION_PEPPER_RING     (optional JSON {"1":"...","2":"..."})
 *   GENERIC_VERIFICATION_KEY_VERSION     (optional; default = max(ring keys))
 *
 * These are NEVER the same value as INVITATION_OTP_PEPPER,
 * INVITATION_LINK_SECRET, or PHONE_VERIFICATION_PEPPER — reusing a pepper
 * across subsystems would let a compromise of one surface be replayed
 * against another. `assertDistinctFromOtherSecrets()` enforces this at
 * startup, the same way server/config.ts already does for the Channels/AI
 * Runtime boundary secrets.
 *
 * Sub-key derivation: every distinct cryptographic purpose (deriving the
 * OTP code, digesting it for storage, hashing a proof token, hashing a
 * destination/subject/IP for rate-limit bucketing, deriving an idempotency
 * key/fingerprint) uses its OWN HMAC sub-key
 * (`subKey(label, version) = HMAC-SHA256(basePepper[version], label)`),
 * never the base pepper directly — the same "one root secret, many
 * HKDF-style domain-separated sub-keys" discipline
 * server/services/invitations/idempotency.ts already uses. A compromise of
 * one derived sub-key's usage pattern does not hand an attacker any other
 * sub-key.
 *
 * Key rotation: every digest is stored as `v<version>:<hex>` — the version
 * is plaintext (non-secret) so verification always looks up the HISTORICAL
 * key recorded on the row, never the newest. An unavailable historical key
 * (rotated out of the ring too early) fails closed
 * (`DerivationKeyUnavailableError`), never falls back to the current key.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export class VerificationPepperMissingError extends Error {
  constructor() {
    super('GENERIC_VERIFICATION_PEPPER is not configured or is too short');
    this.name = 'VerificationPepperMissingError';
  }
}

export class DerivationKeyUnavailableError extends Error {
  constructor(version: number) {
    super(`No pepper available for key version ${version}`);
    this.name = 'DerivationKeyUnavailableError';
  }
}

const MIN_PEPPER_LENGTH = 32;

let cachedRing: Map<number, string> | null = null;
let cachedCurrentVersion: number | null = null;

function loadRing(env: NodeJS.ProcessEnv = process.env): Map<number, string> {
  if (cachedRing) return cachedRing;

  const ring = new Map<number, string>();
  const base = env.GENERIC_VERIFICATION_PEPPER?.trim();
  if (base && base.length >= MIN_PEPPER_LENGTH) {
    ring.set(1, base);
  }

  const rawRing = env.GENERIC_VERIFICATION_PEPPER_RING?.trim();
  if (rawRing) {
    try {
      const parsed = JSON.parse(rawRing) as Record<string, string>;
      for (const [k, v] of Object.entries(parsed)) {
        const version = Number.parseInt(k, 10);
        if (Number.isInteger(version) && version > 0 && typeof v === 'string' && v.length >= MIN_PEPPER_LENGTH) {
          ring.set(version, v);
        }
      }
    } catch {
      // Malformed ring JSON is ignored, never silently treated as "no ring"
      // in a way that would downgrade security — callers still fail closed
      // via hasKey()/requireKey() below if the resulting ring is empty.
    }
  }

  cachedRing = ring;
  return ring;
}

function currentVersion(env: NodeJS.ProcessEnv = process.env): number {
  if (cachedCurrentVersion !== null) return cachedCurrentVersion;
  const ring = loadRing(env);
  const configured = Number.parseInt(env.GENERIC_VERIFICATION_KEY_VERSION || '', 10);
  if (Number.isInteger(configured) && ring.has(configured)) {
    cachedCurrentVersion = configured;
    return configured;
  }
  const max = ring.size ? Math.max(...ring.keys()) : 1;
  cachedCurrentVersion = max;
  return max;
}

/** Test-only: clears the module-level cache so tests can vary env vars per-case. */
export function __resetVerificationCryptoCacheForTests(): void {
  cachedRing = null;
  cachedCurrentVersion = null;
}

export function hasVerificationPepper(env: NodeJS.ProcessEnv = process.env): boolean {
  return loadRing(env).size > 0;
}

export function currentVerificationKeyVersion(env: NodeJS.ProcessEnv = process.env): number {
  return currentVersion(env);
}

function keyForVersion(version: number, env: NodeJS.ProcessEnv = process.env): string {
  const ring = loadRing(env);
  const key = ring.get(version);
  if (!key) {
    if (ring.size === 0) throw new VerificationPepperMissingError();
    throw new DerivationKeyUnavailableError(version);
  }
  return key;
}

/** HMAC-derived, domain-separated sub-key — never uses the base pepper directly for real work. */
function subKey(label: string, version: number, env: NodeJS.ProcessEnv = process.env): Buffer {
  return createHmac('sha256', keyForVersion(version, env)).update(label).digest();
}

/**
 * Independently confirms this pepper is not reused from another subsystem.
 * Called once at server startup (see server/config.ts wiring in the
 * consumer guide) — NOT enforced automatically by this module on every
 * call, matching how server/config.ts's assertDistinctSigningKey works.
 */
export function assertDistinctFromOtherSecrets(otherSecrets: Array<string | undefined>): void {
  const ring = loadRing();
  for (const pepper of ring.values()) {
    for (const other of otherSecrets) {
      if (other && timingSafeEqualStrings(pepper, other)) {
        throw new Error('GENERIC_VERIFICATION_PEPPER (or a ring entry) must not reuse another subsystem\'s secret');
      }
    }
  }
}

function timingSafeEqualStrings(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

// ─── Opaque, non-secret identifiers ───

/** Client-facing opaque handle for a challenge. Never the OTP code, never guessable. */
export function generateChallengeHandle(): string {
  return `gvc_${randomBytes(24).toString('base64url')}`;
}

// ─── OTP code: derive (crash-safe, reproducible) + digest (stored) ───

export interface OtpDomainInputs {
  purpose: string;
  channel: string;
  challengeHandle: string;
  generation: number;
  destinationHash: string;
}

/**
 * Deterministically derives the OTP code from domain-separated inputs and
 * the recorded key version — NOT a fresh random draw. This is what lets a
 * crashed/retried delivery worker reproduce the EXACT SAME code without the
 * raw code ever being persisted anywhere (see docs/GENERIC_VERIFICATION_CORE.md
 * §Cryptography for the rationale; this is the same technique already
 * proven in server/services/invitations/tokens.ts's deriveOtpCode).
 */
export function deriveOtpCode(inputs: OtpDomainInputs, keyVersion: number, length: number, env: NodeJS.ProcessEnv = process.env): string {
  if (length < 4 || length > 10) throw new Error('OTP length must be between 4 and 10 digits');
  const key = subKey('gv-code-derive-v1', keyVersion, env);
  const digest = createHmac('sha256', key)
    .update(`${inputs.purpose}|${inputs.channel}|${inputs.challengeHandle}|${inputs.generation}|${inputs.destinationHash}`)
    .digest();
  const modulus = 10 ** length;
  const value = digest.readUInt32BE(0) % modulus;
  return String(value).padStart(length, '0');
}

/**
 * Digests an OTP code for storage/comparison — a SEPARATE HMAC application
 * from deriveOtpCode (different sub-key label), so knowing one function's
 * output never hands you the other's input or output. Returns
 * "v<version>:<hex>" — the version prefix is not secret.
 */
export function digestOtpCode(inputs: OtpDomainInputs, code: string, keyVersion: number, env: NodeJS.ProcessEnv = process.env): string {
  const key = subKey('gv-code-digest-v1', keyVersion, env);
  const mac = createHmac('sha256', key)
    .update(`${inputs.challengeHandle}|${inputs.generation}|${code}`)
    .digest('hex');
  return `v${keyVersion}:${mac}`;
}

/** Parses "v<version>:<hex>" back into its parts. Returns null if malformed. */
export function parseVersionedDigest(digest: string): { version: number; hex: string } | null {
  const m = /^v(\d+):([0-9a-f]{64})$/.exec(digest);
  if (!m) return null;
  return { version: Number.parseInt(m[1], 10), hex: m[2] };
}

/**
 * Recomputes the candidate digest for a user-submitted code, using the
 * HISTORICAL key version recorded on the challenge (never the current
 * version) — this is what makes verification safe across key rotation:
 * an in-flight challenge created under key v1 still verifies correctly
 * after the deployment's current version becomes v2, as long as v1 is
 * still in the ring. Constant-time compare against the stored digest is
 * done by the caller (see verifyOtpDigest) — SQL only ever compares two
 * independently-computed fixed-length hex HMAC outputs, which carries no
 * exploitable timing signal about the underlying code (matching the
 * accepted posture of the Workspace Invitations v5.1 verifier).
 */
export function candidateOtpDigest(inputs: OtpDomainInputs, code: string, keyVersion: number, env: NodeJS.ProcessEnv = process.env): string {
  return digestOtpCode(inputs, code, keyVersion, env);
}

/** Constant-time comparison of two versioned digests (defense in depth alongside the DB-side compare). */
export function verifyOtpDigest(candidate: string, stored: string): boolean {
  const a = Buffer.from(candidate, 'utf8');
  const b = Buffer.from(stored, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ─── Proof derivation (crash-safe, reproducible) + hashing ───

export interface ProofDomainInputs {
  handle: string;
  requestId: string;
  purpose: string;
  channel: string;
}

/**
 * Deterministically derives the raw proof token from domain-separated
 * inputs and an EXPLICIT key version — never a fresh random draw. This is
 * what makes a verify replay (same requestId) return the exact same,
 * still-usable raw token without it ever being persisted anywhere: Node
 * re-derives it from (handle, requestId, purpose, channel) every time,
 * whether this is the first verify call or a replay of an already-
 * committed one (e.g. after a transport loss). Only hashProofToken's
 * output of this value is ever stored.
 */
export function deriveProofToken(inputs: ProofDomainInputs, keyVersion: number, env: NodeJS.ProcessEnv = process.env): string {
  const key = subKey('gv-proof-derive-v1', keyVersion, env);
  const digest = createHmac('sha256', key)
    .update(`${inputs.purpose}|${inputs.channel}|${inputs.handle}|${inputs.requestId}`)
    .digest();
  return `gvp_${digest.toString('base64url')}`;
}

/**
 * `keyVersion` should be the SAME version used to derive the token
 * (explicit, not "whatever the current rotation happens to be" — matching
 * the OTP digest's own versioning discipline). Defaults to the current
 * version only for callers with no challenge-scoped version to pin to.
 */
export function hashProofToken(rawToken: string, keyVersion?: number, env: NodeJS.ProcessEnv = process.env): string {
  const version = keyVersion ?? currentVersion(env);
  const key = subKey('gv-proof-v1', version, env);
  return `v${version}:${createHmac('sha256', key).update(rawToken).digest('hex')}`;
}

// ─── Destination / subject hashing (for domain separation + rate-limit bucketing) ───

export function hashDestination(normalizedDestination: string, env: NodeJS.ProcessEnv = process.env): string {
  const version = currentVersion(env);
  const key = subKey('gv-destination-v1', version, env);
  return createHmac('sha256', key).update(normalizedDestination).digest('hex');
}

export function hashSubjectRef(rawSubjectRef: string, env: NodeJS.ProcessEnv = process.env): string {
  const version = currentVersion(env);
  const key = subKey('gv-subject-v1', version, env);
  return createHmac('sha256', key).update(rawSubjectRef).digest('hex');
}

// ─── IPv4/IPv6-safe rate-limit IP hashing ───
//
// Collapses an IPv6 address to its /64 network prefix BEFORE hashing, so a
// client that rotates through many addresses in the same /64 allocation
// (privacy extensions / SLAAC — common default behavior, not adversarial by
// itself) cannot mint a fresh rate-limit bucket on every request. Neither
// of this codebase's existing IP-hashing helpers do this collapse
// (server/utils/clientIp.ts's hashIp(), server/services/phoneVerification/
// crypto.ts's hashIpForRateLimit() both hash the full address) — this is a
// deliberate improvement for the generic core, documented in
// docs/GENERIC_VERIFICATION_SECURITY.md, not a bug carried over from
// either reference system.
export function collapseIpForRateLimit(ip: string): string {
  if (ip.includes(':')) {
    // IPv6: keep the first 4 hextets (/64), zero the rest.
    const hextets = ip.split(':').filter((_, i, arr) => !(arr[i] === '' && i !== 0 && i !== arr.length - 1));
    // Handle "::" compression by expanding minimally: if fewer than 8
    // groups and a double-colon was present, we only need the FIRST four
    // non-empty groups from the left for a /64 prefix — a full canonical
    // expansion isn't required for bucketing purposes.
    const leading = ip.split('::')[0].split(':').filter(Boolean);
    const prefixGroups = leading.slice(0, 4);
    while (prefixGroups.length < 4) prefixGroups.push('0');
    return prefixGroups.join(':') + '::/64';
  }
  return ip;
}

export function hashIpForRateLimit(ip: string | null, env: NodeJS.ProcessEnv = process.env): string {
  if (!ip) return '';
  const version = currentVersion(env);
  const key = subKey('gv-ratelimit-ip-v1', version, env);
  return createHmac('sha256', key).update(collapseIpForRateLimit(ip)).digest('hex').slice(0, 32);
}

// ─── Idempotency key / fingerprint derivation ───

export function deriveIdempotencyKey(parts: { operation: string; scopeKind: string; actorRef: string; requestId: string }, env: NodeJS.ProcessEnv = process.env): string {
  const version = currentVersion(env);
  const key = subKey('gv-idempotency-key-v1', version, env);
  return createHmac('sha256', key)
    .update(['gv-idem-v1', parts.operation, parts.scopeKind, parts.actorRef, parts.requestId].join('|'))
    .digest('hex');
}

/** Canonicalizes an object (recursively sorted keys) so fingerprinting is stable regardless of key order. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[k] = canonicalize((value as Record<string, unknown>)[k]);
    }
    return sorted;
  }
  return value;
}

export function deriveRequestFingerprint(intent: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env): string {
  const version = currentVersion(env);
  const key = subKey('gv-idempotency-fingerprint-v1', version, env);
  return createHmac('sha256', key).update(JSON.stringify(canonicalize(intent))).digest('hex');
}
