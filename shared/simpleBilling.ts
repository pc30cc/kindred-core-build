/**
 * The simple prepaid billing (docs/billing/SIMPLE_BILLING.md): rules shared by
 * the server and the browser. Pure: no I/O.
 *
 * Amounts are integers in the minor units of their currency: Rial for IRR
 * (shown as Toman in the Iranian edition), cents for USD, kuruş for TRY.
 */

/** Smallest and largest top-up a customer may start, per currency (net, minor units). */
export const TOPUP_LIMITS: Readonly<Record<string, { min: number; max: number }>> = {
  // 10,000 to 1,000,000,000 Toman.
  IRR: { min: 100_000, max: 10_000_000_000 },
  // $5 to $50,000.
  USD: { min: 500, max: 5_000_000 },
  // 100 TL to 2,000,000 TL.
  TRY: { min: 10_000, max: 200_000_000 },
  EUR: { min: 500, max: 5_000_000 },
  GBP: { min: 500, max: 5_000_000 },
};

export type TopupAmountProblem = 'TOPUP_AMOUNT_INVALID' | 'TOPUP_AMOUNT_TOO_SMALL' | 'TOPUP_AMOUNT_TOO_LARGE' | 'CURRENCY_NOT_SUPPORTED';

/** Why a top-up amount cannot be charged, or null when it can. */
export function topupAmountProblem(netMinor: unknown, currency: string): TopupAmountProblem | null {
  const limits = TOPUP_LIMITS[currency.toUpperCase()];
  if (!limits) return 'CURRENCY_NOT_SUPPORTED';
  if (typeof netMinor !== 'number' || !Number.isSafeInteger(netMinor) || netMinor <= 0) return 'TOPUP_AMOUNT_INVALID';
  if (netMinor < limits.min) return 'TOPUP_AMOUNT_TOO_SMALL';
  if (netMinor > limits.max) return 'TOPUP_AMOUNT_TOO_LARGE';
  return null;
}

/**
 * The VAT percent configured for a currency, or null when there is none to
 * show (missing, empty, zero or not a number). "Empty means not shown."
 */
export function vatPercentFor(vatByCurrency: unknown, currency: string): number | null {
  if (typeof vatByCurrency !== 'object' || vatByCurrency === null || Array.isArray(vatByCurrency)) return null;
  const raw = (vatByCurrency as Record<string, unknown>)[currency.toUpperCase()];
  if (raw === null || raw === undefined || raw === '') return null;
  const pct = Number(raw);
  if (!Number.isFinite(pct) || pct <= 0 || pct >= 100) return null;
  return Math.round(pct * 1000) / 1000;
}

/** What the customer pays for `netMinor` of credit: the net, the VAT on it, and their sum. */
export function chargeFor(netMinor: number, vatPercent: number | null): { net: number; tax: number; total: number } {
  const tax = vatPercent ? Math.round((netMinor * vatPercent) / 100) : 0;
  return { net: netMinor, tax, total: netMinor + tax };
}

/** Keys of the buyer's billing profile printed on receipts. */
export const BILLING_PROFILE_KEYS = [
  'company',
  'economic_code',
  'national_id',
  'vat_id',
  'address',
  'postal_code',
  'city',
  'country',
  'phone',
  'invoice_email',
] as const;
export type BillingProfileKey = (typeof BILLING_PROFILE_KEYS)[number];
export type BillingProfile = Partial<Record<BillingProfileKey, string>>;

/** Keys of the seller printed on receipts (Super Admin, per edition). */
export const SELLER_KEYS = [
  'legal_name',
  'economic_code',
  'national_id',
  'registration_number',
  'vat_id',
  'address',
  'postal_code',
  'phone',
  'email',
  'website',
] as const;
export type SellerKey = (typeof SELLER_KEYS)[number];
export type SellerProfile = Partial<Record<SellerKey, string>>;

/** Keeps the known keys with trimmed, non-empty, length-capped string values. */
export function cleanProfile<K extends string>(input: unknown, keys: readonly K[], maxLength = 300): Partial<Record<K, string>> {
  const out: Partial<Record<K, string>> = {};
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return out;
  for (const key of keys) {
    const value = (input as Record<string, unknown>)[key];
    if (typeof value !== 'string') continue;
    const trimmed = value.trim().slice(0, maxLength);
    if (trimmed) out[key] = trimmed;
  }
  return out;
}

/** Kinds of balance movements (billing_account_ledger.kind). */
export const LEDGER_KINDS = [
  'topup', 'renewal', 'upgrade', 'plan', 'ai_pack',
  'admin_credit', 'admin_debit', 'refund', 'prepaid_return',
] as const;
export type LedgerKind = (typeof LEDGER_KINDS)[number];

/** Status of a gateway attempt (billing_account_payments.status). */
export type AccountPaymentStatus = 'pending' | 'succeeded' | 'failed' | 'canceled' | 'expired';

// ─── Saved card (phase 3b, migration 262) ──────────────────────────────────
// A Multi Region card is a Paddle subscription whose clock we move: Paddle
// charges the next period this long before our period ends, so a decline
// still leaves a day to fix the card before the workspace moves to Free.

/** Paddle's next_billed_at = the end of the last paid period − this lead. */
export const CARD_RENEWAL_LEAD_MS = 24 * 60 * 60 * 1000;
/** Paddle is never asked for a charge date sooner than now + this. */
export const CARD_MIN_LEAD_FROM_NOW_MS = 45 * 60 * 1000;
/** A charge date later than the period end − this is too late to renew in time. */
export const CARD_LATEST_BEFORE_END_MS = 10 * 60 * 1000;
/** Plan changes are frozen from Paddle's charge date − this ... */
export const CARD_FREEZE_BEFORE_MS = 2 * 60 * 60 * 1000;
/** ... until Paddle moves that date on, at most this long after it. */
export const CARD_FREEZE_MAX_AFTER_MS = 6 * 60 * 60 * 1000;
/** A card with no paid period yet waits this long for its setup payment. */
export const CARD_SETUP_HOLD_MS = 2 * 60 * 60 * 1000;
/** The job registers the card of a paid card checkout that has none after this long. */
export const CARD_ACTIVATION_RECOVERY_MS = 10 * 60 * 1000;
/** The job looks up a /charge whose outcome it does not know after this long ... */
export const CARD_CHARGE_RESOLVE_AFTER_MS = 2 * 60 * 1000;
/** ... and fails it (charge_not_found) when Paddle shows no charge after this long. */
export const CARD_CHARGE_GIVE_UP_MS = 60 * 60 * 1000;
/** Every live card is checked against Paddle at least this often. */
export const CARD_RESYNC_MS = 6 * 60 * 60 * 1000;
/** A Paddle charge date off by more than this is corrected. */
export const CARD_SYNC_DATE_TOLERANCE_MS = 60 * 1000;
/** The smallest amount Paddle charges, per currency (minor units). */
export const PADDLE_MIN_CHARGE_MINOR: Readonly<Record<string, number>> = { USD: 70, EUR: 70, GBP: 70 };
/** Account currencies a card can renew in (Multi Region and Global). */
export const CARD_CURRENCIES: readonly string[] = ['USD'];
/** billing_account_cards.status: active and past_due are "live". */
export type CardStatus = 'active' | 'past_due' | 'canceling' | 'canceled';
