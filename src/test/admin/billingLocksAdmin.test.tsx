/**
 * Super Admin and phase 4 (design §10).
 *
 *  - Plans → Billing settings → Billing locks: the edition's switch, off by
 *    default; the preview lists the workspaces it would lock now; turning it
 *    on (or off) asks first, with the preview's count.
 *  - The plan editor's "Locked data retention (days)": empty = never deleted,
 *    a whole number of days > 0, refused otherwise before anything is sent.
 *  - "Only explicit limits lock": saving a plan that does not name a lock
 *    limit (max_agents, max_contacts, max_kb_articles, data_retention_days)
 *    does not write the registry default the form shows for it, unless the
 *    admin changed it.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '@/i18n';
import en from '@/i18n/locales/en';

const PLAN = vi.hoisted(() => ({
  id: 'plan-trial',
  name: 'Trial',
  slug: 'trial',
  description: '',
  is_free: false,
  is_active: true,
  is_hidden: false,
  sort_order: 1,
  trial_days: 14,
  locked_data_retention_days: null as number | null,
  default_currency: 'USD',
  prices: { USD: { monthly: 0, yearly: 0 } },
  entitlements: {},
  // Names max_contacts only: max_agents, max_kb_articles and data_retention_days lock nothing.
  limits: { max_contacts: -1 } as Record<string, number>,
  localized: {},
}));

const CAPABILITIES = vi.hoisted(() => [
  { key: 'max_agents', type: 'limit', label: 'Max agents', group: 'team', defaultValue: 1, planConfigurable: true, workspaceOverridable: true, userVisible: true, unit: 'count' },
  { key: 'max_contacts', type: 'limit', label: 'Max contacts', group: 'contacts', defaultValue: 100, planConfigurable: true, workspaceOverridable: true, userVisible: true },
  { key: 'max_kb_articles', type: 'limit', label: 'Max KB articles', group: 'kb', defaultValue: -1, planConfigurable: true, workspaceOverridable: true, userVisible: true },
  { key: 'data_retention_days', type: 'limit', label: 'Data retention', group: 'data', defaultValue: 30, planConfigurable: true, workspaceOverridable: true, userVisible: true, unit: 'days' },
  { key: 'storage_gb', type: 'limit', label: 'Storage', group: 'data', defaultValue: 1, planConfigurable: true, workspaceOverridable: true, userVisible: true },
]);

const updatePlan = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());

vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: toastError, warning: vi.fn(), info: vi.fn() } }));
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
    useCapabilityCatalog: () => ({ capabilities: CAPABILITIES, loading: false, error: null }),
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
    region: { region_mode: 'multi', active_locales: ['en'], default_locale: 'en' },
    realtime: null,
  }),
}));

import AdminPlansPage from '@/pages/admin/PlansPage';
import { BillingLocksCard } from '@/components/admin/BillingSettingsPanel';
import { __resetEditionForTests } from '@/lib/edition';

const wrap = (node: React.ReactNode) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <I18nProvider initialLocale="en" initialTranslations={en}>{node}</I18nProvider>
  </QueryClientProvider>
);

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

beforeEach(() => {
  updatePlan.mockReset().mockResolvedValue({});
  toastError.mockReset();
  localStorage.clear();
  __resetEditionForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─── The switch ───────────────────────────────────────────────────────────

const PREVIEW = {
  edition: 'iran',
  locks_enabled: false,
  scanned: 120,
  truncated: false,
  failed: 1,
  workspaces_locking: 2,
  totals: { kb_article: 3, contact: 300, member: 1, conversation: 40 },
  workspaces: [
    { workspace_id: 'w1', name: 'Acme', plan_id: 'free', kb_article: 3, contact: 200, member: 1, conversation: 0 },
    { workspace_id: 'w2', name: null, plan_id: 'free', kb_article: 0, contact: 100, member: 0, conversation: 40 },
  ],
  x_channel_stops: [{ workspace_id: 'w3', name: 'Birdy' }],
};

function stubLocksApi(initial = false) {
  let enabled = initial;
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ url: String(url), method, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (String(url).endsWith('/api/admin/billing/locks/preview')) {
      return { ok: true, json: async () => ({ ...PREVIEW, locks_enabled: enabled }) };
    }
    if (String(url).endsWith('/api/admin/billing/locks')) {
      if (method === 'PUT') enabled = (JSON.parse(String(init?.body)) as { enabled: boolean }).enabled;
      return { ok: true, json: async () => ({ edition: 'iran', locks_enabled: enabled }) };
    }
    return { ok: false, json: async () => ({}) };
  }));
  return calls;
}

describe('Super Admin billing locks switch', () => {
  it('is off by default; the preview lists what would lock, and the X channel stops', async () => {
    stubLocksApi();
    render(wrap(<BillingLocksCard />));
    const card = await screen.findByTestId('billing-locks-card');
    expect(within(card).getByRole('switch')).toHaveAttribute('aria-checked', 'false');
    expect(within(card).getByText(en.admin.billingLocks.off)).toBeInTheDocument();
    fireEvent.click(within(card).getByTestId('billing-locks-preview'));
    const result = await within(card).findByTestId('billing-locks-preview-result');
    expect(result).toHaveTextContent('2 workspaces would have data locked.');
    expect(result).toHaveTextContent('Checked 120 active workspaces.');
    expect(result).toHaveTextContent('1 workspaces could not be read.');
    expect(within(result).getByText('Acme')).toBeInTheDocument();
    // A workspace without a name shows its id; the totals row adds them up.
    expect(within(result).getByText('w2')).toBeInTheDocument();
    expect(within(result).getByText('300')).toBeInTheDocument();
    expect(within(result).getByTestId('billing-locks-x-stops')).toHaveTextContent('Birdy');
  });

  it('turning it on asks first, naming the preview\'s count, then saves', async () => {
    const calls = stubLocksApi();
    render(wrap(<BillingLocksCard />));
    const card = await screen.findByTestId('billing-locks-card');
    fireEvent.click(within(card).getByTestId('billing-locks-preview'));
    await within(card).findByTestId('billing-locks-preview-result');
    fireEvent.click(within(card).getByRole('switch'));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent(en.admin.billingLocks.confirmOnTitle);
    expect(dialog).toHaveTextContent('2 workspaces have data over their plan');
    // Nothing is saved before the confirmation.
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
    fireEvent.click(within(dialog).getByTestId('billing-locks-confirm'));
    await waitFor(() => expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ enabled: true }));
    await waitFor(() => expect(within(card).getByRole('switch')).toHaveAttribute('aria-checked', 'true'));
  });

  it('without a preview it says to run one first; cancelling saves nothing', async () => {
    const calls = stubLocksApi();
    render(wrap(<BillingLocksCard />));
    const card = await screen.findByTestId('billing-locks-card');
    fireEvent.click(within(card).getByRole('switch'));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent(en.admin.billingLocks.confirmOnUnknown);
    fireEvent.click(within(dialog).getByText(en.admin.billingLocks.cancel));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
    expect(within(card).getByRole('switch')).toHaveAttribute('aria-checked', 'false');
  });

  it('turning it off asks too', async () => {
    const calls = stubLocksApi(true);
    render(wrap(<BillingLocksCard />));
    const card = await screen.findByTestId('billing-locks-card');
    fireEvent.click(within(card).getByRole('switch'));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent(en.admin.billingLocks.confirmOff);
    fireEvent.click(within(dialog).getByTestId('billing-locks-confirm'));
    await waitFor(() => expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ enabled: false }));
  });
});

// ─── The plan editor ──────────────────────────────────────────────────────

async function openEditor() {
  render(wrap(<AdminPlansPage />));
  await screen.findByText(en.admin.plans.title);
  const edit = [...document.querySelectorAll<HTMLButtonElement>('button[aria-haspopup="dialog"]')].find(
    (b) => !b.textContent?.trim(),
  );
  fireEvent.click(edit!);
  return screen.findByRole('dialog');
}

const save = (dialog: HTMLElement) => fireEvent.click(within(dialog).getByRole('button', { name: en.admin.plans.form.updatePlan }));

describe('Super Admin plan editor: locked data retention', () => {
  it('empty means never deleted, and absent lock limits stay absent', async () => {
    const dialog = await openEditor();
    const field = within(dialog).getByTestId('plan-locked-retention') as HTMLInputElement;
    expect(field.value).toBe('');
    expect(field.placeholder).toBe(en.admin.billingLocks.planRetention.never);
    save(dialog);
    await waitFor(() => expect(updatePlan).toHaveBeenCalledTimes(1));
    const payload = updatePlan.mock.calls[0][0];
    expect(payload.locked_data_retention_days).toBeNull();
    // max_contacts is the plan's own; the lock limits it did not name are not written.
    expect(payload.limits.max_contacts).toBe(-1);
    expect(payload.limits).not.toHaveProperty('max_agents');
    expect(payload.limits).not.toHaveProperty('max_kb_articles');
    expect(payload.limits).not.toHaveProperty('data_retention_days');
    // Other limits keep the editor's behaviour (registry default written).
    expect(payload.limits.storage_gb).toBe(1);
  });

  it('saves whole days (Persian digits too), and a lock limit the admin set', async () => {
    const dialog = await openEditor();
    fireEvent.change(within(dialog).getByTestId('plan-locked-retention'), { target: { value: '۹۰' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /^Limits/ }));
    const agents = within(dialog).getByText('Max Agents').closest('div')!.parentElement!.querySelector('input')!;
    fireEvent.change(agents, { target: { value: '3' } });
    save(dialog);
    await waitFor(() => expect(updatePlan).toHaveBeenCalledTimes(1));
    const payload = updatePlan.mock.calls[0][0];
    expect(payload.locked_data_retention_days).toBe(90);
    expect(payload.limits.max_agents).toBe(3);
    expect(payload.limits).not.toHaveProperty('data_retention_days');
  });

  it('refuses a value that is not a whole number of days > 0', async () => {
    for (const bad of ['0', '2.5', 'abc', '-3']) {
      updatePlan.mockClear();
      toastError.mockClear();
      const dialog = await openEditor();
      fireEvent.change(within(dialog).getByTestId('plan-locked-retention'), { target: { value: bad } });
      expect(within(dialog).getByTestId('plan-locked-retention')).toHaveAttribute('aria-invalid', 'true');
      save(dialog);
      await waitFor(() => expect(toastError).toHaveBeenCalledWith(en.admin.billingLocks.planRetention.invalid));
      expect(updatePlan).not.toHaveBeenCalled();
      cleanup();
    }
  });
});
