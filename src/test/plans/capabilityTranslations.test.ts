/**
 * Every plan capability has a name — and, where the registry describes it, a
 * description — in every language the Super Admin plan editor and the
 * customer panels are shown in. A capability added to the registry without
 * translations fails here, not in front of a Persian or Turkish admin.
 */
import { describe, it, expect } from 'vitest';
import { CAPABILITY_REGISTRY } from '../../../server/services/billing/capabilityRegistry';
import {
  TRANSLATED_CAPABILITY_KEYS,
  capabilityLabel,
  capabilityDescription,
  capabilityGroupLabel,
  capabilityUnitLabel,
  __capabilityTranslations as T,
} from '@/lib/capability-i18n';

describe('capability translations', () => {
  it('cover exactly the registry', () => {
    expect([...TRANSLATED_CAPABILITY_KEYS].sort()).toEqual(CAPABILITY_REGISTRY.map((c) => c.key).sort());
    expect(Object.keys(T.FA).sort()).toEqual(Object.keys(T.EN_LABELS).sort());
    expect(Object.keys(T.TR).sort()).toEqual(Object.keys(T.EN_LABELS).sort());
  });

  it('keep the English names identical to the registry', () => {
    for (const cap of CAPABILITY_REGISTRY) {
      expect(capabilityLabel(cap.key, 'en'), cap.key).toBe(cap.label);
    }
  });

  it('describe in Persian and Turkish everything the registry describes', () => {
    for (const cap of CAPABILITY_REGISTRY) {
      if (!cap.description) continue;
      expect(T.FA[cap.key].description, `fa ${cap.key}`).toBeTruthy();
      expect(T.TR[cap.key].description, `tr ${cap.key}`).toBeTruthy();
    }
  });

  it('never leave a Persian name in English', () => {
    // Brand and protocol names stay as they are written.
    const latinOk = /^(SMS|API|SSO|SAML|CSV|IP|UTC|CDN|GSC|Core Web Vitals|Lighthouse|WhatsApp|Instagram|Gmail|Yahoo|Powered by|White-label|ChatGPT|MB|GB)$/;
    for (const key of TRANSLATED_CAPABILITY_KEYS) {
      const fa = capabilityLabel(key, 'fa');
      expect(/[؀-ۿ]/.test(fa) || latinOk.test(fa), `fa ${key}: ${fa}`).toBe(true);
      expect(capabilityLabel(key, 'tr'), `tr ${key}`).toBeTruthy();
    }
  });

  it('translates every group and unit the registry uses', () => {
    const groups = new Set(CAPABILITY_REGISTRY.map((c) => c.group));
    const units = new Set(CAPABILITY_REGISTRY.map((c) => c.unit).filter((u): u is NonNullable<typeof u> => !!u));
    for (const group of groups) {
      for (const lang of ['en', 'fa', 'tr'] as const) {
        expect(T.GROUPS[lang][group], `${lang} group ${group}`).toBeTruthy();
      }
      expect(capabilityGroupLabel(group, 'fa')).not.toBe(group);
    }
    for (const unit of units) {
      for (const lang of ['en', 'fa', 'tr'] as const) {
        expect(T.UNITS[lang][unit], `${lang} unit ${unit}`).toBeTruthy();
      }
    }
    expect(capabilityUnitLabel('per_month', 'fa')).toBe('در ماه');
  });

  it('falls back to the registry text for English and unknown keys', () => {
    expect(capabilityDescription('widget_emoji', 'en', 'from registry')).toBe('from registry');
    expect(capabilityDescription('widget_emoji', 'fa', 'from registry')).toContain('ایموجی');
    expect(capabilityLabel('not_a_key', 'fa', 'Fallback')).toBe('Fallback');
    expect(capabilityLabel('not_a_key', 'fa')).toBe('not_a_key');
  });
});
