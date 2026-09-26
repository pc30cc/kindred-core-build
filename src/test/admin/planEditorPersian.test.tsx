/**
 * Super Admin → Plans: opening a plan in the Persian UI must show every tab of
 * the editor in Persian. The capability labels, descriptions, group headings
 * and unit badges come from the English server registry, so this drives the
 * real page through each tab and checks that none of that English leaks.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '@/i18n';
import fa from '@/i18n/locales/fa';
import {
  CAPABILITY_REGISTRY,
  type CapabilityDefinition,
} from '../../../server/services/billing/capabilityRegistry';
import {
  capabilityDescription,
  capabilityGroupLabel,
  capabilityLabel,
  capabilityUnitLabel,
} from '@/lib/capability-i18n';

const PLAN = vi.hoisted(() => ({
  id: 'plan-pro',
  name: 'Pro',
  slug: 'pro',
  description: '',
  is_free: false,
  is_active: true,
  is_hidden: false,
  sort_order: 1,
  trial_days: 14,
  default_currency: 'USD',
  prices: { USD: { monthly: 29, yearly: 290 } },
  entitlements: { chat: true, whatsapp: true, widget_voice_notes: true, retired_flag: true },
  limits: { max_agents: 5, max_widget_domains: 3, retired_limit: 7 },
  localized: { fa: { name: 'حرفه‌ای', description: '' } },
}));

vi.mock('@/hooks/usePlans', () => {
  const mutation = () => ({ mutateAsync: vi.fn(), isPending: false });
  return {
    useAdminPlans: () => ({ data: [PLAN], isLoading: false }),
    useAdminSubscriptions: () => ({ data: [] }),
    useCreatePlan: mutation,
    useUpdatePlan: mutation,
    useDeletePlan: mutation,
    useAssignPlan: mutation,
    useRevokePlan: mutation,
  };
});
vi.mock('@/hooks/useAdmin', () => ({ useAdminWorkspaces: () => ({ data: [] }) }));
vi.mock('@/hooks/useEntitlements', async () => {
  const { CAPABILITY_REGISTRY: registry } = await import('../../../server/services/billing/capabilityRegistry');
  const idle = () => ({ data: null, loading: false, error: null, reload: () => {} });
  return {
    useCapabilityCatalog: () => ({ capabilities: registry, loading: false, error: null }),
    useWorkspaceEffectiveEntitlements: idle,
    useEntitlementDiagnostics: idle,
  };
});
vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: () => ({
      select: () => ({
        limit: () => ({ maybeSingle: async () => ({ data: { active_locales: ['en', 'fa', 'tr'] } }) }),
      }),
    }),
  },
}));

import AdminPlansPage from '@/pages/admin/PlansPage';

/** The Persian UI renders digits as ۰–۹; compare on ASCII digits. */
const asciiDigits = (text: string) => text.replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)));

const editable = CAPABILITY_REGISTRY.filter((c) => !c.deprecated && c.planConfigurable !== false);
const byType = (type: CapabilityDefinition['type']) => editable.filter((c) => c.type === type);
const sections = fa.admin.plans.form.sections;
const persianName = (type: 'currency' | 'language', code: string) => new Intl.DisplayNames(['fa'], { type }).of(code)!;
const sectionName = (label: string) => label.replace(/\s*\(\{\{count\}\}\)/, '');

async function openPlanEditor() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <I18nProvider initialLocale="fa" initialTranslations={fa}>
        <AdminPlansPage />
      </I18nProvider>
    </QueryClientProvider>,
  );
  await screen.findByText(fa.admin.plans.title);
  // The card's icon-only edit button is the dialog trigger without text.
  const edit = [...document.querySelectorAll<HTMLButtonElement>('button[aria-haspopup="dialog"]')].find(
    (b) => !b.textContent?.trim(),
  );
  fireEvent.click(edit!);
  return screen.findByRole('dialog');
}

async function showSection(dialog: HTMLElement, label: string) {
  const name = sectionName(label);
  const tab = within(dialog)
    .getAllByRole('button')
    .find((b) => b.textContent?.trim().startsWith(name));
  fireEvent.click(tab!);
  await waitFor(() => expect(tab!.className).toContain('bg-primary'));
  return asciiDigits(dialog.textContent || '');
}

/** Persian copy present, the registry English absent (unless kept on purpose, e.g. «SSO / SAML»). */
function expectPersian(text: string, caps: CapabilityDefinition[]) {
  for (const cap of caps) {
    const label = asciiDigits(capabilityLabel(cap.key, 'fa', cap.label));
    expect(text).toContain(label);
    if (!label.includes(cap.label)) expect(text).not.toContain(cap.label);
    if (cap.description) {
      expect(text).toContain(asciiDigits(capabilityDescription(cap.key, 'fa', cap.description)!));
      expect(text).not.toContain(cap.description);
    }
  }
}

describe('Super Admin plan editor in Persian', () => {
  beforeAll(() => {
    globalThis.ResizeObserver ??= class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  });

  it('shows every tab of an opened plan in Persian', async () => {
    const dialog = await openPlanEditor();
    expect(within(dialog).getByText(`${fa.admin.plans.editPlan}: ${PLAN.localized.fa.name}`)).toBeInTheDocument();

    const general = await showSection(dialog, sections.general);
    expect(general).toContain(fa.admin.plans.form.planName);
    expect(general).toContain(fa.admin.plans.form.freePlan);

    expectPersian(await showSection(dialog, sections.modules), byType('module'));
    expectPersian(await showSection(dialog, sections.channels), byType('channel'));

    const features = await showSection(dialog, sections.features);
    expectPersian(features, byType('feature'));
    for (const group of new Set(byType('feature').map((c) => c.group))) {
      expect(features).toContain(capabilityGroupLabel(group, 'fa'));
    }

    const limits = await showSection(dialog, sections.limits);
    expectPersian(limits, byType('limit'));
    for (const cap of byType('limit')) {
      expect(limits).toContain(capabilityGroupLabel(cap.group, 'fa'));
      if (cap.unit) expect(limits).toContain(capabilityUnitLabel(cap.unit, 'fa'));
    }
    expect(limits).not.toMatch(/\b(per_month|per_day)\b/);

    const pricing = await showSection(dialog, sections.pricing);
    for (const code of ['USD', 'EUR', 'TRY', 'IRR']) expect(pricing).toContain(`${persianName('currency', code)} (${code})`);

    const translations = await showSection(dialog, sections.translations);
    for (const code of ['en', 'fa', 'tr']) expect(translations).toContain(persianName('language', code));
    expect(translations).not.toMatch(/English|Türkçe/);

    const legacy = await showSection(dialog, sections.legacy);
    expect(legacy).toContain(fa.admin.plans.form.legacyHint);
    expect(legacy).toContain('retired_flag');
  });
});
