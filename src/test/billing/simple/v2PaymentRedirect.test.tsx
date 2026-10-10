/**
 * Billing v2's payment page (/:slug/billing/pay/:kind/:id) is retired with
 * v2 (shared/billingMode.ts): a bank's return of a payment started before
 * still reaches it (only that page verifies it); any other link goes to the
 * workspace's billing page.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import RetiredV2PaymentRoute from '@/components/billing/RetiredV2PaymentRoute';

function Where() {
  const location = useLocation();
  return <div>at {location.pathname + location.search}</div>;
}

function renderAt(url: string) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/:slug">
          <Route path="billing" element={<Where />} />
          <Route path="billing/pay/:kind/:id" element={<RetiredV2PaymentRoute page={<div>v2 payment page</div>} />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe('billing v2 payment page', () => {
  it('App.tsx routes it through RetiredV2PaymentRoute while v2 is retired', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'App.tsx'), 'utf8');
    expect(src).toMatch(
      /<Route path="billing\/pay\/:kind\/:id" element=\{LEGACY_BILLING_ENABLED \? .*<BillingPaymentPage \/>.* : <RetiredV2PaymentRoute page=\{.*<BillingPaymentPage \/>.*\} \/>\} \/>/,
    );
  });

  it('a bank return of a payment started before still opens the page that verifies it', () => {
    renderAt('/acme/billing/pay/invoice/inv-1?intent=i1&provider=zarinpal&Authority=A1&Status=OK');
    expect(screen.getByText('v2 payment page')).toBeInTheDocument();
  });

  it('any other link lands on the workspace billing page', () => {
    renderAt('/acme/billing/pay/invoice/inv-1');
    expect(screen.getByText('at /acme/billing')).toBeInTheDocument();
  });
});
