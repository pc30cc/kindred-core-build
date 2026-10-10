/**
 * PlanStatusBanner (src/components/layout): the panel's plan notice, decided
 * from the effective-entitlement snapshot.
 *
 *   - a running trial → its days left;
 *   - a paid period that will not renew (the snapshot's `renewal_due`) →
 *     "your plan ends in N days" ("1 day" on the last), or the date it ends
 *     and moves to Free when a change to Free is scheduled, or "your card
 *     payment failed" when the saved card could not pay the renewal, with a
 *     link to the billing page;
 *   - the free plan → upgrade;
 *   - a paying workspace that renews, or one whose due moment has passed
 *     (the snapshot is a little old) → nothing about renewing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const i18n = vi.hoisted(() => ({
  t: (k: string, vars?: Record<string, string | number>) => (vars ? `${k} ${JSON.stringify(vars)}` : k),
}));
vi.mock('@/i18n', () => ({
  useTranslation: () => ({ t: i18n.t, locale: 'en', dir: 'ltr' }),
}));
vi.mock('@/hooks/useWorkspace', () => ({
  useWorkspacePath: () => (path: string) => `/app/w/ws1${path}`,
}));
let snapshot: Record<string, unknown> | null = null;
vi.mock('@/hooks/useEntitlements', () => ({
  useWorkspaceEffectiveEntitlements: () => ({ data: snapshot, loading: false, error: null, reload: () => {} }),
}));

const { PlanStatusBanner } = await import('@/components/layout/PlanStatusBanner');

const DAY = 86_400_000;
const inDays = (days: number) => new Date(Date.now() + days * DAY).toISOString();

const PAID = {
  plan: { is_free: false, slug: 'pro', name: 'Pro' },
  subscription: { status: 'active', plan_id: 'pro', trial_end: null, free_fallback_at: null },
};

function show() {
  return render(
    <MemoryRouter>
      <PlanStatusBanner workspaceId="ws1" />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  snapshot = null;
});

describe('PlanStatusBanner', () => {
  it('a paying workspace that renews sees nothing', () => {
    snapshot = { ...PAID, renewal_due: null };
    const { container } = show();
    expect(container).toBeEmptyDOMElement();
  });

  it('a period that will not renew shows its days left and links to billing', () => {
    snapshot = { ...PAID, renewal_due: { days_left: 3, period_end: inDays(2.5), ends_on_free: false } };
    show();
    expect(screen.getByText('planBanner.renewalTitle {"days":3}')).toBeInTheDocument();
    expect(screen.getByText('planBanner.renewalDesc')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /planBanner\.renewCta/ })).toHaveAttribute('href', '/app/w/ws1/billing');
  });

  it('the last day reads in the singular', () => {
    snapshot = { ...PAID, renewal_due: { days_left: 1, period_end: inDays(0.4), ends_on_free: false } };
    show();
    expect(screen.getByText('planBanner.renewalTitleOne {"days":1}')).toBeInTheDocument();
  });

  it('a change scheduled to Free names the date the plan ends', () => {
    const end = inDays(5);
    snapshot = { ...PAID, renewal_due: { days_left: 5, period_end: end, ends_on_free: true } };
    show();
    expect(screen.getByText(/^planBanner\.renewalFreeTitle /)).toBeInTheDocument();
    expect(screen.getByText(/^planBanner\.renewalFreeTitle /).textContent).toContain(String(new Date(end).getFullYear()));
    // Renewing is refused for a change to Free: the banner points to cancelling it.
    expect(screen.getByText('planBanner.renewalFreeDesc')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /planBanner\.manageCta/ })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /planBanner\.renewCta/ })).toBeNull();
  });

  it('a renewal the saved card could not pay says so, with the date and a link to fix it', () => {
    const end = inDays(0.8);
    snapshot = { ...PAID, renewal_due: { days_left: 1, period_end: end, ends_on_free: false, card_past_due: true } };
    show();
    expect(screen.getByText('planBanner.cardPastDueTitle')).toBeInTheDocument();
    expect(screen.getByText(/^planBanner\.cardPastDueDesc /).textContent).toContain(String(new Date(end).getFullYear()));
    expect(screen.getByRole('link', { name: /planBanner\.cardPastDueCta/ })).toHaveAttribute('href', '/app/w/ws1/billing');
    expect(screen.queryByText(/planBanner\.renewalTitle/)).toBeNull();
    expect(screen.queryByRole('link', { name: /planBanner\.renewCta/ })).toBeNull();
  });

  it('a due moment that has passed since the snapshot shows nothing about renewing', () => {
    snapshot = { ...PAID, renewal_due: { days_left: 1, period_end: inDays(-0.01), ends_on_free: false } };
    const { container } = show();
    expect(container).toBeEmptyDOMElement();
  });

  it('a running trial still shows the trial, and the free plan the upgrade', () => {
    snapshot = {
      plan: { is_free: false, slug: 'pro' },
      subscription: { status: 'trialing', plan_id: 'pro', trial_end: inDays(4) },
      renewal_due: null,
    };
    const { unmount } = show();
    expect(screen.getByText('planBanner.trialTitle')).toBeInTheDocument();
    unmount();

    snapshot = { plan: { is_free: true, slug: 'free' }, subscription: null, renewal_due: null };
    show();
    expect(screen.getByText('planBanner.freeTitle')).toBeInTheDocument();
    expect(screen.queryByText(/planBanner\.renewal/)).toBeNull();
  });
});
