/**
 * Phase 4 in the workspace's billing UI: the downgrade report and the lock
 * banner (design §9).
 *
 *  - The report lists what the target plan locks as the server counted it;
 *    while the edition's billing locks are off it says the data counts are a
 *    preview and lists only what follows the plan either way (no stopped-
 *    channel warning: messages still arrive). The quote carries no report
 *    while locks are off.
 *  - A plan bought from a trial or Free waits for "I understand" like a
 *    downgrade.
 *  - A downgrade that locks something waits for "I understand" while locks
 *    are on, and sends acknowledgeLocks; the server's 409
 *    LOCKS_NOT_ACKNOWLEDGED shows its report and asks for it.
 *  - The export of locked data is offered to the workspace owner only.
 *  - The banner shows what is locked now and when it is deleted, to the
 *    owner and admins, only while locks are on.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within, cleanup } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import en from '@/i18n/locales/en';
import fa from '@/i18n/locales/fa';
import tr from '@/i18n/locales/tr';

const i18n = vi.hoisted(() => ({
  t: (k: string, vars?: Record<string, string>) => (vars ? `${k} ${JSON.stringify(vars)}` : k),
}));
vi.mock('@/i18n', () => ({
  useTranslation: () => ({ t: i18n.t, locale: 'en', dir: 'ltr' }),
}));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/edition', async (orig) => ({ ...(await orig<object>()), currentEdition: () => 'international' }));

const banner = vi.hoisted(() => ({
  locks: null as unknown,
  role: 'owner' as string | null,
}));
vi.mock('@/hooks/useEntitlements', async (orig) => ({
  ...(await orig<object>()),
  useWorkspaceLocks: () => banner.locks,
}));
vi.mock('@/hooks/useWorkspaceRole', () => ({
  useWorkspaceRole: () => ({ data: banner.role }),
  isWorkspaceAdmin: (role: string | null | undefined) => role === 'owner' || role === 'admin',
}));
vi.mock('@/hooks/useWorkspace', async (orig) => ({
  ...(await orig<object>()),
  useWorkspacePath: () => (path: string) => `/acme${path}`,
}));

const api = {
  view: vi.fn(),
  ledger: vi.fn(),
  plans: vi.fn(),
  quote: vi.fn(),
  change: vi.fn(),
  buyPlan: vi.fn(),
  lockReport: vi.fn(),
  lockedExport: vi.fn(),
  startLockedExport: vi.fn(),
  lockedExportDownloadUrl: vi.fn(),
};
vi.mock('@/lib/accountBillingApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/accountBillingApi')>()),
  accountBillingApi: api,
}));

beforeAll(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

const AccountBillingPage = (await import('@/pages/app/billing/account/AccountBillingPage')).default;
const LockReport = (await import('@/pages/app/billing/account/LockReport')).default;
const { LockedDataBanner } = await import('@/components/layout/LockedDataBanner');
const { AccountApiError } = await import('@/lib/accountBillingApi');
type Report = import('@/lib/accountBillingApi').LockReport;

const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();
const PERIOD_END = inDays(20);

const VIEW = {
  edition: 'international',
  currency: 'USD',
  balance_minor: 0,
  auto_renew: true,
  billing_profile: {},
  vat_percent: null,
  plan: {
    plan_id: 'pro', slug: 'pro', name: 'Pro', localized: {}, is_free: false, status: 'active',
    billing_interval: 'monthly', current_period_start: inDays(-10), current_period_end: PERIOD_END, trial_end: null,
  },
  has_account: true,
  can_manage: true,
  gateways: [],
  paid_period: { plan_id: 'pro', billing_interval: 'monthly', current_period_start: inDays(-10), current_period_end: PERIOD_END },
  scheduled_plan: null,
  scheduled_interval: null,
  next_period_prepaid_minor: null,
  renewal: { plan_id: 'pro', name: 'Pro', localized: {}, billing_interval: 'monthly', price_minor: 2900 },
  lapsed: null,
  days_left: 20,
  card: null,
  card_available: false,
  card_providers: [],
};

const PLANS = [
  { id: 'free', slug: 'free', name: 'Free', description: null, localized: {}, is_free: true, sort_order: 0, limits: {}, entitlements: {}, price_monthly_minor: 0, price_yearly_minor: 0 },
  { id: 'pro', slug: 'pro', name: 'Pro', description: null, localized: {}, is_free: false, sort_order: 1, limits: {}, entitlements: {}, price_monthly_minor: 2900, price_yearly_minor: null },
];

function report(over: Partial<Report> = {}): Report {
  return {
    locks_enabled: true,
    plan_id: 'free',
    kb_article: { limit: 2, total: 4, locked: 2, items: [{ id: 'a3', title: 'Refunds' }, { id: 'a4', title: null }] },
    contact: { limit: 100, total: 412, locked: 312 },
    member: { limit: 2, total: 4, locked: 2, items: [{ user_id: 'u3', name: 'Sara', email: 's@x.io' }, { user_id: 'u4', name: null, email: 'n@x.io' }] },
    conversation: { retention_days: 30, total: 900, locked: 840, cutoff: inDays(-30), oldest_kept: inDays(-29) },
    conversation_quota: { limit: 50, used_this_month: 71, full: true },
    storage: { limit_gb: 1, used_gb: 3.42, uploads_blocked: true },
    locked_data_retention_days: 90,
    first_deletion_not_before: inDays(90),
    modules_lost: [{ key: 'seo', in_use: false }],
    channels_lost: [{ key: 'telegram', in_use: true }],
    channels_stop_messages: true,
    ai_credits: { current: 1000, target: 0 },
    has_locks: true,
    ...over,
  };
}

/** Moving to Free at the period end. */
const SCHEDULE_FREE = {
  kind: 'schedule', plan_id: 'free', billing_interval: 'monthly', currency: 'USD', amount_minor: 0, returned_minor: 0,
  period_price_minor: 0, upgrade_cost_minor: null, effective_at: PERIOD_END, period_end: PERIOD_END, months_left: null,
  balance_minor: 0, shortfall_minor: 0, prepaid_minor: null, next_period_price_minor: null, auto_renew: true,
  next_period_option: false, next_period_amount_minor: 0, next_period_returned_minor: 0,
};

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/acme/billing']}>
      <Routes>
        <Route path="/:slug/billing" element={<AccountBillingPage workspaceId="ws-1" slug="acme" />} />
      </Routes>
    </MemoryRouter>,
  );
}

