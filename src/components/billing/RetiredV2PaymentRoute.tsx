/**
 * Billing v2's payment page (/:slug/billing/pay/:kind/:id) while v2 is
 * retired (shared/billingMode.ts). A bank still sends a payment started
 * before the retirement back here (?intent=…&provider=…, plus the bank's own
 * parameters), and only this page verifies it: it stays for those returns
 * (its pay buttons answer 410). Any other link goes to the billing page.
 */
import type { ReactNode } from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';

export default function RetiredV2PaymentRoute({ page }: { page: ReactNode }) {
  const [params] = useSearchParams();
  if (params.get('intent') && params.get('provider')) return <>{page}</>;
  return <Navigate to="../billing" replace />;
}
