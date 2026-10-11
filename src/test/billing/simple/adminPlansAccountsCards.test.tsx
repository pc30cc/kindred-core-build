/**
 * Simple billing phase 6, part D (docs/billing/SIMPLE_BILLING.md): the plan
 * form's retention days and monthly AI credit (D17, D18), the read-only VAT
 * line (D16), the server's 400 issues, the Plans page deep links, and the
 * read-only billing cards of Super Admin → Workspaces (D25) and → Users (D22).
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { I18nProvider } from '@/i18n';
import en from '@/i18n/locales/en';
import type { CapabilityDefinition } from '@/lib/entitlements-api';
import { capabilityLabel } from '@/lib/capability-i18n';

const WS_ID = '11111111-2222-4333-8444-555555555555';
const OWNER_ID = '99999999-8888-4777-8666-555555555555';

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
  prices: { USD: { monthly: 2900, yearly: 29000 }, IRR: { monthly: 15_000_000, yearly: 150_000_000 } },
  entitlements: {},
  limits: { included_ai_allowance_irr: 5_000_000, max_agents: 3 } as Record<string, number>,
  localized: {},
  locked_data_retention_days: 90 as number | null,
  ai_allowance: { IRR: 5_000_000 } as Record<string, number> | null,
}));

const CAPS = vi.hoisted<CapabilityDefinition[]>(() => [
  { key: 'max_agents', type: 'limit', label: 'Max agents', group: 'team', defaultValue: 1, planConfigurable: true, workspaceOverridable: true, userVisible: true },
  { key: 'included_ai_allowance_irr', type: 'limit', label: 'AI Allowance / Month', group: 'ai', defaultValue: 0, planConfigurable: true, workspaceOverridable: true, userVisible: true },
]);

const updatePlan = vi.hoisted(() => vi.fn());
const createPlan = vi.hoisted(() => vi.fn());
const plansData = vi.hoisted(() => ({ list: [] as unknown[] }));

vi.mock('@/hooks/usePlans', () => {
  const mutation = () => ({ mutateAsync: vi.fn(), isPending: false });
  return {
    useAdminPlans: () => ({ data: plansData.list, isLoading: false }),
    useAdminSubscriptions: () => ({ data: [] }),
    useCreatePlan: () => ({ mutateAsync: createPlan, isPending: false }),
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
    useCapabilityCatalog: () => ({ capabilities: CAPS, loading: false, error: null }),
    useWorkspaceEffectiveEntitlements: idle,
    useEntitlementDiagnostics: idle,
  };
});
vi.mock('@/lib/entitlements-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements-api')>()),
  validatePlanPayload: async () => ({ issues: [] }),
}));
vi.mock('@/lib/platformPublicConfig', () => ({
  usePlatformPublicConfig: () => ({ data: undefined }),
  fetchPlatformPublicConfig: async () => ({
    branding: null,
    localized: [],
    region: { region_mode: 'iran', active_locales: ['en'], default_locale: 'en' },
    realtime: null,
  }),
}));

import AdminPlansPage from '@/pages/admin/PlansPage';
import WorkspaceBillingSummary from '@/components/admin/WorkspaceBillingSummary';
import UserBillingAccountsCard from '@/components/admin/UserBillingAccountsCard';
import BillingSettingsPanel from '@/components/admin/BillingSettingsPanel';
import { __resetEditionForTests } from '@/lib/edition';

// ─── The simple billing API, answered from here ─────────────────────────────

const SETTINGS = {
  edition: 'iran',
  seller: {},
  vat_percent: { IRR: 10 },
  receipt_prefix: 'WY',
  vat_currencies: ['IRR'],
  ai_currencies: ['IRR'],
  ai_packs: { IRR: [] },
};

function account(overrides: Record<string, unknown> = {}) {
  return {
    workspace: { id: WS_ID, name: 'Acme', slug: 'acme', owner: { id: OWNER_ID, email: 'owner@example.com' } },
    has_account: true,
    edition: 'iran',
    currency: 'IRR',
    balance_minor: 1_250_000,
    auto_renew: true,
    next_period_prepaid_minor: null,
    next_period_start: null,
    scheduled: null,
    plan: {
      plan_id: 'plan-pro', slug: 'pro', name: 'Pro', localized: {}, is_free: false, status: 'active',
      billing_interval: 'monthly', current_period_start: '2026-10-01T00:00:00Z', current_period_end: '2026-11-01T00:00:00Z', trial_end: null,
    },
    due_unprocessed: false,
    card: null,
    billing_profile: {},
    vat_percent: 10,
    account_created_at: '2026-09-01T00:00:00Z',
    ...overrides,
  };
}

const requests: string[] = [];
let accountAnswer: unknown = account();
let accountsAnswer: unknown = { edition: 'iran', currencies: ['IRR'], total: 0, page: 1, pageSize: 20, items: [] };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

beforeEach(() => {
  requests.length = 0;
  accountAnswer = account();
  plansData.list = [PLAN];
  updatePlan.mockReset().mockResolvedValue({});
  createPlan.mockReset().mockResolvedValue({});
  localStorage.clear();
  __resetEditionForTests();
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    requests.push(url);
    if (url.includes('/api/admin/simple-billing/settings')) return json(SETTINGS);
    if (/\/api\/admin\/simple-billing\/accounts\?/.test(url)) return json(accountsAnswer);
    if (url.includes(`/api/admin/simple-billing/accounts/${WS_ID}`)) return json(accountAnswer);
    return json({ error: 'NOT_FOUND' }, 404);
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function Where() {
  const location = useLocation();
  return <span data-testid="where">{location.pathname + location.search}</span>;
}

function renderAt(ui: React.ReactElement, path = '/') {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <I18nProvider initialLocale="en" initialTranslations={en}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="*" element={<>{ui}<Where /></>} />
          </Routes>
        </MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

async function openEditor(path = '/admin/plans') {
  renderAt(<AdminPlansPage />, path);
  await screen.findByText(en.admin.plans.title);
  const edit = [...document.querySelectorAll<HTMLButtonElement>('button[aria-haspopup="dialog"]')].find(
    (b) => !b.textContent?.trim(),
  );
  fireEvent.click(edit!);
  return screen.findByRole('dialog');
}

const section = (dialog: HTMLElement, label: string) =>
  fireEvent.click(within(dialog).getAllByRole('button').find((b) => b.textContent?.trim().startsWith(label.replace(/\s*\(\{\{count\}\}\)/, '')))!);
const input = (id: string) => document.getElementById(id) as HTMLInputElement;
const save = (dialog: HTMLElement) => fireEvent.click(within(dialog).getByRole('button', { name: en.admin.plans.form.updatePlan }));

// ─── Plan form ──────────────────────────────────────────────────────────────

describe('plan form: retention days and monthly AI credit', () => {
  it('shows the stored values in the unit people read and saves them back (IRR mirrored into the limit)', async () => {
    const dialog = await openEditor();
    expect(input('plan-retention-days').value).toBe('90');
    expect(within(dialog).getByText(en.admin.simpleBilling.plans.retentionHint)).toBeTruthy();

    section(dialog, en.admin.plans.form.sections.pricing);
    await screen.findByText(en.admin.simpleBilling.plans.aiAllowance);
    // 5,000,000 Rial is 500,000 Toman.
    expect(input('plan-ai-allowance-IRR').value).toBe('500000');
    expect(screen.getByTestId('plan-ai-allowance-IRR-preview').textContent).toBe('500,000 Toman');

    fireEvent.change(input('plan-ai-allowance-IRR'), { target: { value: '۷۵۰٬۰۰۰' } });
    expect(screen.getByTestId('plan-ai-allowance-IRR-preview').textContent).toBe('750,000 Toman');
    section(dialog, en.admin.plans.form.sections.general);
    fireEvent.change(input('plan-retention-days'), { target: { value: '30' } });

    save(dialog);
    await waitFor(() => expect(updatePlan).toHaveBeenCalledTimes(1));
    const body = updatePlan.mock.calls[0][0];
    expect(body.locked_data_retention_days).toBe(30);
    expect(body.ai_allowance).toEqual({ IRR: 7_500_000 });
    expect(body.limits).toMatchObject({ included_ai_allowance_irr: 7_500_000, max_agents: 3 });
  });

  it('an empty retention means never deleted (null)', async () => {
    const dialog = await openEditor();
    fireEvent.change(input('plan-retention-days'), { target: { value: '' } });
    save(dialog);
    await waitFor(() => expect(updatePlan).toHaveBeenCalledTimes(1));
    expect(updatePlan.mock.calls[0][0].locked_data_retention_days).toBeNull();
  });

  it('refuses a retention outside 1-3650 whole days', async () => {
    const dialog = await openEditor();
    for (const bad of ['0', '3651', '12.5', 'abc']) {
      fireEvent.change(input('plan-retention-days'), { target: { value: bad } });
      expect(input('plan-retention-days').getAttribute('aria-invalid')).toBe('true');
      save(dialog);
    }
    await new Promise((r) => setTimeout(r, 20));
    expect(updatePlan).not.toHaveBeenCalled();
  });

  it('refuses an AI credit it cannot read', async () => {
    const dialog = await openEditor();
    section(dialog, en.admin.plans.form.sections.pricing);
    await screen.findByText(en.admin.simpleBilling.plans.aiAllowance);
    fireEvent.change(input('plan-ai-allowance-IRR'), { target: { value: '12x' } });
    expect(screen.getByTestId('plan-ai-allowance-IRR-preview').textContent).toBe(en.admin.plans.form.priceInvalid);
    save(dialog);
    await new Promise((r) => setTimeout(r, 20));
    expect(updatePlan).not.toHaveBeenCalled();
  });

  it('the limits editor hides the AI allowance limit (edited once, under Pricing)', async () => {
    const dialog = await openEditor();
    section(dialog, en.admin.plans.form.sections.limits);
    await waitFor(() => expect(dialog.textContent).toContain(capabilityLabel('max_agents', 'en', 'Max agents')));
    expect(dialog.textContent).toContain('Limits (1)');
    expect(dialog.textContent).not.toContain(capabilityLabel('included_ai_allowance_irr', 'en', 'AI Allowance / Month'));
  });

  it('a plan saved before ai_allowance existed starts from its limit', async () => {
    plansData.list = [{ ...PLAN, ai_allowance: null, locked_data_retention_days: null }];
    const dialog = await openEditor();
    expect(input('plan-retention-days').value).toBe('');
    section(dialog, en.admin.plans.form.sections.pricing);
    await screen.findByText(en.admin.simpleBilling.plans.aiAllowance);
    expect(input('plan-ai-allowance-IRR').value).toBe('500000');
    save(dialog);
    await waitFor(() => expect(updatePlan).toHaveBeenCalledTimes(1));
    expect(updatePlan.mock.calls[0][0].ai_allowance).toEqual({ IRR: 5_000_000 });
    expect(updatePlan.mock.calls[0][0].locked_data_retention_days).toBeNull();
  });

  it('a new plan sends retention, ai_allowance and is_hidden', async () => {
    renderAt(<AdminPlansPage />, '/admin/plans');
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(en.admin.plans.createPlan) }));
    const dialog = await screen.findByRole('dialog');
    const general = within(dialog);
    fireEvent.change(general.getByPlaceholderText('Pro'), { target: { value: 'Team' } });
    fireEvent.change(general.getByPlaceholderText('pro'), { target: { value: 'team' } });
    fireEvent.change(input('plan-retention-days'), { target: { value: '180' } });
    fireEvent.click(general.getByRole('button', { name: en.admin.plans.form.createPlan }));
    await waitFor(() => expect(createPlan).toHaveBeenCalledTimes(1));
    expect(createPlan.mock.calls[0][0]).toMatchObject({ locked_data_retention_days: 180, ai_allowance: { IRR: 0 }, is_hidden: false });
  });

  it("lists the server's 400 issues under the form", async () => {
    updatePlan.mockRejectedValue(
      Object.assign(new Error('INVALID_REQUEST'), {
        status: 400,
        body: { error: 'INVALID_REQUEST', issues: [{ path: 'locked_data_retention_days', message: 'too_big' }] },
      }),
    );
    const dialog = await openEditor();
    save(dialog);
    await within(dialog).findByText(en.admin.plans.validation.title);
    expect(dialog.textContent).toContain('locked_data_retention_days');
    expect(dialog.textContent).toContain('too_big');
  });

  it('shows the VAT from billing settings read-only, with a way to edit it there', async () => {
    const dialog = await openEditor();
    section(dialog, en.admin.plans.form.sections.pricing);
    const line = await screen.findByTestId('plan-vat-line');
    expect(line.textContent).toContain(en.admin.simpleBilling.plans.vatFromSettings.replace('{{percent}}', '10'));
    expect(line.querySelector('input')).toBeNull();
    fireEvent.click(within(line).getByRole('button', { name: en.admin.simpleBilling.plans.editVat }));
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/admin/plans?tab=billing-settings'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('Plans page deep links', () => {
  it('?tab=assign&workspace=<id> opens Assign with the workspace preselected', async () => {
    renderAt(<AdminPlansPage />, `/admin/plans?tab=assign&workspace=${WS_ID}`);
    await screen.findByText(en.admin.plans.assign.title);
    // Not in the first page of workspaces: named from its billing account.
    await waitFor(() => expect(document.body.textContent).toContain('Acme (acme)'));
    expect(requests.some((u) => u.includes(`/accounts/${WS_ID}`))).toBe(true);
  });

  it('ignores an unknown tab and a malformed workspace id', async () => {
    renderAt(<AdminPlansPage />, '/admin/plans?tab=nope&workspace=not-a-uuid');
    await screen.findByText(en.admin.plans.title);
    expect(screen.getByRole('tab', { name: new RegExp(en.admin.plans.tabs.plans.replace(' ({{count}})', '')) }).getAttribute('aria-selected')).toBe('true');
    expect(requests.some((u) => u.includes('/accounts/'))).toBe(false);
  });
});

// ─── Workspaces → billing summary ──────────────────────────────────────────

describe('WorkspaceBillingSummary', () => {
  it('shows balance in Toman, plan, period end, auto-renew and links to the account', async () => {
    renderAt(<WorkspaceBillingSummary workspaceId={WS_ID} />);
    expect((await screen.findByTestId('workspace-billing-balance')).textContent).toBe('125,000 Toman');
    const card = screen.getByTestId('workspace-billing-summary');
    expect(card.textContent).toContain('Pro');
    expect(card.textContent).toContain(en.admin.plans.monthly);
    expect(card.textContent).toContain(en.admin.common.yes);
    const link = within(card).getByRole('link', { name: en.admin.simpleBilling.workspaceCard.open });
    expect(link.getAttribute('href')).toBe(`/admin/finance/accounts/${WS_ID}`);
    // Only the read-only detail endpoint is used.
    expect(requests).toEqual([expect.stringContaining(`/api/admin/simple-billing/accounts/${WS_ID}`)]);
  });

  it('says when the workspace has no account yet, and shows a due period and a card', async () => {
    accountAnswer = account({
      has_account: false,
      balance_minor: 0,
      due_unprocessed: true,
      card: { status: 'past_due', provider: 'paddle', brand: 'visa', last4: '4242', paddle_next_billed_at: null, cancel_intent: null },
    });
    renderAt(<WorkspaceBillingSummary workspaceId={WS_ID} />);
    expect(await screen.findByText(en.admin.simpleBilling.workspaceCard.noAccount)).toBeTruthy();
    const card = screen.getByTestId('workspace-billing-summary');
    expect(card.textContent).toContain(en.admin.simpleBilling.detail.dueUnprocessed);
    expect(card.textContent).toContain('visa ••••4242');
  });
});

// ─── Users → billing accounts ──────────────────────────────────────────────

describe('UserBillingAccountsCard', () => {
  it("lists the accounts of the user's workspaces, with or without an account", async () => {
    accountsAnswer = {
      edition: 'iran',
      currencies: ['IRR'],
      total: 2,
      page: 1,
      pageSize: 20,
      items: [
        { workspace_id: WS_ID, name: 'Acme', slug: 'acme', has_account: true, currency: 'IRR', balance_minor: 1_250_000, plan_name: 'Pro', plan_localized: null, status: 'active' },
        { workspace_id: OWNER_ID, name: 'Beta', slug: 'beta', has_account: false, currency: null, balance_minor: 0, plan_name: null, plan_localized: null, status: null },
      ],
    };
    renderAt(<UserBillingAccountsCard userId={OWNER_ID} />);
    expect(await screen.findByText('125,000 Toman')).toBeTruthy();
    const url = new URL(requests.find((u) => u.includes('/accounts?'))!, 'http://x');
    expect(url.searchParams.get('filter')).toBe(`owner:${OWNER_ID}`);
    expect(url.searchParams.get('pageSize')).toBe('20');
    const card = screen.getByTestId('user-billing-accounts');
    expect(card.textContent).toContain(en.admin.simpleBilling.accounts.noAccount);
    expect(within(card).getByRole('link', { name: 'Acme' }).getAttribute('href')).toBe(`/admin/finance/accounts/${WS_ID}`);
  });

  it('says so when the user owns no workspace', async () => {
    accountsAnswer = { edition: 'iran', currencies: ['IRR'], total: 0, page: 1, pageSize: 20, items: [] };
    renderAt(<UserBillingAccountsCard userId={OWNER_ID} />);
    expect(await screen.findByText(en.admin.simpleBilling.userCard.empty)).toBeTruthy();
  });
});

// ─── Plans → Billing settings ──────────────────────────────────────────────

describe('BillingSettingsPanel', () => {
  it('saves through the shared settings query and leaves the AI packs as they are', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      const sent = init?.body ? JSON.parse(String(init.body)) : null;
      return json(sent ? { ...SETTINGS, ...sent, vat_percent: sent.vat_percent } : SETTINGS);
    }));
    renderAt(<BillingSettingsPanel />);
    const vat = (await screen.findByLabelText(en.admin.simpleBilling.vatFor.IRR)) as HTMLInputElement;
    expect(vat.value).toBe('10');
    fireEvent.change(vat, { target: { value: '۹' } });
    fireEvent.click(screen.getByRole('button', { name: en.admin.simpleBilling.save }));
    await waitFor(() => expect(calls.some((c) => c.init?.method === 'PUT')).toBe(true));
    const put = JSON.parse(String(calls.find((c) => c.init?.method === 'PUT')!.init!.body));
    expect(put.vat_percent).toEqual({ IRR: 9 });
    expect(put).not.toHaveProperty('ai_packs');
    await waitFor(() => expect((screen.getByLabelText(en.admin.simpleBilling.vatFor.IRR) as HTMLInputElement).value).toBe('9'));
  });
});
