/**
 * PlanUsagePanel — customer-facing visibility tests.
 *
 * Pin behaviour around the canonical backend payloads:
 *   - every limit the effective snapshot carries is shown with its effective
 *     value; -1 renders as "Unlimited" with no progress bar
 *   - used / limit progress comes from GET /limit-usage (the resolvers the
 *     server enforces with), asked in batches of at most 20 keys
 *   - limits the server does not measure show their allowance only, never a
 *     fabricated usage figure
 *   - names, units and group headings come from capability-i18n (en + fa)
 *   - Super Admin override edit controls are not rendered
 *   - only userVisible capabilities are shown
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '@/i18n';
import type { Locale } from '@/i18n/config';
import en from '@/i18n/locales/en';
import fa from '@/i18n/locales/fa';
import { capabilityGroupLabel, capabilityLabel, capabilityUnitLabel } from '@/lib/capability-i18n';
import { clearEffectiveEntitlementsCache } from '@/hooks/useEntitlements';
import type { CapabilityDefinition, LimitUsage, WorkspaceEffectiveEntitlements } from '@/lib/entitlements-api';
import { PlanUsagePanel } from '@/components/billing/PlanUsagePanel';

vi.mock('../../lib/api', () => ({ API_BASE: 'http://x' }));

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  clearEffectiveEntitlementsCache();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonOk(body: unknown) {
  return { ok: true, status: 200, json: async () => body, statusText: 'OK' } as unknown as Response;
}

const baseEffective: WorkspaceEffectiveEntitlements = {
  workspaceId: 'ws_1',
  plan: { id: 'p1', name: 'Pro', slug: 'pro' },
  subscription: null,
  features: {},
  modules: { chat: { value: true, source: 'plan' }, automation: { value: false, source: 'default' } },
  channels: {},
  limits: {
    max_conversations: { value: 1000, source: 'plan', unit: 'per_month' },
    max_visitors: { value: -1, source: 'override', unit: 'per_month' },
    max_contacts: { value: 500, source: 'override', unit: 'count' },
    data_retention_days: { value: 30, source: 'plan', unit: 'days' },
    mobile_promo_interval_minutes: { value: 360, source: 'default' },
  },
  usage: { conversations_count: 250, visitors_count: 9999 },
  raw: { entitlements: {}, limits: {} },
};

function cap(partial: Partial<CapabilityDefinition> & Pick<CapabilityDefinition, 'key' | 'type' | 'label' | 'group'>): CapabilityDefinition {
  return { defaultValue: null, planConfigurable: true, workspaceOverridable: true, userVisible: true, ...partial };
}

const baseCatalog = {
  capabilities: [
    cap({ key: 'max_conversations', type: 'limit', label: 'Conversations / month', group: 'usage', unit: 'per_month', sortOrder: 10 }),
    cap({ key: 'max_visitors', type: 'limit', label: 'Tracked Visitors / month', group: 'usage', unit: 'per_month', sortOrder: 20 }),
    cap({ key: 'data_retention_days', type: 'limit', label: 'Data Retention', group: 'usage', unit: 'days', sortOrder: 40 }),
    cap({ key: 'max_contacts', type: 'limit', label: 'Max Contacts', group: 'contacts', unit: 'count', sortOrder: 60 }),
    cap({ key: 'mobile_promo_interval_minutes', type: 'limit', label: 'Minutes Between Full-screen Promos', group: 'mobile', userVisible: false, sortOrder: 30 }),
    cap({ key: 'chat', type: 'module', label: 'Live Chat', group: 'modules', sortOrder: 10 }),
    cap({ key: 'automation', type: 'module', label: 'Automation', group: 'modules', sortOrder: 60 }),
    cap({ key: 'internal_thing', type: 'feature', label: 'Internal', group: 'sys', userVisible: false, internalOnly: true, sortOrder: 1 }),
  ],
  total: 8,
};

/** What the server can measure (usageResolvers RESOLVERS subset used here). */
const MEASURED: Record<string, number> = { max_conversations: 250, max_contacts: 42, max_visitors: 9999 };

