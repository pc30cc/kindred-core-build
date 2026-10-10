/**
 * Billing v2's payment page (/:slug/billing/pay/:kind/:id) is retired with
 * v2 (shared/billingMode.ts): App.tsx sends its links to the workspace's
 * billing page instead.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';

function Where() {
  const location = useLocation();
  return <div>at {location.pathname + location.search}</div>;
}

describe('billing v2 payment page', () => {
  it('App.tsx redirects it to ../billing while v2 is retired', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'App.tsx'), 'utf8');
    expect(src).toMatch(
      /<Route path="billing\/pay\/:kind\/:id" element=\{LEGACY_BILLING_ENABLED \? .*<BillingPaymentPage \/>.* : <Navigate to="\.\.\/billing" replace \/>\} \/>/,
    );
  });

  it('"../billing" from that route (a child of /:slug) lands on the workspace billing page', () => {
    render(
      <MemoryRouter initialEntries={['/acme/billing/pay/invoice/inv-1?intent=i1&provider=zarinpal']}>
        <Routes>
          <Route path="/:slug">
            <Route path="billing" element={<Where />} />
            <Route path="billing/pay/:kind/:id" element={<Navigate to="../billing" replace />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByText('at /acme/billing')).toBeInTheDocument();
  });
});
