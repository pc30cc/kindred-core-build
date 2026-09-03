/**
 * PROVIDER PAYMENT-REFERENCE BINDING — fail-closed.
 *
 * An intent may only be finalized with the checkout reference the gateway
 * produced for THAT intent. Anything else (no stored reference on a binding
 * provider, no incoming reference, a different reference) must be rejected,
 * so payment B can never finalize order A.
 */
import { describe, it, expect } from 'vitest';
import {
  providerRefMatchesIntent,
  extractProviderRef,
} from '../../../server/services/billing/paymentIntent';
import {
  requiresReferenceBinding,
  getProviderReferenceContract,
  extractProviderRefCandidates,
} from '../../../server/services/billing/providerBinding';

function intent(provider: string, storedRef: string | null) {
  return { id: 'intent_A', provider_name: provider, provider_ref: storedRef } as any;
}

const CASES: Array<{ provider: string; key: string; ref: string }> = [
  { provider: 'zarinpal', key: 'Authority', ref: 'A0000000000000000000000000000123' },
  { provider: 'zarinpal_test', key: 'Authority', ref: 'A000000000000000000000000000TEST' },
  { provider: 'idpay', key: 'id', ref: 'idpay-payment-1' },
  { provider: 'zibal', key: 'trackId', ref: '9876543210' },
  { provider: 'nextpay', key: 'trans_id', ref: 'np-trans-1' },
  { provider: 'payping', key: 'code', ref: 'pp-code-1' },
  { provider: 'sep_shaparak', key: 'Token', ref: 'sep-token-1' },
  { provider: 'iranpardakht_sandbox', key: 'authority', ref: 'irp-auth-1' },
];

describe('provider reference binding contract', () => {
  it('every Iranian gateway declares that binding is required', () => {
    for (const { provider } of CASES) {
      expect(requiresReferenceBinding(provider)).toBe(true);
      expect(getProviderReferenceContract(provider).callbackKeys.length).toBeGreaterThan(0);
    }
  });

  it('an undeclared provider is treated as having no bindable reference, explicitly', () => {
    const contract = getProviderReferenceContract('some_future_gateway');
    expect(contract.requiresPaymentReferenceBinding).toBe(false);
    expect(contract.reason).toBeTruthy();
  });

  for (const { provider, key, ref } of CASES) {
    describe(provider, () => {
      it('accepts the exact reference from this checkout', () => {
        expect(providerRefMatchesIntent(intent(provider, ref), { [key]: ref, Status: 'OK' })).toEqual({ ok: true });
      });

      it('rejects a callback that carries no reference at all', () => {
        const result = providerRefMatchesIntent(intent(provider, ref), { Status: 'OK' });
        expect(result).toEqual({ ok: false, reason: 'missing_provider_reference' });
      });

      it('rejects intent A finalized with payment B', () => {
        const result = providerRefMatchesIntent(intent(provider, ref), { [key]: `${ref}-OTHER` });
        expect(result).toEqual({ ok: false, reason: 'provider_reference_mismatch' });
      });

      it('rejects finalization when the intent was never bound', () => {
        const result = providerRefMatchesIntent(intent(provider, null), { [key]: ref });
        expect(result).toEqual({ ok: false, reason: 'missing_stored_provider_reference' });
      });

      it('extracts the reference using this provider’s own callback keys', () => {
        expect(extractProviderRefCandidates(provider, { [key]: ref })).toContain(ref);
        expect(extractProviderRef({ [key]: ref }, provider)).toBe(ref);
      });
    });
  }

  it('a numeric trackId still binds (Zibal sends numbers)', () => {
    expect(providerRefMatchesIntent(intent('zibal', '123456'), { trackId: 123456 })).toEqual({ ok: true });
  });

  it('a reference in the wrong parameter for that provider does not bypass binding', () => {
    // Zibal's contract does not accept ZarinPal's `Authority` key.
    const result = providerRefMatchesIntent(intent('zibal', '123456'), { Authority: '123456' });
    expect(result).toEqual({ ok: false, reason: 'missing_provider_reference' });
  });
});
