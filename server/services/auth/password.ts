/**
 * Password hashing — Argon2id via @node-rs/argon2 (prebuilt native binaries,
 * including musl/Alpine — matches this project's Dockerfile.server base
 * image, see SELF_HOST_GUIDE.md). Never invent hashing here; this module is
 * the only place in the codebase allowed to call the underlying library.
 *
 * Parameters follow OWASP's current Argon2id baseline (19 MiB memory,
 * t=2, p=1) — the minimum recommended, not a maximum. `CURRENT_PARAMS` is
 * the single source of truth so `needsRehash` can detect a stored hash that
 * predates a future parameter bump.
 */
import { hash as argon2Hash, verify as argon2Verify } from '@node-rs/argon2';

// @node-rs/argon2 exports `Algorithm` as a `const enum`, which this
// project's `isolatedModules` tsconfig setting forbids importing across
// module boundaries (each file must be independently transpilable). Use the
// underlying numeric value directly instead — Argon2id = 2, per
// node_modules/@node-rs/argon2/index.d.ts.
const ARGON2ID = 2;

export const CURRENT_PARAMS = Object.freeze({
  algorithm: ARGON2ID,
  memoryCost: 19456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
});

const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 512; // reject unreasonable payloads before they ever reach argon2

export class InvalidPasswordError extends Error {}

function assertValidPassword(password: unknown): asserts password is string {
  if (typeof password !== 'string') {
    throw new InvalidPasswordError('Password must be a string');
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new InvalidPasswordError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new InvalidPasswordError('Password is too long');
  }
}

/** Hash a plaintext password. Throws InvalidPasswordError for policy violations — never hashes an out-of-policy password. */
export async function hashPassword(password: string): Promise<string> {
  assertValidPassword(password);
  return argon2Hash(password, { ...CURRENT_PARAMS });
}

/**
 * Verify a plaintext password against a stored Argon2 hash. Never throws on
 * a wrong password — returns false. Only throws for genuinely malformed
 * input (not a policy check; login callers should treat any throw as a
 * verification failure, not surface it to the client).
 */
export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  if (typeof password !== 'string' || password.length === 0 || password.length > MAX_PASSWORD_LENGTH) {
    return false;
  }
  try {
    return await argon2Verify(hash, password);
  } catch {
    // Malformed/foreign hash format (e.g. a legacy non-argon2 value) —
    // treat as a verification failure, not a crash.
    return false;
  }
}

/**
 * True if `hash` was produced with weaker-than-current parameters and
 * should be silently rehashed on next successful login. Parses the PHC
 * string format ($argon2id$v=19$m=..,t=..,p=..$...) rather than trusting
 * any out-of-band metadata, so it stays correct even if a caller's
 * `password_algo` column drifts from what was actually stored.
 */
export function needsRehash(hash: string): boolean {
  const m = /^\$argon2id\$v=\d+\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(hash);
  if (!m) return true; // not argon2id at all (e.g. a legacy hash) — always upgrade
  const [, memoryCost, timeCost, parallelism] = m.map(Number) as unknown as [number, number, number, number];
  return (
    memoryCost < CURRENT_PARAMS.memoryCost ||
    timeCost < CURRENT_PARAMS.timeCost ||
    parallelism < CURRENT_PARAMS.parallelism
  );
}
