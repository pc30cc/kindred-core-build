import { describe, expect, it } from 'vitest';
import {
  CAPABILITY_REGISTRY,
  validatePlanPayload,
} from '../../../server/services/billing/capabilityRegistry';
import {
  __capabilityI18nFa as fa,
  capabilityDescription,
  capabilityGroupLabel,
  capabilityLabel,
  capabilityUnitLabel,
  planIssueMessage,
} from '@/lib/capability-i18n';

/** A Persian string still carrying an English sentence (identifiers aside). */
const hasPersian = (text: string) => /[؀-ۿ]/.test(text);

describe('Super Admin plan editor — capability registry in Persian', () => {
  it('translates every registry label', () => {
    const missing = CAPABILITY_REGISTRY.filter((c) => !fa.capabilities[c.key]?.label).map((c) => c.key);
    expect(missing).toEqual([]);
    for (const cap of CAPABILITY_REGISTRY) expect(hasPersian(capabilityLabel(cap, 'fa'))).toBe(true);
  });

  it('translates every registry description', () => {
    const missing = CAPABILITY_REGISTRY.filter((c) => c.description && !fa.capabilities[c.key]?.description).map(
      (c) => c.key,
    );
    expect(missing).toEqual([]);
    for (const cap of CAPABILITY_REGISTRY.filter((c) => c.description)) {
      expect(hasPersian(capabilityDescription(cap, 'fa')!)).toBe(true);
    }
  });

  it('carries no translation for a key the registry no longer has', () => {
    const known = new Set(CAPABILITY_REGISTRY.map((c) => c.key));
    expect(Object.keys(fa.capabilities).filter((k) => !known.has(k))).toEqual([]);
  });

  it('translates every group heading and unit badge', () => {
    const groups = [...new Set(CAPABILITY_REGISTRY.map((c) => c.group))];
    expect(groups.filter((g) => !fa.groups[g])).toEqual([]);
    const units = [...new Set(CAPABILITY_REGISTRY.map((c) => c.unit).filter(Boolean) as string[])];
    expect(units.filter((u) => !fa.units[u])).toEqual([]);
    expect(capabilityGroupLabel('widget', 'fa')).toBe('ویجت');
    expect(capabilityUnitLabel('per_month', 'fa')).toBe('در ماه');
  });

  it('translates every validation message the server can return', () => {
    const { issues } = validatePlanPayload({
      entitlements: { not_a_key: 'yes', max_agents: true, chat: 'on' },
      limits: { not_a_limit: 'x', chat: 1, max_agents: 'many' },
    });
    const kinds = new Set(issues.map((i) => i.message.replace(/'[^']*'/g, "''")));
    expect(kinds.size).toBe(fa.issuePatterns.length);
    for (const issue of issues) {
      const text = planIssueMessage(issue.message, 'fa');
      expect(text).not.toBe(issue.message);
      expect(hasPersian(text)).toBe(true);
      expect(text).toContain(issue.key);
    }
  });

  it('leaves other locales on the registry English', () => {
    const cap = CAPABILITY_REGISTRY.find((c) => c.key === 'widget_voice_notes')!;
    expect(capabilityLabel(cap, 'en')).toBe(cap.label);
    expect(capabilityDescription(cap, 'en')).toBe(cap.description);
    expect(capabilityGroupLabel('widget', 'en')).toBe('widget');
    expect(planIssueMessage("Entitlement 'x' must be boolean", 'en')).toBe("Entitlement 'x' must be boolean");
  });
});
