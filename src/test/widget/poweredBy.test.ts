import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildPoweredByConfig } from '../../../server/services/widget/poweredBy';
import { CAPABILITY_REGISTRY } from '../../../server/services/billing/capabilityRegistry';

const PRES_JS = readFileSync(
  resolve(__dirname, '../../../public/widget/presentation-web-yar.js'),
  'utf8',
);

describe('powered-by capability keys', () => {
  const canonical = CAPABILITY_REGISTRY.find((c) => c.key === 'widget_powered_by');
  const legacy = CAPABILITY_REGISTRY.find((c) => c.key === 'remove_powered_by') as any;

  it('widget_powered_by is the single plan-configurable toggle', () => {
    expect(canonical).toBeDefined();
    expect(canonical!.planConfigurable).toBe(true);
    expect(canonical!.userVisible).toBe(true);
    expect(canonical!.defaultValue).toBe(true);
  });

  it('remove_powered_by is deprecated and never offered in plan UI', () => {
    expect(legacy).toBeDefined();
    expect(legacy.deprecated).toBe(true);
    expect(legacy.planConfigurable).toBe(false);
    expect(legacy.workspaceOverridable).toBe(false);
    expect(legacy.userVisible).toBe(false);
  });
});

describe('buildPoweredByConfig', () => {
  const platform = {
    powered_by_enabled: true,
    powered_by_text: 'Powered by',
    powered_by_brand_text: 'Destekly',
    powered_by_url: 'https://destekly.com',
  };

  it('renders platform-owned wording, brand and url', () => {
    expect(buildPoweredByConfig(platform, 'Fallback', true)).toEqual({
      text: 'Powered by',
      brand: 'Destekly',
      url: 'https://destekly.com',
    });
  });

  it('falls back to the platform brand name when no brand label is set', () => {
    const cfg = buildPoweredByConfig({ ...platform, powered_by_brand_text: '' }, 'Fallback', true);
    expect(cfg?.brand).toBe('Fallback');
  });

  it('hides the footer when the plan disallows it', () => {
    expect(buildPoweredByConfig(platform, 'Fallback', false)).toBeNull();
  });

  it('hides the footer when the platform master switch is off', () => {
    expect(buildPoweredByConfig({ ...platform, powered_by_enabled: false }, 'F', true)).toBeNull();
  });

  it('drops non-http urls so the footer stays non-clickable', () => {
    expect(buildPoweredByConfig({ ...platform, powered_by_url: 'javascript:alert(1)' }, 'F', true)?.url).toBeNull();
    expect(buildPoweredByConfig({ ...platform, powered_by_url: '' }, 'F', true)?.url).toBeNull();
  });
});

describe('presentation footer markup', () => {
  it('uses an anchor only when a url exists and a plain span otherwise', () => {
    expect(PRES_JS).toMatch(/\? '<a class="wy-powered" href="/);
    expect(PRES_JS).toMatch(/: '<span class="wy-powered">'/);
  });

  it('never emits a fake href="#" link', () => {
    expect(PRES_JS).not.toMatch(/href="#"\s*\+?\s*data-powered|data-powered/);
  });
});
