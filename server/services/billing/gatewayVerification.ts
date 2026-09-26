// ============================================================
// GATEWAY VERIFICATION — pure, fail-closed decision helpers for the Iranian
// one-time gateways (no I/O, so every rule here is unit-testable).
//
//   1. Reference binding: the callback's reference for THIS provider must be
//      exactly the reference stored on the intent at checkout. Every declared
//      callback key that is present must carry that same value — a second,
//      conflicting key (e.g. `Authority=B&authority=A`) is a mismatch, not a
//      "some key matched" pass.
//   2. The gateway verify call is made with the STORED reference and the
//      SERVER amount, never with values taken from the callback query.
//   3. The gateway-confirmed amount must equal the intent's expected amount;
//      a verify result without an amount fails closed.
//   4. "Already verified" (ZarinPal/IDPay/IranDargah 101, Zibal 201, SEP 2)
//      is success ONLY for an intent that itself already passed verification
//      (it is `processing` and carries the verification marker written when
//      it was claimed). It can never finalize a different / new intent.
//
// Residual note (SEP, PayPing): their verify APIs are keyed by a second
// reference (SEP `RefNum`, PayPing `refid`) that the verify response does not
// tie back to the checkout reference (SEP `Token`, PayPing `code`). For those
// the guarantee is: callback Token/code must equal the stored reference, the
// verify is one-shot at the gateway (a second verify of the same RefNum/refid
// reports "already verified", which is only accepted for the intent that
// consumed it), and the confirmed amount must equal the intent amount.
// ============================================================

import type { PaymentIntentRow } from './paymentIntent.js';
import {
  extractProviderRefCandidates,
  getProviderReferenceContract,
  requiresReferenceBinding,
} from './providerBinding.js';

/** Provider verify results use this status for "already verified" answers. */
export const ALREADY_VERIFIED_STATUS = 'already_verified';

/** Metadata key of the marker written when an intent is claimed after verify. */
export const GATEWAY_VERIFICATION_METADATA_KEY = 'gateway_verification';

export type BindingResult = { ok: true } | { ok: false; reason: string };

export interface GatewayVerifyResult {
  verified: boolean;
  providerRef: string;
  amount?: number;
  status?: string;
}

export interface GatewayVerificationMarker {
  provider_ref: string | null;
  amount_irr: number;
  verified_at: string;
}

type BindableIntent = Pick<PaymentIntentRow, 'provider_name' | 'provider_ref'>;

/**
 * Fail-closed binding check.
 *
 *   - binding provider without a stored reference  -> reject;
 *   - callback without any reference               -> reject;
 *   - any declared key carrying a different value  -> reject;
 *   - every present declared key equals the stored -> accept.
 */
export function providerRefMatchesIntent(intent: BindableIntent, params: unknown): BindingResult {
  const providerName = intent.provider_name;
  const stored = (intent.provider_ref || '').trim();

  if (!stored) {
    if (requiresReferenceBinding(providerName)) {
      return { ok: false, reason: 'missing_stored_provider_reference' };
    }
    // Explicitly declared as having no bindable checkout reference.
    return { ok: true };
  }

  const candidates = extractProviderRefCandidates(providerName, params);
  if (candidates.length === 0) return { ok: false, reason: 'missing_provider_reference' };
  if (requiresReferenceBinding(providerName)) {
    // Declared contract: the provider's canonical key (and its spelling
    // variants) must ALL carry the stored reference.
    if (candidates.some((candidate) => candidate !== stored)) {
      return { ok: false, reason: 'provider_reference_mismatch' };
    }
    return { ok: true };
  }
  if (!candidates.includes(stored)) return { ok: false, reason: 'provider_reference_mismatch' };
  return { ok: true };
}

/** Amount the gateway must confirm for this intent (V2 `expected_amount_irr`, else `amount_irr`). */
export function expectedIntentAmountIrr(intent: Pick<PaymentIntentRow, 'amount_irr'> & {
  expected_amount_irr?: number | string | null;
}): number {
  const expected = Number(intent.expected_amount_irr);
  if (intent.expected_amount_irr !== null && intent.expected_amount_irr !== undefined && Number.isFinite(expected)) {
    return expected;
  }
  return Number(intent.amount_irr);
}

/**
 * Parameters handed to the provider's `verifyPayment`. Every declared
 * reference key is overwritten with the STORED reference (so the gateway is
 * asked about exactly the transaction bound to this intent) and `amount` is
 * the server amount. Only string/number callback values are forwarded.
 */