function keysOf(url: string): string[] {
  return (new URL(url).searchParams.get('keys') || '').split(',').filter(Boolean);
}

function mockApi(opts: {
  eff?: WorkspaceEffectiveEntitlements;
  cat?: typeof baseCatalog;
  limitUsage?: 'ok' | 'fail';
} = {}) {
  const { eff = baseEffective, cat = baseCatalog, limitUsage = 'ok' } = opts;
  fetchMock.mockImplementation((url: string) => {
    if (url.includes('/effective')) return Promise.resolve(jsonOk(eff));
    if (url.includes('/capabilities')) return Promise.resolve(jsonOk(cat));
    if (url.includes('/limit-usage')) {
      if (limitUsage === 'fail') return Promise.reject(new Error('limit-usage down'));
      const usage: LimitUsage['usage'] = {};
      // The server drops keys it cannot measure and answers at most 20.
      for (const k of keysOf(url).filter((key) => key in MEASURED).slice(0, 20)) {
        usage[k] = { value: MEASURED[k], supported: true, period: '2026-09' };
      }
      return Promise.resolve(jsonOk({ workspaceId: 'ws_1', usage }));
    }
    return Promise.reject(new Error(`unexpected ${url}`));
  });
}

function limitUsageCalls(): string[][] {
  return fetchMock.mock.calls
    .map(([url]) => String(url))
    .filter((url) => url.includes('/limit-usage'))
    .map(keysOf);
}

async function renderPanel(locale: Locale = 'en') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider initialLocale={locale} initialTranslations={locale === 'fa' ? fa : en}>
        <PlanUsagePanel workspaceId="ws_1" />
      </I18nProvider>
    </QueryClientProvider>,
  );
  await waitFor(() => expect(screen.getByTestId('plan-usage-panel')).toBeInTheDocument());
}