async function pickFree() {
  renderPage();
  fireEvent.click(await screen.findByText('billing.account.plan.change'));
  fireEvent.click(await screen.findByTestId('plan-option-free'));
  return screen.findByTestId('plan-quote');
}

/** GET /api/workspaces/:id/role answers this role. */
function stubRole(role: string | null) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).endsWith('/role')) return { ok: true, json: async () => ({ role }) };
    return { ok: false, json: async () => ({}) };
  }));
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.view.mockResolvedValue(VIEW);
  api.ledger.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 });
  api.plans.mockResolvedValue({ currency: 'USD', plans: PLANS });
  api.quote.mockResolvedValue(SCHEDULE_FREE);
  api.lockedExport.mockResolvedValue({ job: null });
  banner.locks = null;
  banner.role = 'owner';
  stubRole('admin');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the downgrade report', () => {
  it('lists every lock the server counted, with the deletion rule', () => {
    render(<LockReport report={report()} effectiveAt={PERIOD_END} />);
    const box = screen.getByTestId('lock-report');
    expect(within(box).getByTestId('lock-report-kb')).toHaveTextContent('billing.locks.report.kb {"locked":"2","total":"4","limit":"2"}');
    expect(within(box).getByText('Refunds')).toBeInTheDocument();
    expect(within(box).getByText('billing.locks.report.untitled')).toBeInTheDocument();
    expect(within(box).getByTestId('lock-report-contact')).toHaveTextContent('"locked":"312"');
    expect(within(box).getByText('Sara')).toBeInTheDocument();
    expect(within(box).getByText('n@x.io')).toBeInTheDocument();
    expect(within(box).getByTestId('lock-report-conversation')).toHaveTextContent('"count":"840","days":"30"');
    expect(within(box).getByTestId('lock-report-quota')).toHaveTextContent('"used":"71","limit":"50"');
    expect(within(box).getByTestId('lock-report-storage')).toHaveTextContent('"used":"3.4","limit":"1"');
    // Modules and channels by name; a channel in use says so, and its messages stop.
    expect(within(box).getByTestId('lock-report-modules')).toHaveTextContent('SEO');
    expect(within(box).getByTestId('lock-report-channels')).toHaveTextContent('billing.locks.report.inUse');
    expect(within(box).getByText('billing.locks.report.channelsWarning')).toBeInTheDocument();
    expect(within(box).getByTestId('lock-report-ai')).toHaveTextContent('"current":"1,000","target":"0"');
    expect(within(box).getByTestId('lock-report-retention')).toHaveTextContent('billing.locks.report.retention {"days":"90"');
    expect(within(box).getByText(/billing\.locks\.report\.asOf/)).toBeInTheDocument();
    expect(within(box).queryByTestId('lock-report-preview')).toBeNull();
  });

  it('while locks are off, the data counts are a preview and only what follows the plan anyway is listed', () => {
    render(<LockReport report={report({ locks_enabled: false })} />);
    const box = screen.getByTestId('lock-report');
    expect(within(box).getByTestId('lock-report-preview')).toBeInTheDocument();
    for (const id of ['kb', 'contact', 'member', 'conversation', 'retention']) {
      expect(within(box).queryByTestId(`lock-report-${id}`)).toBeNull();
    }
    expect(within(box).getByTestId('lock-report-modules')).toBeInTheDocument();
    expect(within(box).getByTestId('lock-report-quota')).toBeInTheDocument();
    // A stopped channel's messages still arrive while locks are off: no warning.
    expect(within(box).getByTestId('lock-report-channels')).toBeInTheDocument();
    expect(within(box).queryByText('billing.locks.report.channelsWarning')).toBeNull();
  });

  it('says when locked data is never deleted, and when nothing is locked', () => {
    const { unmount } = render(<LockReport report={report({ locked_data_retention_days: null, first_deletion_not_before: null })} />);
    expect(screen.getByTestId('lock-report-retention')).toHaveTextContent('billing.locks.report.neverDeleted');
    unmount();
    const none = report({
      kb_article: { limit: null, total: 4, locked: 0, items: [] },
      contact: { limit: null, total: 4, locked: 0 },
      member: { limit: null, total: 1, locked: 0, items: [] },
      conversation: { retention_days: null, total: 4, locked: 0, cutoff: null, oldest_kept: null },
      conversation_quota: { limit: null, used_this_month: 1, full: false },
      storage: { limit_gb: null, used_gb: 0, uploads_blocked: false },
      modules_lost: [],
      channels_lost: [],
      channels_stop_messages: false,
      ai_credits: { current: 0, target: 0 },
      has_locks: false,
    });
    render(<LockReport report={none} />);
    expect(screen.getByTestId('lock-report-nothing')).toBeInTheDocument();
    expect(screen.queryByTestId('lock-report-retention')).toBeNull();
  });
});

