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
 *
 * TWO SEPARATE ROTATION DOMAINS — do not conflate them:
 *
 *   1. ROTATING material (OTP codes, proof tokens): keyed by whatever
 *      version is recorded on the specific challenge/proof at the moment it
 *      was created — `deriveOtpCode`/`digestOtpCode`/`candidateOtpDigest`
 *      take an explicit `keyVersion` argument (the challenge's own
 *      `key_version` column), and `deriveProofToken`/`hashProofToken`
 *      embed their version directly IN the token
 *      (`gvp_v<N>_<value>` — see §Proof derivation below) and parse it back
 *      out rather than trusting whatever version happens to be "current"
 *      at the moment of a later call. `GENERIC_VERIFICATION_KEY_VERSION`
 *      only ever affects what NEW challenges/proofs are created under —
 *      it must never be consulted when recomputing a digest for an
 *      EXISTING row, or every outstanding challenge/proof breaks the
 *      instant an operator rotates the "current" pointer.
 *
 *   2. STABLE INDEX material (destination hash, subject-ref hash, IP
 *      rate-limit bucket hash, idempotency key, request fingerprint): these
 *      are used to LOOK UP and MATCH existing rows (`WHERE destination_hash
 *      = $1`, `WHERE key = $1`, rate-limit bucket counts, a retried
 *      request's idempotency key) — they must be byte-identical every time
 *      the same logical input is hashed, REGARDLESS of how many times the
 *      OTP/proof "current version" has advanced in between. They are
 *      therefore pinned to `STABLE_INDEX_KEY_VERSION` (see below), which is
 *      independent of `GENERIC_VERIFICATION_KEY_VERSION` and does NOT
 *      change when the OTP/proof rotation pointer changes.
 *
 * Rotating the STABLE index key itself (as opposed to the OTP/proof
 * rotation pointer) is a fundamentally different, much rarer operation than
 * an ordinary OTP pepper rotation, and it is NOT something a migration can
 * do for you automatically: `hashDestination`/`hashSubjectRef`/
 * `hashIpForRateLimit`/`deriveIdempotencyKey`/`deriveRequestFingerprint`
 * are HMACs over the ORIGINAL raw input (the actual email/phone, the
 * actual IP address, the actual caller-supplied request id) — this
 * codebase does not retain those raw inputs anywhere once hashed (by
 * design, see docs/GENERIC_VERIFICATION_SECURITY.md), so nothing can
 * "recompute every stored hash under the new version" after the fact. The
 * only supported procedure is: (1) quiesce verification traffic for this
 * subsystem; (2) wait for every existing challenge, proof, rate-limit
 * window, and idempotency ledger entry to expire under its own TTL; (3)
 * purge the expired rows; (4) only then change `STABLE_INDEX_KEY_VERSION`
 * below and deploy; (5) resume traffic. An operator who instead needs live
 * rotation without a quiesce window must implement a genuinely
 * version-aware dual-read migration (checking both the old- and new-version
 * hash until every indexed row has been re-hashed under the new one) —
 * this codebase does not implement that. `STABLE_INDEX_KEY_VERSION` is a
 * source constant (not an env var) precisely to make this a deliberate,
 * reviewed code change rather than an accidental side effect of an
 * ordinary OTP pepper rotation. Whatever pepper-ring entry backs
 * `STABLE_INDEX_KEY_VERSION` (version 1, today) must remain present in
 * `GENERIC_VERIFICATION_PEPPER_RING` for as long as ANY indexed row (a live
 * challenge, a live idempotency-ledger row, a live proof, or an active
 * rate-limit window) exists — "keep old versions until every challenge
 * created with them has expired" (correct and sufficient for the ROTATING
 * OTP/proof domain) is NOT sufficient for version 1, because it also backs
 * every stable-index lookup. Removing it prematurely fails closed
 * (`DerivationKeyUnavailableError`) rather than silently corrupting lookups.
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

