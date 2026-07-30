/**
 * PlanUsagePanel — customer-facing visibility tests.
 *
 * Pin behaviour around the canonical backend payload:
 *   - effective limit value + usage percentage come from the canonical
 *     `/api/plans/workspace/:id/effective` response, not local logic
 *   - -1 renders as "Unlimited"
 *   - usage progress is computed from the canonical counter column
 *   - usage-unavailable limits show explicit fallback copy instead of
 *     guessing
 *   - Super Admin override edit controls are not rendered
 *   - registry-driven labels are used (only userVisible capabilities)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

vi.mock('../../lib/api', () => ({ API_BASE: 'http://x' }));

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonOk(body: unknown) {
  return { ok: true, status: 200, json: async () => body, statusText: 'OK' } as any;
}

const baseEffective = {
  workspaceId: 'ws_1',
  plan: { name: 'Pro' },
  subscription: { status: 'active' },
  features: {},
  modules: { chat: { value: true, source: 'plan' }, automation: { value: false, source: 'default' } },
  channels: {},
  limits: {
    max_conversations: { value: 1000, source: 'plan', unit: 'per_month' },
    max_visitors: { value: -1, source: 'override', unit: 'per_month' },
    max_contacts: { value: 500, source: 'override', unit: 'count' },
  },
  usage: { conversations_count: 250, visitors_count: 9999 },
  raw: { entitlements: {}, limits: {} },
};

const baseCatalog = {
  capabilities: [
    { key: 'max_conversations', type: 'limit', label: 'Conversations / month', group: 'usage', defaultValue: 100, planConfigurable: true, workspaceOverridable: true, userVisible: true, unit: 'per_month', sortOrder: 10 },
    { key: 'max_visitors',      type: 'limit', label: 'Tracked Visitors / month', group: 'usage', defaultValue: 1000, planConfigurable: true, workspaceOverridable: true, userVisible: true, unit: 'per_month', sortOrder: 20 },
    { key: 'max_contacts',      type: 'limit', label: 'Max Contacts', group: 'contacts', defaultValue: 100, planConfigurable: true, workspaceOverridable: true, userVisible: true, unit: 'count', sortOrder: 60 },
    { key: 'chat',       type: 'module', label: 'Live Chat',  group: 'modules', defaultValue: true,  planConfigurable: true, workspaceOverridable: true, userVisible: true, sortOrder: 10 },
    { key: 'automation', type: 'module', label: 'Automation', group: 'modules', defaultValue: false, planConfigurable: true, workspaceOverridable: true, userVisible: true, sortOrder: 60 },
    { key: 'internal_thing', type: 'feature', label: 'Internal', group: 'sys', defaultValue: false, planConfigurable: false, workspaceOverridable: false, userVisible: false, internalOnly: true, sortOrder: 1 },
  ],
  total: 6,
};

function mockBoth(eff = baseEffective, cat = baseCatalog) {
  fetchMock.mockImplementation((url: string) => {
    if (url.includes('/effective')) return Promise.resolve(jsonOk(eff));
    if (url.includes('/capabilities')) return Promise.resolve(jsonOk(cat));
    return Promise.reject(new Error(`unexpected ${url}`));
  });
}

async function loadPanel() {
  const { PlanUsagePanel } = await import('../../components/billing/PlanUsagePanel');
  render(<PlanUsagePanel workspaceId="ws_1" />);
  await waitFor(() => expect(screen.getByTestId('plan-usage-panel')).toBeInTheDocument());
}

describe('PlanUsagePanel', () => {
  it('renders effective limit value and usage ratio from canonical payload', async () => {
    mockBoth();
    await loadPanel();
    const row = screen.getByTestId('limit-row-max_conversations');
    expect(row.textContent).toContain('Conversations / month');
    // Redesigned card format: "<used> of <limit><unit suffix>"
    expect(row.textContent).toMatch(/250\s*of\s*1,000/);
    // Percentage is derived from the canonical usage + limit (250/1000).
    expect(row.textContent).toContain('25%');
    expect(row.querySelector('[role="progressbar"], .bg-muted')).not.toBeNull();
  });

  it('renders -1 as Unlimited and hides progress bar', async () => {
    mockBoth();
    await loadPanel();
    const row = screen.getByTestId('limit-row-max_visitors');
    expect(row.textContent).toContain('Unlimited');
    expect(row.querySelector('[role="progressbar"]')).toBeNull();
  });

  it('shows explicit fallback when usage is unavailable rather than faking it', async () => {
    mockBoth();
    await loadPanel();
    const row = screen.getByTestId('limit-row-max_contacts');
    expect(row.textContent).toContain('500');
    expect(row.textContent?.toLowerCase()).toContain('not tracked');
    // No fabricated " / " usage prefix
    expect(row.textContent).not.toContain('0 / 500');
  });

  it('hides internal-only / non-userVisible capabilities', async () => {
    mockBoth();
    await loadPanel();
    expect(screen.queryByText('Internal')).toBeNull();
  });

  it('does not expose Super Admin override controls (no edit/clear/save buttons)', async () => {
    mockBoth();
    await loadPanel();
    const panel = screen.getByTestId('plan-usage-panel');
    expect(panel.querySelectorAll('input').length).toBe(0);
    expect(panel.querySelectorAll('button').length).toBe(0);
  });
});