describe('a downgrade that locks data', () => {
  it('waits for "I understand" while locks are on, then sends the acknowledgement', async () => {
    api.quote.mockResolvedValue({ ...SCHEDULE_FREE, lock_report: report() });
    api.change.mockResolvedValue({ action: 'change_scheduled' });
    const quote = await pickFree();
    expect(await within(quote).findByTestId('lock-report')).toBeInTheDocument();
    const confirm = within(quote).getByTestId('confirm-change');
    expect(confirm).toBeDisabled();
    fireEvent.click(within(within(quote).getByTestId('lock-report-ack')).getByRole('checkbox'));
    await waitFor(() => expect(confirm).toBeEnabled());
    fireEvent.click(confirm);
    await waitFor(() => expect(api.change).toHaveBeenCalledWith('ws-1', 'free', 'monthly', 0, true));
  });

  it('while locks are off the quote carries no report: no box, nothing asked', async () => {
    api.quote.mockResolvedValue(SCHEDULE_FREE);
    api.change.mockResolvedValue({ action: 'change_scheduled' });
    const quote = await pickFree();
    await waitFor(() => expect(within(quote).getByTestId('confirm-change')).toBeEnabled());
    expect(within(quote).queryByTestId('lock-report')).toBeNull();
    expect(within(quote).queryByTestId('lock-report-ack')).toBeNull();
    fireEvent.click(within(quote).getByTestId('confirm-change'));
    await waitFor(() => expect(api.change).toHaveBeenCalledWith('ws-1', 'free', 'monthly', 0));
  });

  it('a plan bought from a trial or Free shows what it locks and waits for "I understand" too', async () => {
    api.quote.mockResolvedValue({
      ...SCHEDULE_FREE, kind: 'purchase', amount_minor: 0, effective_at: new Date().toISOString(), lock_report: report(),
    });
    api.buyPlan.mockResolvedValue({ action: 'purchased' });
    const quote = await pickFree();
    expect(await within(quote).findByTestId('lock-report')).toBeInTheDocument();
    const buy = within(quote).getByTestId('confirm-plan');
    expect(buy).toBeDisabled();
    fireEvent.click(within(within(quote).getByTestId('lock-report-ack')).getByRole('checkbox'));
    await waitFor(() => expect(buy).toBeEnabled());
    fireEvent.click(buy);
    await waitFor(() => expect(api.buyPlan).toHaveBeenCalledWith('ws-1', expect.objectContaining({ planId: 'free', acknowledgeLocks: true })));
  });

  it('the server\'s 409 LOCKS_NOT_ACKNOWLEDGED shows its report and asks for the acknowledgement', async () => {
    api.change
      .mockRejectedValueOnce(new AccountApiError('LOCKS_NOT_ACKNOWLEDGED', 409, { lock_report: report() }))
      .mockResolvedValue({ action: 'change_scheduled' });
    const quote = await pickFree();
    expect(within(quote).queryByTestId('lock-report')).toBeNull();
    fireEvent.click(within(quote).getByTestId('confirm-change'));
    expect(await within(quote).findByTestId('lock-report')).toBeInTheDocument();
    // The error is said (accountErrorText: billing.account.errors.LOCKS_NOT_ACKNOWLEDGED).
    expect(within(quote).getByRole('alert')).toBeInTheDocument();
    expect(en.billing.account.errors.LOCKS_NOT_ACKNOWLEDGED).toBeTruthy();
    // The quote is not asked again: the report stays on the page.
    expect(api.quote).toHaveBeenCalledTimes(1);
    const confirm = within(quote).getByTestId('confirm-change');
    expect(confirm).toBeDisabled();
    fireEvent.click(within(within(quote).getByTestId('lock-report-ack')).getByRole('checkbox'));
    fireEvent.click(confirm);
    await waitFor(() => expect(api.change).toHaveBeenLastCalledWith('ws-1', 'free', 'monthly', 0, true));
  });

  it('offers the export of locked data to the owner only', async () => {
    api.quote.mockResolvedValue({ ...SCHEDULE_FREE, lock_report: report() });
    stubRole('owner');
    let quote = await pickFree();
    expect(await within(quote).findByTestId('locked-export')).toBeInTheDocument();
    expect(within(quote).getByText('billing.locks.export.button')).toBeInTheDocument();
    cleanup();

    stubRole('admin');
    quote = await pickFree();
    await within(quote).findByTestId('lock-report');
    await new Promise((r) => setTimeout(r, 20));
    expect(within(quote).queryByTestId('locked-export')).toBeNull();
  });

  it('the export starts, and a finished one is downloaded through a one-time link', async () => {
    api.quote.mockResolvedValue({ ...SCHEDULE_FREE, lock_report: report() });
    stubRole('owner');
    api.lockedExport.mockResolvedValue({
      job: { id: 'job-1', status: 'completed', kinds: ['kb_article'], counts: {}, expires_at: inDays(7), created_at: inDays(0) },
    });
    api.lockedExportDownloadUrl.mockResolvedValue('about:blank#download');
    const assign = vi.fn();
    vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, assign } as Location);
    const quote = await pickFree();
    fireEvent.click(await within(quote).findByText('billing.locks.export.download'));
    await waitFor(() => expect(api.lockedExportDownloadUrl).toHaveBeenCalledWith('ws-1', 'job-1'));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('about:blank#download'));
    vi.restoreAllMocks();
  });
});

