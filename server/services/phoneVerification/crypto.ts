/**
 * OTP generation and digest handling.
 *
 * The code space is only 10^6, so a bare SHA-256 digest would be brute
 * forceable from a database leak. Every digest is an HMAC keyed by a
 * server-only pepper (`PHONE_VERIFICATION_PEPPER`) and bound to the
 * challenge id, the user id and the phone number, so a digest cannot be
 * replayed against another challenge. The raw code is never stored, logged
 * or returned.
 */

import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';

export class PhoneVerificationPepperMissing extends Error {
  constructor() {
    super('PHONE_VERIFICATION_PEPPER is not configured');
    this.name = 'PhoneVerificationPepperMissing';
  }
}

/** Fail-closed: without a pepper no code can be issued or checked. */
export function getPepper(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.PHONE_VERIFICATION_PEPPER;
  if (typeof value !== 'string' || value.trim().length < 16) {
    throw new PhoneVerificationPepperMissing();
  }
  return value.trim();
}

export function hasPepper(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    getPepper(env);
    return true;
  } catch {
    return false;
  }
}

/** Cryptographically uniform 6-digit code. Never `Math.random`. */
export function generateOtpCode(): string {
  return String(randomInt(100000, 1000000));
}

export function digestCode(input: {
  challengeId: string;
  userId: string;
  phoneE164: string;
  code: string;
  env?: NodeJS.ProcessEnv;
}): string {
  const pepper = getPepper(input.env);
  return createHmac('sha256', pepper)
    .update(`${input.challengeId}:${input.userId}:${input.phoneE164}:${input.code}`)
    .digest('hex');
}

/** Constant-time digest comparison. */
export function digestsMatch(a: string, b: string): boolean {
  const left = Buffer.from(String(a ?? ''), 'utf8');
  const right = Buffer.from(String(b ?? ''), 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Irreversible IP fingerprint for rate limiting — the raw IP is never stored. */
export function hashIpForRateLimit(ip: string | null, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!ip) return null;
  const pepper = getPepper(env);
  return createHmac('sha256', pepper).update(`ip:${ip}`).digest('hex').slice(0, 32);
}