/**
 * A distinct, dedicated error for a MALFORMED or internally INCONSISTENT
 * crypto configuration — GENERIC_VERIFICATION_PEPPER_RING that isn't valid
 * JSON, isn't an object, has an invalid version key or too-short value, is
 * an empty ring, disagrees with GENERIC_VERIFICATION_PEPPER for version 1,
 * or an explicitly-set GENERIC_VERIFICATION_KEY_VERSION that is invalid or
 * absent from the ring. Deliberately distinct from
 * `VerificationPepperMissingError` (which means "nothing at all is
 * configured" and is expected to fail lazily, at first use) — a
 * `VerificationConfigError` means something WAS configured but is broken,
 * and must never be silently downgraded to "unconfigured" or "use whatever
 * default is available instead."
 */
export class VerificationConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VerificationConfigError';
  }
}

const MIN_PEPPER_LENGTH = 32;

/** A ring/version-config key must be a positive integer with no leading zeros, sign, or decimal point. */
const VALID_VERSION_KEY = /^[1-9][0-9]*$/;

/** Bounded, "reasonable" ceiling for any key version — see hashProofToken's own bound for why an unbounded version is unsafe. */
const MAX_KEY_VERSION = 1_000_000;

/**
 * The FIXED key version backing every stable-index derivation (destination
 * hash, subject-ref hash, IP rate-limit hash, idempotency key, request
 * fingerprint). Deliberately NOT read from an env var and NOT the same
 * thing as `currentVerificationKeyVersion()` (which only governs NEW
 * OTP/proof rotation) — see the module-level doc comment's "TWO SEPARATE
 * ROTATION DOMAINS" section. Changing this constant is a deliberate,
 * dedicated re-indexing operation, not an ordinary deploy.
 */
const STABLE_INDEX_KEY_VERSION = 1;

let cachedRing: Map<number, string> | null = null;
let cachedCurrentVersion: number | null = null;

/**
 * Loads and validates the pepper ring. Distinguishes two very different
 * failure modes:
 *
 *   - NOTHING configured at all (neither GENERIC_VERIFICATION_PEPPER nor
 *     GENERIC_VERIFICATION_PEPPER_RING is set) — returns an EMPTY ring.
 *     This is the documented "unconfigured" state, which fails LAZILY —
 *     `VerificationPepperMissingError` is thrown later, at first actual use
 *     (keyForVersion), not here. This lets a deployment that never touches
 *     this dormant subsystem start up without setting these vars at all.
 *   - SOMETHING is configured but is malformed or internally inconsistent
 *     (invalid JSON, a non-object, an invalid version key, a too-short
 *     value, an explicit ring that resolves to zero usable entries, or a
 *     GENERIC_VERIFICATION_PEPPER that disagrees with ring version "1") —
 *     throws `VerificationConfigError` IMMEDIATELY, here. A value that was
 *     actually provided and is broken must never be silently ignored or
 *     silently overridden; that would mask an operational mistake as an
 *     ordinary "not configured" state.
 */
function loadRing(env: NodeJS.ProcessEnv = process.env): Map<number, string> {
  if (cachedRing) return cachedRing;

  const rawBase = env.GENERIC_VERIFICATION_PEPPER;
  const trimmedBase = rawBase?.trim();
  const baseProvided = Boolean(trimmedBase);
  if (baseProvided && trimmedBase!.length < MIN_PEPPER_LENGTH) {
    throw new VerificationConfigError(`GENERIC_VERIFICATION_PEPPER must be at least ${MIN_PEPPER_LENGTH} characters`);
  }

  const rawRing = env.GENERIC_VERIFICATION_PEPPER_RING;
  const ringProvided = Boolean(rawRing?.trim());
  const ringEntries = new Map<number, string>();
  if (ringProvided) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawRing!.trim());
    } catch {
      throw new VerificationConfigError('GENERIC_VERIFICATION_PEPPER_RING is not valid JSON');
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new VerificationConfigError('GENERIC_VERIFICATION_PEPPER_RING must be a JSON object mapping version numbers to secrets');
    }
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (!VALID_VERSION_KEY.test(k) || Number.parseInt(k, 10) > MAX_KEY_VERSION) {
        throw new VerificationConfigError(`GENERIC_VERIFICATION_PEPPER_RING has an invalid version key: "${k}" (must be a positive integer, no leading zeros)`);
      }
      if (typeof v !== 'string' || v.length < MIN_PEPPER_LENGTH) {
        throw new VerificationConfigError(`GENERIC_VERIFICATION_PEPPER_RING version ${k} must be a string of at least ${MIN_PEPPER_LENGTH} characters`);
      }
      ringEntries.set(Number.parseInt(k, 10), v);
    }
    if (ringEntries.size === 0) {
      throw new VerificationConfigError('GENERIC_VERIFICATION_PEPPER_RING must not be an empty object — omit it entirely if there is no ring');
    }
  }

  // Version 1 has exactly one source of truth. If both GENERIC_VERIFICATION_PEPPER
  // and an explicit ring["1"] are supplied, they must be byte-identical —
  // never silently let one override the other, which would mean whichever
  // value "wins" depends on object iteration order rather than being an
  // explicit, reviewed choice.
  if (baseProvided && ringEntries.has(1) && ringEntries.get(1) !== trimmedBase) {
    throw new VerificationConfigError(
      'GENERIC_VERIFICATION_PEPPER and GENERIC_VERIFICATION_PEPPER_RING version 1 are both configured but do not match — they must be identical',
    );
  }

  const ring = new Map<number, string>();
  if (baseProvided) ring.set(1, trimmedBase!);
  for (const [version, value] of ringEntries) ring.set(version, value);

  cachedRing = ring;
  return ring;
}

