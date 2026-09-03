// ============================================================
// PROVIDER PAYMENT-REFERENCE BINDING (fail-closed)
//
// A payment intent may only be finalized with the payment reference the
// gateway handed back when THIS intent's checkout session was created
// (ZarinPal `Authority`, Zibal `trackId`, IDPay `id`, ...). Without that
// binding, a callback carrying payment B's reference could finalize intent A.
//
// The binding requirement is EXPLICIT per provider, never inferred: a missing
// reference must not be an implicit bypass. Providers that genuinely have no
// bindable checkout reference must be declared with
// `requiresPaymentReferenceBinding: false` and a documented reason.
// ============================================================

export interface ProviderReferenceContract {
  /** When true, checkout MUST produce a reference and callbacks MUST match it. */
  requiresPaymentReferenceBinding: boolean;
  /** Callback query keys that may carry this provider's checkout reference. */
  callbackKeys: string[];
  /** Why binding is not required (only for providers that opt out). */
  reason?: string;
}

const CONTRACTS: Record<string, ProviderReferenceContract> = {
  // ZarinPal returns `authority` at create and echoes `Authority` on callback.
  zarinpal:            { requiresPaymentReferenceBinding: true, callbackKeys: ['Authority', 'authority'] },
  zarinpal_test:       { requiresPaymentReferenceBinding: true, callbackKeys: ['Authority', 'authority'] },
  // IDPay create returns the payment `id`; callback echoes `id` (+ order_id).
  idpay:               { requiresPaymentReferenceBinding: true, callbackKeys: ['id', 'track_id', 'trackId'] },
  idpay_test:          { requiresPaymentReferenceBinding: true, callbackKeys: ['id', 'track_id', 'trackId'] },
  // Zibal create returns `trackId`; callback echoes `trackId`.
  zibal:               { requiresPaymentReferenceBinding: true, callbackKeys: ['trackId', 'trackid', 'track_id'] },
  // NextPay create returns `trans_id`; callback echoes `trans_id`.
  nextpay:             { requiresPaymentReferenceBinding: true, callbackKeys: ['trans_id', 'transid'] },
  // PayPing create returns the payment `code`; callback echoes `code` (+ refid).
  payping:             { requiresPaymentReferenceBinding: true, callbackKeys: ['code'] },
  // SEP/Shaparak create returns a `token`; the bank posts `Token` back.
  sep_shaparak:        { requiresPaymentReferenceBinding: true, callbackKeys: ['Token', 'token'] },
  // Local sandbox mirrors ZarinPal's authority contract.
  iranpardakht_sandbox:{ requiresPaymentReferenceBinding: true, callbackKeys: ['authority', 'Authority'] },
};

/** Generic fallback keys, used only for providers without a declared contract. */
const GENERIC_KEYS = [
  'Authority', 'authority', 'trackId', 'trackid', 'track_id',
  'id', 'refId', 'ref_id', 'refnum', 'RefNum', 'token', 'Token', 'trans_id', 'code',
];

export function getProviderReferenceContract(providerName: string): ProviderReferenceContract {
  return (
    CONTRACTS[providerName] ?? {
      requiresPaymentReferenceBinding: false,
      callbackKeys: GENERIC_KEYS,
      reason: 'provider_not_declared_no_bindable_checkout_reference',
    }
  );
}

export function requiresReferenceBinding(providerName: string): boolean {
  return getProviderReferenceContract(providerName).requiresPaymentReferenceBinding;
}

function readParam(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

/** Every reference candidate the callback carries, in contract order. */
export function extractProviderRefCandidates(providerName: string, params: unknown): string[] {
  if (typeof params !== 'object' || params === null) return [];
  const record = params as Record<string, unknown>;
  const contract = getProviderReferenceContract(providerName);
  const out: string[] = [];
  for (const key of contract.callbackKeys) {
    const value = readParam(record, key);
    if (value && !out.includes(value)) out.push(value);
  }
  return out;
}