describe('the lock banner', () => {
  const LOCKS = {
    enabled: true,
    kb_article: { limit: 2, total: 4, locked: 2, cut: { ts: inDays(-5), id: 'a2' } },
    contact: { limit: 100, total: 100, locked: 0, cut: null },
    member: { limit: 1, total: 3, locked: 2, cut: null },
    conversation: null,
    any_locked: true,
    next_deletion_at: inDays(40),
  };
  const renderBanner = () => render(
    <MemoryRouter>
      <LockedDataBanner workspaceId="ws-1" />
    </MemoryRouter>,
  );

  it('says what is locked and when it is deleted, with the report on demand', async () => {
    banner.locks = LOCKS;
    api.lockReport.mockResolvedValue(report());
    renderBanner();
    const box = screen.getByTestId('locked-data-banner');
    expect(box).toHaveTextContent(/billing\.locks\.kinds\.kb_article \{\\"count\\":\\"2\\"\}/);
    expect(box).toHaveTextContent(/billing\.locks\.kinds\.member \{\\"count\\":\\"2\\"\}/);
    expect(box).not.toHaveTextContent('billing.locks.kinds.contact');
    expect(within(box).getByTestId('locked-data-deletion')).toHaveTextContent('billing.locks.banner.deletion');
    expect(within(box).getByRole('link')).toHaveAttribute('href', '/acme/billing');
    fireEvent.click(within(box).getByText('billing.locks.banner.details'));
    expect(await within(box).findByTestId('lock-report')).toHaveTextContent('billing.locks.report.titleNow');
    expect(api.lockReport).toHaveBeenCalledWith('ws-1');
  });

  it('is not shown while locks are off, when nothing is locked, or to agents', () => {
    banner.locks = { ...LOCKS, enabled: false };
    const { unmount } = renderBanner();
    expect(screen.queryByTestId('locked-data-banner')).toBeNull();
    unmount();
    banner.locks = { ...LOCKS, any_locked: false };
    const second = renderBanner();
    expect(screen.queryByTestId('locked-data-banner')).toBeNull();
    second.unmount();
    banner.locks = LOCKS;
    banner.role = 'agent';
    renderBanner();
    expect(screen.queryByTestId('locked-data-banner')).toBeNull();
  });
});

