/**
 * Follow-up 2B (to the Follow-up 2 plan-limit key separation) — customer-facing
 * Billing page integration for the 3 new AI Agent Web Pages (Data Hub)
 * capability keys: ai_agent_web_source_max_pages / _max_depth /
 * _jobs_per_month.
 *
 * The capability registry (server/services/billing/capabilityRegistry.ts)
 * already defines these 3 keys (group: 'ai', type: 'limit', userVisible:
 * true), so BillingPage's registry-driven `visible` list already includes
 * them. Two BillingPage-local, per-key hardcoded maps do NOT auto-populate
 * for new keys, though, and were the actual defect:
 *
 *  - CAP_LABELS_FA / CAP_LABELS_TR: missing entries fall through to the
 *    English registry label even when locale is fa/tr.
 *  - MODULE_GATE: `isGatedOut(key)` treats a key ABSENT from the map as
 *    "never gated" (`if (!gates || gates.length === 0) return false`), so a
 *    plan with the AI Assistant module disabled would still display these 3
 *    limits merely because they have a non-zero value.
 *
 * These tests render the real BillingPage (Plans tab, which contains the
 * module-private PlanCapabilityList) rather than duplicating its filter/gate
 * logic, per the existing PlanUsagePanel testing convention in this repo.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

let currentLocale: 'en' | 'fa' | 'tr' = 'en';

vi.mock('@/i18n', () => ({
  useTranslation: () => ({ locale: currentLocale, dir: currentLocale === 'fa' ? 'rtl' : 'ltr', t: (k: string) => k }),
}));

vi.mock('@/hooks/usePlatformRegion', () => ({
  usePlatformRegion: () => ({ mode: 'global' }),
}));

vi.mock('@/components/billing/PlanUsagePanel', () => ({
  PlanUsagePanel: () => null,
}));

const workspace = { id: 'ws-1', default_locale: 'en' };
vi.mock('@/hooks/useWorkspace', () => ({
  useWorkspaces: () => ({ data: [workspace] }),
}));

const CAPABILITIES = [
  { key: 'ai_assistant', type: 'module', label: 'AI Assistant', group: 'modules', defaultValue: false, planConfigurable: true, workspaceOverridable: true, userVisible: true, sortOrder: 5 },
  { key: 'ai_kb_max_pages', type: 'limit', label: 'AI KB Builder — Max pages per crawl', group: 'ai', defaultValue: 25, planConfigurable: true, workspaceOverridable: true, userVisible: true, unit: 'count', sortOrder: 101 },
  { key: 'ai_kb_max_depth', type: 'limit', label: 'AI KB Builder — Crawl depth', group: 'ai', defaultValue: 2, planConfigurable: true, workspaceOverridable: true, userVisible: true, unit: 'count', sortOrder: 102 },
  { key: 'ai_kb_jobs_per_month', type: 'limit', label: 'AI KB Builder — Jobs / month', group: 'ai', defaultValue: 5, planConfigurable: true, workspaceOverridable: true, userVisible: true, unit: 'per_month', sortOrder: 103 },
  { key: 'ai_agent_web_source_max_pages', type: 'limit', label: 'AI Agent — Web Pages: Max pages per source', group: 'ai', defaultValue: 50, planConfigurable: true, workspaceOverridable: true, userVisible: true, unit: 'count', sortOrder: 111 },
  { key: 'ai_agent_web_source_max_depth', type: 'limit', label: 'AI Agent — Web Pages: Crawl depth', group: 'ai', defaultValue: 2, planConfigurable: true, workspaceOverridable: true, userVisible: true, unit: 'count', sortOrder: 121 },
  { key: 'ai_agent_web_source_jobs_per_month', type: 'limit', label: 'AI Agent — Web Pages: Sync jobs / month', group: 'ai', defaultValue: 5, planConfigurable: true, workspaceOverridable: true, userVisible: true, unit: 'per_month', sortOrder: 131 },
] as any[];

vi.mock('@/hooks/useEntitlements', () => ({
  useCapabilityCatalog: () => ({ capabilities: CAPABILITIES }),
}));

function makePlan(overrides: Record<string, any> = {}) {
  return {
    id: 'plan-1',
    slug: 'pro',
    name: 'Pro',
    is_free: false,
    prices: { USD: { monthly: 1000, yearly: 10000 } },
    provider_price_ids: {},
    localized: {},
    entitlements: { ai_assistant: false },
    limits: {
      ai_kb_max_pages: 25,
      ai_kb_max_depth: 2,
      ai_kb_jobs_per_month: 5,
      ai_agent_web_source_max_pages: 50,
      ai_agent_web_source_max_depth: 2,
      ai_agent_web_source_jobs_per_month: 5,
    },
    ...overrides,
  };
}

let plansResponse: any[] = [];
vi.mock('@/lib/api', () => ({
  API_BASE: 'http://x',
  billingGetPlans: async () => ({ plans: plansResponse }),
  billingGetStatus: async () => ({ subscription: null, payments: [] }),
  billingCheckout: vi.fn(),
  billingCancel: vi.fn(),
  billingResume: vi.fn(),
  billingGetPortal: vi.fn(),
}));

const BillingPage = (await import('@/pages/app/BillingPage')).default;

// Tab labels are localized (bt(L, 'tabPlans')), so select the "Plans" tab by
// its fixed position (usage, plans, payments) rather than by matching text.
async function renderPlansTab() {
  render(<BillingPage />);
  await waitFor(() => expect(screen.getAllByRole('tab')).toHaveLength(3));
  const plansTab = screen.getAllByRole('tab')[1];
  fireEvent.mouseDown(plansTab);
  fireEvent.click(plansTab);
  await waitFor(() => expect(screen.getByRole('tabpanel')).toBeInTheDocument());
  return within(screen.getByRole('tabpanel'));
}

beforeEach(() => {
  currentLocale = 'en';
  plansResponse = [makePlan()];
});

describe('B1 — disabled AI Assistant hides the new AI Agent web-source limits', () => {
  it('none of the 3 new rows are visible when entitlements.ai_assistant is false', async () => {
    plansResponse = [makePlan({ entitlements: { ai_assistant: false } })];
    const panel = await renderPlansTab();

    expect(panel.queryByText(/Max pages per source/i)).toBeNull();
    expect(panel.queryByText(/Crawl depth/i)).toBeNull();
    expect(panel.queryByText(/Sync jobs \/ month/i)).toBeNull();
  });
});

describe('B2 — enabled AI Assistant shows the new limits with correct formatting', () => {
  it('all 3 rows are visible with registry-consistent formatted values', async () => {
    plansResponse = [makePlan({ entitlements: { ai_assistant: true } })];
    const panel = await renderPlansTab();

    const pagesRow = panel.getByText('AI Agent — Web Pages: Max pages per source').closest('li')!;
    expect(pagesRow.textContent).toContain('50');

    const depthRow = panel.getByText('AI Agent — Web Pages: Crawl depth').closest('li')!;
    expect(depthRow.textContent).toContain('2');

    const jobsRow = panel.getByText('AI Agent — Web Pages: Sync jobs / month').closest('li')!;
    expect(jobsRow.textContent).toMatch(/5\s*\/mo/);
  });
});

describe('B3 — Persian labels for the new keys', () => {
  it('uses the Persian map, not the English registry label', async () => {
    currentLocale = 'fa';
    plansResponse = [makePlan({ entitlements: { ai_assistant: true } })];
    const panel = await renderPlansTab();

    expect(panel.queryByText(/Max pages per source/i)).toBeNull();
    expect(panel.queryByText(/Crawl depth/i)).toBeNull();
    expect(panel.queryByText(/Sync jobs \/ month/i)).toBeNull();

    expect(panel.getByText(/حداکثر صفحات هر منبع وب/)).toBeInTheDocument();
    expect(panel.getByText(/عمق پیمایش صفحات وب/)).toBeInTheDocument();
    expect(panel.getByText(/همگام‌سازی صفحات وب در ماه/)).toBeInTheDocument();
  });
});

describe('B4 — Turkish labels for the new keys', () => {
  it('uses the Turkish map, not the English registry label', async () => {
    currentLocale = 'tr';
    plansResponse = [makePlan({ entitlements: { ai_assistant: true } })];
    const panel = await renderPlansTab();

    expect(panel.queryByText(/Max pages per source/i)).toBeNull();
    expect(panel.queryByText(/Crawl depth/i)).toBeNull();
    expect(panel.queryByText(/Sync jobs \/ month/i)).toBeNull();

    expect(panel.getByText(/Web Kaynağı Başına Maks\. Sayfa/)).toBeInTheDocument();
    expect(panel.getByText(/Web Tarama Derinliği/)).toBeInTheDocument();
    expect(panel.getByText(/Aylık Web Senkronizasyon İşi/)).toBeInTheDocument();
  });
});

describe('B5 — English falls back to the registry label (no third hardcoded map)', () => {
  it('renders the exact English registry labels for the new keys', async () => {
    currentLocale = 'en';
    plansResponse = [makePlan({ entitlements: { ai_assistant: true } })];
    const panel = await renderPlansTab();

    expect(panel.getByText('AI Agent — Web Pages: Max pages per source')).toBeInTheDocument();
    expect(panel.getByText('AI Agent — Web Pages: Crawl depth')).toBeInTheDocument();
    expect(panel.getByText('AI Agent — Web Pages: Sync jobs / month')).toBeInTheDocument();
  });
});

describe('B6 — a zero limit stays hidden (existing "0 = not available" rule unchanged)', () => {
  it('ai_agent_web_source_max_pages = 0 is not rendered even with AI Assistant enabled', async () => {
    plansResponse = [makePlan({
      entitlements: { ai_assistant: true },
      limits: {
        ai_kb_max_pages: 25, ai_kb_max_depth: 2, ai_kb_jobs_per_month: 5,
        ai_agent_web_source_max_pages: 0,
        ai_agent_web_source_max_depth: 2,
        ai_agent_web_source_jobs_per_month: 5,
      },
    })];
    const panel = await renderPlansTab();

    expect(panel.queryByText(/Max pages per source/i)).toBeNull();
    expect(panel.getByText('AI Agent — Web Pages: Crawl depth')).toBeInTheDocument();
  });
});

describe('B7 — historical AI KB Builder limits are unaffected by this follow-up', () => {
  it('ai_kb_max_pages / ai_kb_max_depth / ai_kb_jobs_per_month still render when AI Assistant is enabled', async () => {
    plansResponse = [makePlan({ entitlements: { ai_assistant: true } })];
    const panel = await renderPlansTab();

    expect(panel.getByText(/AI KB Builder — Max pages per crawl/)).toBeInTheDocument();
    expect(panel.getByText(/AI KB Builder — Crawl depth/)).toBeInTheDocument();
    expect(panel.getByText(/AI KB Builder — Jobs \/ month/)).toBeInTheDocument();
  });

  it('ai_kb_* limits stay hidden when AI Assistant is disabled, same as before this follow-up', async () => {
    plansResponse = [makePlan({ entitlements: { ai_assistant: false } })];
    const panel = await renderPlansTab();

    expect(panel.queryByText(/AI KB Builder —/)).toBeNull();
  });
});