export function buildBoundVerifyParams(
  intent: BindableIntent,
  params: unknown,
  amountIrr: number,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof params === 'object' && params !== null && !Array.isArray(params)) {
    for (const [key, value] of Object.entries(params as Record<string, unknown>)) {
      if (typeof value === 'string') out[key] = value;
      else if (typeof value === 'number' && Number.isFinite(value)) out[key] = String(value);
    }
  }
  const stored = (intent.provider_ref || '').trim();
  if (stored) {
    for (const key of getProviderReferenceContract(intent.provider_name).callbackKeys) {
      out[key] = stored;
    }
  }
  out.amount = String(amountIrr);
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Reads the verification marker written when the intent was claimed. */
export function readGatewayVerificationMarker(
  intent: Pick<PaymentIntentRow, 'metadata'>,
): GatewayVerificationMarker | null {
  const raw = isRecord(intent.metadata) ? intent.metadata[GATEWAY_VERIFICATION_METADATA_KEY] : undefined;
  if (!isRecord(raw)) return null;
  const amount = raw.amount_irr;
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return null;
  const ref = raw.provider_ref;
  return {
    provider_ref: typeof ref === 'string' && ref ? ref : null,
    amount_irr: amount,
    verified_at: typeof raw.verified_at === 'string' ? raw.verified_at : '',
  };
}

export type GatewayVerificationDecision =
  | { ok: true; confirmedAmountIrr: number; alreadyVerified: boolean }
  | {
      ok: false;
      reason:
        | 'gateway_not_verified'
        | 'gateway_already_verified_unbound'
        | 'gateway_already_verified_reference_mismatch'
        | 'gateway_amount_missing'
        | 'gateway_amount_mismatch';
    };

/**
 * Decides whether a gateway verify result may finalize this intent.
 * Pure: the caller decides what to persist for each rejection reason.
 */
export function evaluateGatewayVerification(
  intent: Pick<PaymentIntentRow, 'status' | 'provider_ref' | 'metadata' | 'amount_irr'> & {
    expected_amount_irr?: number | string | null;
  },
  result: GatewayVerifyResult,
): GatewayVerificationDecision {
  if (!result.verified) return { ok: false, reason: 'gateway_not_verified' };

  const expected = expectedIntentAmountIrr(intent);
  const gatewayAmount =
    typeof result.amount === 'number' && Number.isFinite(result.amount) ? result.amount : null;
  const alreadyVerified = result.status === ALREADY_VERIFIED_STATUS;

  let confirmed = gatewayAmount;
  if (alreadyVerified) {
    // Only the intent that itself already passed verification may accept an
    // "already verified" answer (idempotent re-callback / crash recovery).
    const marker = readGatewayVerificationMarker(intent);
    if (intent.status !== 'processing' || !marker) {
      return { ok: false, reason: 'gateway_already_verified_unbound' };
    }
    const returnedRef = (result.providerRef || '').trim();
    const stored = (intent.provider_ref || '').trim();
    if (returnedRef && returnedRef !== marker.provider_ref && returnedRef !== stored) {
      return { ok: false, reason: 'gateway_already_verified_reference_mismatch' };
    }
    if (confirmed === null) confirmed = marker.amount_irr;
    if (marker.amount_irr !== expected) return { ok: false, reason: 'gateway_amount_mismatch' };
  }

  if (confirmed === null) return { ok: false, reason: 'gateway_amount_missing' };
  if (!Number.isFinite(expected) || expected <= 0 || confirmed !== expected) {
    return { ok: false, reason: 'gateway_amount_mismatch' };
  }
  return { ok: true, confirmedAmountIrr: confirmed, alreadyVerified };
}

/** Builds the marker persisted on the intent when it is claimed after verify. */
export function buildGatewayVerificationMarker(
  providerRef: string | null,
  amountIrr: number,
  now: Date = new Date(),
): GatewayVerificationMarker {
  return { provider_ref: providerRef || null, amount_irr: amountIrr, verified_at: now.toISOString() };
}

/**
 * Iranian gateways always charge in IRR. The client may omit the currency or
 * send IRR; any other currency is rejected (never used as a price key whose
 * number would then be charged as Rial).
 */
export function resolveIrrPlanPrice(
  prices: unknown,
  interval: 'monthly' | 'yearly',
  clientCurrency: string | null | undefined,
): { ok: true; amountIrr: number } | { ok: false; error: 'CURRENCY_NOT_SUPPORTED' | 'PRICE_NOT_AVAILABLE' } {
  const requested = (clientCurrency ?? '').trim().toUpperCase();
  if (requested && requested !== 'IRR') return { ok: false, error: 'CURRENCY_NOT_SUPPORTED' };
  const irr = isRecord(prices) ? prices.IRR : undefined;
  const raw = isRecord(irr) ? irr[interval] : undefined;
  if (raw === null || raw === undefined || raw === '') return { ok: false, error: 'PRICE_NOT_AVAILABLE' };
  const amount = Number(raw);
  if (!Number.isFinite(amount) || amount < 0) return { ok: false, error: 'PRICE_NOT_AVAILABLE' };
  return { ok: true, amountIrr: amount };
}