describe('the lock texts', () => {
  const SECTIONS = ['billing.locks', 'kb.locked', 'contacts.locked', 'inbox.locked', 'members.seatLocked', 'admin.billingLocks'];
  const at = (root: unknown, path: string) =>
    path.split('.').reduce<unknown>((node, key) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[key] : undefined), root);
  const leaves = (node: unknown, prefix = ''): string[] =>
    node && typeof node === 'object'
      ? Object.entries(node as Record<string, unknown>).flatMap(([k, v]) => leaves(v, prefix ? `${prefix}.${k}` : k))
      : [prefix];
  const params = (s: string) => [...s.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort();

  for (const [name, locale] of Object.entries({ fa, tr })) {
    it(`exist in ${name} with the same placeholders as English`, () => {
      for (const section of SECTIONS) {
        for (const key of leaves(at(en, section))) {
          const source = at(at(en, section), key) as string;
          const text = at(at(locale, section), key);
          expect(typeof text, `${name} ${section}.${key}`).toBe('string');
          expect((text as string).trim(), `${name} ${section}.${key}`).not.toBe('');
          expect(params(text as string), `${name} ${section}.${key}`).toEqual(params(source));
        }
      }
    });
  }

  it('write Persian with Persian letters, not Arabic ي and ك', () => {
    const all = SECTIONS.flatMap((section) => leaves(at(fa, section)).map((key) => at(at(fa, section), key) as string));
    all.push(fa.billing.account.errors.LOCKS_NOT_ACKNOWLEDGED);
    expect(all.join('\n')).not.toMatch(/[يك]/);
  });
});
