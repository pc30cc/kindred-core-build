/**
 * The AI section's Advanced tools are a plan feature (owner, 2026-11-03;
 * docs/operations/AI_ADVANCED_TOOLS.md): the registry key
 * `ai_advanced_tools`, off by default so off on every plan without a
 * migration, named in the plan editor and on the customer's plan card in
 * every language; the menu line no longer says "Super Admin only"; and the
 * Super Admin's AI Control Center offers no switch that does nothing.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { render, screen } from '@testing-library/react';
import en from '@/i18n/locales/en';
import fa from '@/i18n/locales/fa';
import tr from '@/i18n/locales/tr';
import { capabilityDescription, capabilityLabel } from '@/lib/capability-i18n';
import { getCapability } from '../../../server/services/billing/capabilityRegistry';
import { resolveEffectiveEntitlements } from '../../../server/services/billing/effectiveEntitlements';
import { AI_ADVANCED_TOOLS_KEY } from '../../../shared/aiAdvancedTools';

vi.mock('@/i18n', () => ({
  useTranslation: () => ({ locale: 'en', dir: 'ltr', t: (k: string) => k }),
}));
vi.mock('@/hooks/useEdition', () => ({ useEdition: () => ({ features: { bale: true } }) }));

const PlanFeatures = (await import('@/pages/app/billing/account/PlanFeatures')).default;

type Locale = typeof en;
const locales: Array<[string, Locale]> = [['en', en], ['fa', fa as unknown as Locale], ['tr', tr as unknown as Locale]];

describe('ai_advanced_tools', () => {
  it('is the key the rule reads', () => {
    expect(AI_ADVANCED_TOOLS_KEY).toBe('ai_advanced_tools');
  });

  it('is a plan-only AI feature, off unless a plan turns it on', () => {
    expect(getCapability('ai_advanced_tools')).toMatchObject({
      type: 'feature',
      group: 'ai',
      label: 'AI Advanced Tools',
      defaultValue: false,
      planConfigurable: true,
      workspaceOverridable: false,
      userVisible: true,
    });
    expect(getCapability('ai_advanced_tools')?.description).toMatch(/regression/i);
  });

  it('is off for a plan that does not carry it (every plan today), on only when a plan says so', () => {
    const without = resolveEffectiveEntitlements({ entitlements: { ai_assistant: true }, planLimits: {}, limitOverrides: null } as never, [], []);
    expect(without.features.ai_advanced_tools).toEqual({ value: false, source: 'default' });
    const withKey = resolveEffectiveEntitlements({ entitlements: { ai_advanced_tools: true }, planLimits: {}, limitOverrides: null } as never, [], []);
    expect(withKey.features.ai_advanced_tools).toEqual({ value: true, source: 'plan' });
  });

  it('needs no migration: no migration names it', () => {
    for (const file of readdirSync('database/migrations')) {
      expect(readFileSync(`database/migrations/${file}`, 'utf8'), file).not.toContain('ai_advanced_tools');
    }
  });

  it('is not among the App Review seed\'s fixed keys (it follows the "any plan carries it" rule)', () => {
    const sql = readFileSync('database/migrations/293_team_calls.sql', 'utf8');
    const seed = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION public.app_review_seed_plan()'), sql.indexOf('$$;'));
    expect(seed).toContain('jsonb_object_keys(entitlements)');
    expect(seed).not.toContain('ai_advanced_tools');
  });

  it('is named and described in English, Persian and Turkish', () => {
    expect(capabilityLabel('ai_advanced_tools', 'en')).toBe('AI Advanced Tools');
    expect(capabilityLabel('ai_advanced_tools', 'fa')).toBe('ابزارهای پیشرفتهٔ هوش مصنوعی');
    expect(capabilityLabel('ai_advanced_tools', 'tr')).toBe('Yapay Zekâ Gelişmiş Araçları');
    expect(capabilityDescription('ai_advanced_tools', 'fa')).toMatch(/[؀-ۿ]/);
    expect(capabilityDescription('ai_advanced_tools', 'tr')).toBeTruthy();
  });

  it('is a line of the plan card when the plan has it, in every language', () => {
    render(<PlanFeatures limits={{}} entitlements={{ ai_advanced_tools: true }} />);
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toContain('billing.plans.feat.ai_advanced_tools');
    for (const [code, locale] of locales) {
      expect(locale.billing.plans.feat.ai_advanced_tools, code).toBeTruthy();
    }
    expect(fa.billing.plans.feat.ai_advanced_tools).toMatch(/[؀-ۿ]/);
  });

  it('is not on the card when the plan does not have it', () => {
    document.body.innerHTML = '';
    render(<PlanFeatures limits={{}} entitlements={{ ai_advanced_tools: false, ai_assistant: true }} />);
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).not.toContain('billing.plans.feat.ai_advanced_tools');
  });
});

describe('the Advanced tools menu line', () => {
  it('keeps its name and no longer says Super Admin only', () => {
    expect(en.aiAgent.menu.advanced).toBe('Advanced tools');
    expect(fa.aiAgent.menu.advanced).toBe('ابزارهای پیشرفته');
    expect(tr.aiAgent.menu.advanced).toBe('Gelişmiş araçlar');
    expect(en.aiAgent.menu.advancedDesc).toBe('Testing and troubleshooting the assistant');
    expect(fa.aiAgent.menu.advancedDesc).toBe('آزمون و عیب‌یابی دستیار');
    expect(tr.aiAgent.menu.advancedDesc).toBe('Asistanı test etme ve sorun giderme');
    for (const [, locale] of locales) expect(locale.aiAgent.menu.advancedDesc).not.toMatch(/Super Admin|سوپر ادمین|Süper Yönetici/);
  });
});

describe('the Super Admin AI Control Center', () => {
  const page = readFileSync('src/pages/admin/AiAgentControlPage.tsx', 'utf8');

  it('offers none of the old advanced switches, which no longer decide anything', () => {
    for (const key of ['advanced_tools_enabled', 'regression_runner_enabled', 'source_health_visible_to_customers', 'test_harness_visible_to_customers']) {
      expect(page).not.toContain(`set('${key}'`);
    }
  });

  it('says the Advanced tools are turned on per plan and links to Super Admin → Plans', () => {
    expect(page).toContain("t('admin.aiAgentControl.advanced.planNote')");
    expect(page).toContain('to="/admin/plans"');
    for (const [code, locale] of locales) {
      const card = locale.admin.aiAgentControl.advanced as Record<string, string>;
      expect(card.title, code).toBeTruthy();
      expect(card.planNote, code).toBeTruthy();
      expect(card.openPlans, code).toBeTruthy();
      expect(card.enabled, code).toBeUndefined();
    }
    expect(en.admin.aiAgentControl.advanced.planNote).toContain('Super Admin → Plans');
    expect(fa.admin.aiAgentControl.advanced.planNote).toContain('پلن');
    expect(tr.admin.aiAgentControl.advanced.planNote).toContain('Planlar');
  });
});
