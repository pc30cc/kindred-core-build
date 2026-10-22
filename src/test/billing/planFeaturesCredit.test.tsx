/**
 * The plan card (src/pages/app/billing/account/PlanFeatures.tsx) and the
 * plan editor's capability list never offer what nothing grants, and say
 * what a plan really changes about the "Powered by" credit:
 *
 *   - the reserved keys nothing reads (advanced_ai_agent, custom_branding,
 *     white_label, sso, api_access) and the legacy remove_powered_by are not
 *     ticked on a card, whatever the plan stores; the registry no longer
 *     offers them as plan toggles or workspace overrides;
 *   - a plan without the credit (widget_powered_by: false, or the legacy
 *     remove_powered_by while widget_powered_by is unnamed) says so, by the
 *     same rule the widget follows (isPoweredByAllowedForPlan);
 *   - a plan letting the owner hide the credit says that, unless it shows
 *     no credit at all;
 *   - both lines are translated in every language.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import en from '@/i18n/locales/en';
import fa from '@/i18n/locales/fa';
import tr from '@/i18n/locales/tr';
import { CAPABILITY_REGISTRY } from '../../../server/services/billing/capabilityRegistry';
import { isPoweredByAllowedForPlan } from '../../../server/services/widget/poweredBy';

vi.mock('@/i18n', () => ({
  useTranslation: () => ({ locale: 'en', dir: 'ltr', t: (k: string) => k }),
}));
vi.mock('@/hooks/useEdition', () => ({ useEdition: () => ({ features: { bale: true } }) }));

const PlanFeatures = (await import('@/pages/app/billing/account/PlanFeatures')).default;

const RESERVED = ['advanced_ai_agent', 'custom_branding', 'white_label', 'sso', 'api_access'];

function card(entitlements: Record<string, unknown>) {
  render(<PlanFeatures limits={{}} entitlements={entitlements} />);
  return screen.queryAllByRole('listitem').map((li) => li.textContent);
}

/** What the widget does with the same plan (a plan read through a fake client). */
async function widgetShowsCredit(entitlements: Record<string, unknown>) {
  const sb = {
    from: (table: string) => {
      const q = {
        select: () => q,
        eq: () => q,
        maybeSingle: async () => (table === 'workspace_subscriptions'
          ? { data: null, error: null }
          : { data: { entitlements }, error: null }),
      };
      return q;
    },
  };
  return isPoweredByAllowedForPlan(sb as never, 'ws');
}

describe('the plan card lists only what is enforced', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('never ticks a reserved key or the legacy inverse', () => {
    const items = card(Object.fromEntries([...RESERVED, 'remove_powered_by'].map((k) => [k, true]).concat([['widget_powered_by', true]])));
    expect(items).toEqual([]);
  });

  it('a plan without the credit says so, as the widget hides it', async () => {
    const ent = { widget_powered_by: false, widget_powered_by_toggle: true };
    expect(card(ent)).toEqual(['billing.plans.feat.no_powered_by']);
    expect(await widgetShowsCredit(ent)).toBe(false);
  });

  it('the legacy remove_powered_by counts only while widget_powered_by is not named', async () => {
    const legacy = { remove_powered_by: true };
    expect(card(legacy)).toEqual(['billing.plans.feat.no_powered_by']);
    expect(await widgetShowsCredit(legacy)).toBe(false);

    document.body.innerHTML = '';
    const named = { remove_powered_by: true, widget_powered_by: true };
    expect(card(named)).toEqual([]);
    expect(await widgetShowsCredit(named)).toBe(true);
  });

  it('a plan letting the owner hide the credit says that', async () => {
    const ent = { widget_powered_by_toggle: true };
    expect(card(ent)).toEqual(['billing.plans.feat.widget_powered_by_toggle']);
    expect(await widgetShowsCredit(ent)).toBe(true);
  });

  it('both credit lines are translated in every language', () => {
    for (const [name, cat] of [['en', en], ['fa', fa], ['tr', tr]] as const) {
      const feat = (cat as unknown as { billing: { plans: { feat: Record<string, unknown> } } }).billing.plans.feat;
      for (const key of ['no_powered_by', 'widget_powered_by_toggle']) {
        expect(typeof feat[key], `${name} billing.plans.feat.${key}`).toBe('string');
      }
      for (const key of [...RESERVED, 'remove_powered_by']) expect(feat[key], `${name} still labels ${key}`).toBeUndefined();
    }
    expect(fa.billing.plans.feat.no_powered_by).not.toBe(en.billing.plans.feat.no_powered_by);
    expect(tr.billing.plans.feat.no_powered_by).not.toBe(en.billing.plans.feat.no_powered_by);
  });
});

describe('the plan editor never offers a reserved key', () => {
  // The rule PlansPage's editor and its workspace override console apply.
  const editable = CAPABILITY_REGISTRY.filter((c) => !c.deprecated && c.planConfigurable !== false).map((c) => c.key);

  it.each(RESERVED)('%s is kept in the registry but neither a plan toggle, an override nor shown to customers', (key) => {
    const cap = CAPABILITY_REGISTRY.find((c) => c.key === key);
    expect(cap).toBeDefined();
    expect(editable).not.toContain(key);
    expect(cap!.workspaceOverridable).toBe(false);
    expect(cap!.userVisible).toBe(false);
  });

  it('the credit capabilities stay offered', () => {
    expect(editable).toEqual(expect.arrayContaining(['widget_powered_by', 'widget_powered_by_toggle']));
  });
});
