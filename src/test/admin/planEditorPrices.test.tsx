/**
 * Super Admin → Plans → Pricing speaks the amounts people read. Prices are
 * stored in minor units (USD/EUR/TRY) and Rial (IRR) — the units checkout,
 * the billing overview and the public landing read — so an admin typing 29
 * must save 2900 cents, not 29 cents ($0.29).
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '@/i18n';
import en from '@/i18n/locales/en';

const PLAN = vi.hoisted(() => ({
  id: 'plan-pro',
  name: 'Pro',
  slug: 'pro',
  description: '',
  is_free: false,
  is_active: true,
  is_hidden: false,
  sort_order: 1,
  trial_days: 0,
  default_currency: 'USD',
  prices: {
    USD: { monthly: 2900, yearly: 29000 },
    EUR: { monthly: 2700, yearly: 27000 },
    TRY: { monthly: 99900, yearly: 999000 },
    IRR: { monthly: 15_000_000, yearly: 150_000_000 },
  },
  entitlements: {},
  limits: {},
  localized: {},
}));

const updatePlan = vi.hoisted(() => vi.fn());

vi.mock('@/hooks/usePlans', () => {
  const mutation = () => ({ mutateAsync: vi.fn(), isPending: false });
  return {
    useAdminPlans: () => ({ data: [PLAN], isLoading: false }),
    useAdminSubscriptions: () => ({ data: [] }),
    useCreatePlan: mutation,
    useUpdatePlan: () => ({ mutateAsync: updatePlan, isPending: false }),
    useDeletePlan: mutation,
    useAssignPlan: mutation,
    useRevokePlan: mutation,
  };
});
vi.mock('@/hooks/useAdmin', () => ({ useAdminWorkspaces: () => ({ data: [] }) }));
vi.mock('@/hooks/useEntitlements', () => {
  const idle = () => ({ data: null, loading: false, error: null, reload: () => {} });
  return {
    useCapabilityCatalog: () => ({ capabilities: [], loading: false, error: null }),
    useWorkspaceEffectiveEntitlements: idle,
    useEntitlementDiagnostics: idle,
  };
});
vi.mock('@/lib/entitlements-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements-api')>()),
  validatePlanPayload: async () => ({ issues: [] }),
}));
vi.mock('@/lib/platformPublicConfig', () => ({
  fetchPlatformPublicConfig: async () => ({
    branding: null,
    localized: [],
    region: { region_mode: 'multi', active_locales: ['en'], default_locale: 'en' },
    realtime: null,
  }),
}));

import AdminPlansPage from '@/pages/admin/PlansPage';

function renderPage() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <I18nProvider initialLocale="en" initialTranslations={en}>
        <AdminPlansPage />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

async function openPricing() {
  renderPage();
  await screen.findByText(en.admin.plans.title);
  const edit = [...document.querySelectorAll<HTMLButtonElement>('button[aria-haspopup="dialog"]')].find(
    (b) => !b.textContent?.trim(),
  );
  fireEvent.click(edit!);
  const dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: en.admin.plans.form.sections.pricing }));
  await screen.findByText(en.admin.plans.form.priceUnitHint);
  return dialog;
}

const field = (cur: string, iv: 'monthly' | 'yearly') =>
  document.getElementById(`plan-price-${cur}-${iv}`) as HTMLInputElement;
const preview = (cur: string, iv: 'monthly' | 'yearly') =>
  screen.getByTestId(`plan-price-${cur}-${iv}-preview`).textContent;

describe('Super Admin plan editor prices', () => {
  beforeAll(() => {
    globalThis.ResizeObserver ??= class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  });
  beforeEach(() => updatePlan.mockReset().mockResolvedValue({}));

  it('lists stored prices as formatted major units and Toman', async () => {
    renderPage();
    await screen.findByText(en.admin.plans.title);
    const text = document.body.textContent || '';
    expect(text).toContain('$29.00/');
    expect(text).toContain('$290.00/');
    expect(text).toContain('€27.00/');
    expect(text).toContain('1,500,000 Toman/');
    expect(text).not.toContain('2,900/');
  });

  it('shows stored minor units / Rial as the amount people read, with the unit', async () => {
    await openPricing();
    expect(field('USD', 'monthly').value).toBe('29');
    expect(field('USD', 'yearly').value).toBe('290');
    expect(field('EUR', 'monthly').value).toBe('27');
    expect(field('TRY', 'monthly').value).toBe('999');
    expect(field('IRR', 'monthly').value).toBe('1500000');
    expect(preview('USD', 'monthly')).toBe('$29.00');
    expect(preview('IRR', 'monthly')).toBe('1,500,000 Toman');
    expect(document.querySelector('label[for="plan-price-USD-monthly"]')?.textContent).toContain('($)');
    expect(document.querySelector('label[for="plan-price-EUR-monthly"]')?.textContent).toContain('(€)');
    expect(document.querySelector('label[for="plan-price-IRR-monthly"]')?.textContent).toContain('(Toman)');
  });

  it('saves typed major units as minor units and Toman as Rial', async () => {
    const dialog = await openPricing();
    fireEvent.change(field('USD', 'monthly'), { target: { value: '29.99' } });
    fireEvent.change(field('EUR', 'yearly'), { target: { value: '300' } });
    fireEvent.change(field('IRR', 'monthly'), { target: { value: '2,000,000' } });
    expect(preview('USD', 'monthly')).toBe('$29.99');
    expect(preview('IRR', 'monthly')).toBe('2,000,000 Toman');

    fireEvent.click(within(dialog).getByRole('button', { name: en.admin.plans.form.updatePlan }));
    await waitFor(() => expect(updatePlan).toHaveBeenCalledTimes(1));
    expect(updatePlan.mock.calls[0][0].prices).toEqual({
      USD: { monthly: 2999, yearly: 29000 },
      EUR: { monthly: 2700, yearly: 30000 },
      TRY: { monthly: 99900, yearly: 999000 },
      IRR: { monthly: 20_000_000, yearly: 150_000_000 },
    });
  });

  it('refuses to save an amount it cannot read', async () => {
    const dialog = await openPricing();
    fireEvent.change(field('USD', 'monthly'), { target: { value: '29$' } });
    expect(preview('USD', 'monthly')).toBe(en.admin.plans.form.priceInvalid);
    fireEvent.click(within(dialog).getByRole('button', { name: en.admin.plans.form.updatePlan }));
    await new Promise((r) => setTimeout(r, 20));
    expect(updatePlan).not.toHaveBeenCalled();
  });
});
