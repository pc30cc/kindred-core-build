/**
 * Colleague calls are a plan feature (docs/operations/TEAM_CALLS.md, "Plan"):
 * the registry key `team_calls` as the doc defines it, named in the Super
 * Admin's plan editor and on the customer's plan card in every language, and
 * carried by the hidden App Review plan (migration 293), which reseeds keep.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { render, screen } from '@testing-library/react';
import en from '@/i18n/locales/en';
import fa from '@/i18n/locales/fa';
import tr from '@/i18n/locales/tr';
import { capabilityDescription, capabilityLabel } from '@/lib/capability-i18n';
import { getCapability } from '../../../server/services/billing/capabilityRegistry';

vi.mock('@/i18n', () => ({
  useTranslation: () => ({ locale: 'en', dir: 'ltr', t: (k: string) => k }),
}));
vi.mock('@/hooks/useEdition', () => ({ useEdition: () => ({ features: { bale: true } }) }));

const PlanFeatures = (await import('@/pages/app/billing/account/PlanFeatures')).default;

describe('team_calls', () => {
  it('is a plan-only call feature, off unless a plan turns it on', () => {
    expect(getCapability('team_calls')).toMatchObject({
      type: 'feature',
      group: 'calls',
      defaultValue: false,
      planConfigurable: true,
      workspaceOverridable: false,
      userVisible: true,
    });
  });

  it('is named and described in English, Persian and Turkish', () => {
    expect(capabilityLabel('team_calls', 'en')).toBe('Colleague Calls');
    expect(capabilityLabel('team_calls', 'fa')).toBe('تماس با همکاران');
    expect(capabilityLabel('team_calls', 'tr')).toBe('İş Arkadaşı Aramaları');
    expect(capabilityDescription('team_calls', 'fa')).toMatch(/[؀-ۿ]/);
    expect(capabilityDescription('team_calls', 'tr')).toBeTruthy();
  });

  it('is a line of the plan card when the plan has it, in every language', () => {
    render(<PlanFeatures limits={{}} entitlements={{ team_calls: true }} />);
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toContain('billing.plans.feat.team_calls');
    for (const locale of [en, fa, tr]) {
      expect((locale as { billing: { plans: { feat: Record<string, string> } } }).billing.plans.feat.team_calls).toBeTruthy();
    }
    expect(fa.billing.plans.feat.team_calls).toMatch(/[؀-ۿ]/);
  });

  it('is on in the App Review plan, now and after a reseed (293)', () => {
    const sql = readFileSync('database/migrations/293_team_calls.sql', 'utf8');
    const seed = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION public.app_review_seed_plan()'), sql.indexOf('$$;'));
    expect(seed).toContain("'team_calls'");
    // The rest of the function is 272's, unchanged.
    const before = readFileSync('database/migrations/272_plan_storage_gb_removed.sql', 'utf8');
    const previous = before.slice(before.indexOf('CREATE OR REPLACE FUNCTION public.app_review_seed_plan()'));
    expect(seed.replace(", 'team_calls'", '')).toBe(previous.slice(0, previous.indexOf('$$;')));
    expect(sql).toMatch(/UPDATE public\.billing_plans\s+SET entitlements = entitlements \|\| '\{"team_calls": true\}'::jsonb/);
    expect(sql).toMatch(/WHERE slug = 'app-review'/);
  });
});