describe('PlanUsagePanel', () => {
  it('renders the effective limit value and usage ratio from /limit-usage', async () => {
    mockApi();
    await renderPanel();
    await waitFor(() => expect(screen.getByTestId('limit-row-max_contacts').textContent).toMatch(/42\s*of\s*500/));
    const row = screen.getByTestId('limit-row-max_conversations');
    expect(row.textContent).toContain('Conversations / month');
    expect(row.textContent).toMatch(/250\s*of\s*1,000 per month/);
    expect(row.textContent).toContain('25%');
    expect(row.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('25');
  });

  it('shows usage for a limit the old counters never covered (max_contacts)', async () => {
    mockApi();
    await renderPanel();
    await waitFor(() => expect(screen.getByTestId('limit-row-max_contacts').textContent).toMatch(/42\s*of\s*500/));
    const row = screen.getByTestId('limit-row-max_contacts');
    expect(row.textContent).toContain('8%');
    expect(row.querySelector('[role="progressbar"]')).not.toBeNull();
  });

  it('renders -1 as Unlimited, hides the progress bar and does not ask for its usage', async () => {
    mockApi();
    await renderPanel();
    await waitFor(() => expect(limitUsageCalls().length).toBeGreaterThan(0));
    const row = screen.getByTestId('limit-row-max_visitors');
    expect(row.textContent).toContain('Unlimited');
    expect(row.querySelector('[role="progressbar"]')).toBeNull();
    expect(limitUsageCalls().flat()).not.toContain('max_visitors');
  });

  it('shows only the allowance for a limit the server does not measure', async () => {
    mockApi();
    await renderPanel();
    await waitFor(() => expect(limitUsageCalls().length).toBeGreaterThan(0));
    const row = screen.getByTestId('limit-row-data_retention_days');
    expect(row.textContent).toContain('Data Retention');
    expect(row.textContent).toContain('30 days');
    expect(row.textContent).toContain(en.billing.planLimits.allowance);
    expect(row.textContent).not.toMatch(/\bof\b/);
    expect(row.querySelector('[role="progressbar"]')).toBeNull();
  });

  it('groups limits under their localized capability group', async () => {
    mockApi();
    await renderPanel();
    const usage = screen.getByTestId('limit-group-usage');
    const contacts = screen.getByTestId('limit-group-contacts');
    expect(usage.querySelector('h3')?.textContent).toBe(capabilityGroupLabel('usage', 'en'));
    expect(contacts.querySelector('h3')?.textContent).toBe(capabilityGroupLabel('contacts', 'en'));
    expect(usage.querySelector('[data-testid="limit-row-max_contacts"]')).toBeNull();
    expect(contacts.querySelector('[data-testid="limit-row-max_contacts"]')).not.toBeNull();
  });

  it('asks /limit-usage in batches of at most 20 keys covering every finite limit once', async () => {
    const keys = Array.from({ length: 45 }, (_, i) => `limit_${String(i).padStart(2, '0')}`);
    const eff: WorkspaceEffectiveEntitlements = {
      ...baseEffective,
      limits: Object.fromEntries(keys.map((k) => [k, { value: 10, source: 'plan' as const, unit: 'count' }])),
    };
    mockApi({ eff });
    await renderPanel();
    await waitFor(() => expect(limitUsageCalls().length).toBe(3));
    const calls = limitUsageCalls();
    for (const batch of calls) expect(batch.length).toBeLessThanOrEqual(20);
    expect(calls.flat().sort()).toEqual([...keys].sort());
    // Limits unknown to the catalog are still shown, with their allowance.
    expect(screen.getByTestId('limit-row-limit_44').textContent).toContain('10');
  });

  it('falls back to the snapshot counters and says so when /limit-usage fails', async () => {
    mockApi({ limitUsage: 'fail' });
    await renderPanel();
    await waitFor(() => expect(screen.getByTestId('limit-usage-error')).toBeInTheDocument());
    expect(screen.getByTestId('limit-usage-error').textContent).toBe(en.billing.planLimits.usageUnavailable);
    expect(screen.getByTestId('limit-row-max_conversations').textContent).toMatch(/250\s*of\s*1,000/);
    // No counter column for contacts: allowance only, nothing fabricated.
    const contacts = screen.getByTestId('limit-row-max_contacts');
    expect(contacts.textContent).toContain(en.billing.planLimits.allowance);
    expect(contacts.textContent).not.toMatch(/\bof\b/);
  });

  it('uses capability-i18n names and units in Persian', async () => {
    mockApi();
    await renderPanel('fa');
    const row = screen.getByTestId('limit-row-data_retention_days');
    expect(row.textContent).toContain(capabilityLabel('data_retention_days', 'fa'));
    expect(row.textContent).toContain(capabilityUnitLabel('days', 'fa'));
    expect(row.textContent).toContain(fa.billing.planLimits.allowance);
    expect(screen.getByTestId('limit-row-max_visitors').textContent).toContain('نامحدود');
    expect(screen.getByTestId('limit-group-usage').querySelector('h3')?.textContent).toBe(capabilityGroupLabel('usage', 'fa'));
  });

  it('hides internal-only / non-userVisible capabilities', async () => {
    mockApi();
    await renderPanel();
    expect(screen.queryByText('Internal')).toBeNull();
    expect(screen.queryByTestId('limit-row-mobile_promo_interval_minutes')).toBeNull();
  });

  it('does not expose Super Admin override controls (no edit/clear/save buttons)', async () => {
    mockApi();
    await renderPanel();
    const panel = screen.getByTestId('plan-usage-panel');
    expect(panel.querySelectorAll('input').length).toBe(0);
    expect(panel.querySelectorAll('button').length).toBe(0);
  });
});