/**
 * Resolves the CURRENT key version used for NEW challenges/proofs. An
 * explicitly-configured GENERIC_VERIFICATION_KEY_VERSION that is invalid
 * (not a bounded positive integer) or not present in the ring FAILS CLOSED
 * with `VerificationConfigError` — it never silently falls back to
 * `max(ring.keys())`, since that fallback could silently start issuing new
 * challenges/proofs under a DIFFERENT version than the operator explicitly
 * intended, without any error ever surfacing. The `max(ring.keys())`
 * default only applies when GENERIC_VERIFICATION_KEY_VERSION is not set at
 * all — an actual operator choice, once made, is never second-guessed.
 */
function currentVersion(env: NodeJS.ProcessEnv = process.env): number {
  if (cachedCurrentVersion !== null) return cachedCurrentVersion;
  const ring = loadRing(env);
  const rawConfigured = env.GENERIC_VERIFICATION_KEY_VERSION?.trim();
  if (rawConfigured) {
    if (!VALID_VERSION_KEY.test(rawConfigured) || Number.parseInt(rawConfigured, 10) > MAX_KEY_VERSION) {
      throw new VerificationConfigError(`GENERIC_VERIFICATION_KEY_VERSION "${rawConfigured}" is not a valid positive integer`);
    }
    const configured = Number.parseInt(rawConfigured, 10);
    if (!ring.has(configured)) {
      throw new VerificationConfigError(`GENERIC_VERIFICATION_KEY_VERSION ${configured} is not present in the configured pepper ring`);
    }
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

export class InvalidProofTokenFormatError extends Error {
  constructor() {
    super('Proof token is not well-formed (expected gvp_v<N>_<value>)');
    this.name = 'InvalidProofTokenFormatError';
  }
}

// A proof value is ALWAYS a 32-byte HMAC-SHA256 digest, base64url-encoded
// with no padding — exactly 43 characters (ceil(32 * 8 / 6)), never fewer
// (truncated) or more (oversized/injected garbage). The version group is
// intentionally unbounded HERE (bounded explicitly in parseProofToken
// below via MAX_KEY_VERSION) so a huge version is rejected with the same
// clear signal as any other malformed token, rather than by regex
// backtracking behavior.
const PROOF_TOKEN_PATTERN = /^gvp_v([1-9][0-9]*)_([A-Za-z0-9_-]{43})$/;

/**
 * Deterministically derives the raw proof token from domain-separated
 * inputs and an EXPLICIT key version — never a fresh random draw, and
 * never `currentVerificationKeyVersion()` read again at replay time (that
 * was the exact bug this format closes: a proof derived at verify-time T0
 * would silently re-derive to a DIFFERENT token if the OTP rotation
 * pointer advanced between T0 and a same-`requestId` replay at T1). The
 * caller must pass the version that is STABLE for the specific
 * challenge/request — e.g. the challenge's own recorded `key_version` — not
 * whatever `currentVerificationKeyVersion()` happens to return right now.
 *
 * The version is embedded directly in the output (`gvp_v<N>_<value>`, never
 * secret) so `hashProofToken` can always recover and use the EXACT version
 * a token was derived under, without a database round-trip and without any
 * possibility of hashing it under the wrong (current-at-consume-time) key —
 * this is what makes a proof issued under key v1 still consumable after the
 * deployment rotates to v2, as long as v1 remains in the ring.
 */
export function deriveProofToken(inputs: ProofDomainInputs, keyVersion: number, env: NodeJS.ProcessEnv = process.env): string {
  const key = subKey('gv-proof-derive-v1', keyVersion, env);
  const digest = createHmac('sha256', key)
    .update(`${inputs.purpose}|${inputs.channel}|${inputs.handle}|${inputs.requestId}`)
    .digest();
  return `gvp_v${keyVersion}_${digest.toString('base64url')}`;
}

/**
 * Strictly parses `gvp_v<N>_<value>`. Returns null for anything else —
 * including: the OLD, pre-versioned `gvp_<value>` format (deliberately no
 * longer accepted); a truncated or oversized value (the value MUST be
 * exactly 43 base64url characters — the encoded length of a 32-byte
 * digest); and a version that is zero, negative, non-numeric, or
 * unreasonably huge (bounded by `MAX_KEY_VERSION`) — `Number.parseInt`
 * alone would silently accept e.g. a 40-digit version string as some
 * enormous (but technically parseable) number, so the bound is checked
 * explicitly rather than trusted to the regex's digit-count alone.
 */
export function parseProofToken(rawToken: string): { version: number; value: string } | null {
  const m = PROOF_TOKEN_PATTERN.exec(rawToken);
  if (!m) return null;
  const version = Number.parseInt(m[1], 10);
  if (!Number.isSafeInteger(version) || version <= 0 || version > MAX_KEY_VERSION) return null;
  return { version, value: m[2] };
}

/**
 * Hashes a raw proof token for storage/comparison, ALWAYS under the version
 * embedded in the token itself — never an externally supplied or
 * "current" version. Throws `InvalidProofTokenFormatError` for a
 * malformed token (callers should treat this as an ordinary consume
 * failure, not a 500).
 */
export function hashProofToken(rawToken: string, env: NodeJS.ProcessEnv = process.env): string {
  const parsed = parseProofToken(rawToken);
  if (!parsed) throw new InvalidProofTokenFormatError();
  const key = subKey('gv-proof-v1', parsed.version, env);
  return `v${parsed.version}:${createHmac('sha256', key).update(rawToken).digest('hex')}`;
}

// ─── Destination / subject hashing (stable index material — see the
// module-level "TWO SEPARATE ROTATION DOMAINS" doc comment; pinned to
// STABLE_INDEX_KEY_VERSION, NOT the current OTP/proof rotation pointer) ───

export function hashDestination(normalizedDestination: string, env: NodeJS.ProcessEnv = process.env): string {
  const key = subKey('gv-destination-v1', STABLE_INDEX_KEY_VERSION, env);
  return createHmac('sha256', key).update(normalizedDestination).digest('hex');
}

export function hashSubjectRef(rawSubjectRef: string, env: NodeJS.ProcessEnv = process.env): string {
  const key = subKey('gv-subject-v1', STABLE_INDEX_KEY_VERSION, env);
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
  const key = subKey('gv-ratelimit-ip-v1', STABLE_INDEX_KEY_VERSION, env);
  return createHmac('sha256', key).update(collapseIpForRateLimit(ip)).digest('hex').slice(0, 32);
}

// ─── Idempotency key / fingerprint derivation (stable index material —
// pinned to STABLE_INDEX_KEY_VERSION so a retried request's idempotency
// key is byte-identical before and after an OTP/proof key rotation; if it
// weren't, a retry submitted after a rotation would derive a DIFFERENT
// ledger key than the original attempt and would never find — let alone
// correctly replay — the original committed result) ───

export function deriveIdempotencyKey(parts: { operation: string; scopeKind: string; actorRef: string; requestId: string }, env: NodeJS.ProcessEnv = process.env): string {
  const key = subKey('gv-idempotency-key-v1', STABLE_INDEX_KEY_VERSION, env);
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
  const key = subKey('gv-idempotency-fingerprint-v1', STABLE_INDEX_KEY_VERSION, env);
  return createHmac('sha256', key).update(JSON.stringify(canonicalize(intent))).digest('hex');
}
