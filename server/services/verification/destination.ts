/**
 * Generic Verification Core v1 — destination normalization/masking.
 *
 * Email normalization is local to this module (trim + lowercase — the same
 * rule server/routes/auth.ts already applies to login/signup emails
 * elsewhere in this codebase, kept here as a small self-contained function
 * rather than importing route code). Phone normalization REUSES the
 * existing, already-tested `normalizePhoneToE164`/`maskE164` from
 * server/services/phoneVerification/phone.ts — a pure, stateless utility
 * with no coupling to that subsystem's tables/RPCs, exactly the kind of
 * "safe low-level extraction" the task asked for.
 */
import { normalizePhoneToE164, maskE164 } from '../phoneVerification/phone.js';
import type { VerificationChannel } from './types.js';

export interface NormalizedDestination {
  ok: boolean;
  normalized?: string;
  masked?: string;
  reason?: string;
}

function normalizeEmail(raw: string): NormalizedDestination {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
    return { ok: false, reason: 'invalid_email' };
  }
  const [local, domain] = trimmed.split('@');
  const maskedLocal = local.length <= 2 ? `${local[0] ?? ''}*` : `${local.slice(0, 2)}${'*'.repeat(Math.max(local.length - 2, 1))}`;
  return { ok: true, normalized: trimmed, masked: `${maskedLocal}@${domain}` };
}

/** `country` is only consulted for `channel: 'sms'`; ignored for email. */
export function normalizeDestination(channel: VerificationChannel, raw: string, country?: string): NormalizedDestination {
  if (channel === 'email') return normalizeEmail(raw);

  const result = normalizePhoneToE164(raw, country ?? 'IR');
  if (result.ok === true) {
    return { ok: true, normalized: result.e164, masked: maskE164(result.e164) ?? undefined };
  }
  const failureReason: string = 'reason' in result ? result.reason : 'invalid_phone';
  return { ok: false, reason: failureReason };
}
