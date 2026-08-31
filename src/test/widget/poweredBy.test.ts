import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildPoweredByConfig, isPoweredByAllowedForPlan } from '../../../server/services/widget/poweredBy';
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
    expect(PRES_JS).toMatch(/<a class="wy-powered" href="/);
    expect(PRES_JS).toMatch(/: '<span class="wy-powered">'/);
  });

  it('never emits a fake href="#" link', () => {
    expect(PRES_JS).not.toMatch(/href="#"\s*\+?\s*data-powered|data-powered/);
  });
});

// ── Real renderer output ─────────────────────────────────────────
// The presentation module is loaded in a bare VM (no DOM needed for
// rendering) so these assertions run against the ACTUAL markup the widget
// ships, not a regex on the source.
import vm from 'node:vm';

function renderFooter(poweredBy: unknown, showPoweredBy?: boolean): string {
  const sandbox: any = { window: {}, document: undefined, setTimeout, Promise };
  vm.createContext(sandbox);
  vm.runInContext(PRES_JS, sandbox);
  const renderer = sandbox.window.__gs_presentation_web_yar.create({
    escapeHtml: (v: unknown) =>
      String(v == null ? '' : v).replace(/[&<>"']/g, (c) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
      ),
    locale: 'en',
    config: {
      workspaceName: 'Acme',
      platformName: 'Web Yar',
      poweredBy,
      ...(showPoweredBy === undefined ? {} : { showPoweredBy }),
    },
  });
  const html = renderer.homeHtml({ conversations: [] });
  const m = html.match(/<div class="wy-footer">[\s\S]*?<\/div>/);
  return m ? m[0] : '';
}

describe('powered-by link behaviour (rendered markup)', () => {
  it('renders a native anchor with noopener nofollow and a strict-origin referrer', () => {
    const html = renderFooter({ text: 'Powered by', brand: 'Web Yar', url: 'https://webyar.example/' });
    expect(html).toContain('<a class="wy-powered"');
    expect(html).toContain('href="https://webyar.example/"');
    expect(html).toContain('target="_blank"');
    expect(html).toMatch(/rel="[^"]*noopener[^"]*"/);
    expect(html).toMatch(/rel="[^"]*nofollow[^"]*"/);
    expect(html).toContain('referrerpolicy="strict-origin-when-cross-origin"');
    expect(html).not.toContain('noreferrer');
    // Native navigation only — no scripted click / window.open hooks.
    expect(html).not.toContain('data-powered');
    expect(html).not.toContain('onclick');
    expect(html).toContain('Powered by Web Yar');
  });

  it('renders a non-interactive span when no url is configured', () => {
    const html = renderFooter({ text: 'Powered by', brand: 'Web Yar', url: null });
    expect(html).toContain('<span class="wy-powered">');
    expect(html).not.toContain('<a ');
    expect(html).not.toContain('href');
    expect(html).not.toContain('target=');
    expect(html).not.toContain('role="link"');
    expect(html).not.toContain('tabindex');
    expect(html).not.toContain('data-powered');
  });

  it('renders no footer at all when the plan/master switch hides it', () => {
    expect(renderFooter(null, false)).toBe('');
  });

  it('degrades unsafe schemes to a non-clickable span', () => {
    for (const url of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd']) {
      const safe = buildPoweredByConfig(
        { powered_by_enabled: true, powered_by_text: 'Powered by', powered_by_brand_text: 'Web Yar', powered_by_url: url },
        'Web Yar',
        true,
      );
      expect(safe?.url).toBeNull();
      const html = renderFooter(safe);
      expect(html).toContain('<span class="wy-powered">');
      expect(html).not.toContain('href');
    }
  });
});

// ── Plan entitlement resolution ──────────────────────────────────
function fakeSb(entitlements: Record<string, unknown> | null) {
  return {
    from(table: string) {
      const result =
        table === 'workspace_subscriptions'
          ? { data: { plan_id: 'plan_1', status: 'active' } }
          : { data: entitlements === null ? null : { entitlements } };
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => result,
      };
      return chain;
    },
  } as any;
}

describe('isPoweredByAllowedForPlan', () => {
  it('legacy only: remove_powered_by=true hides the footer', async () => {
    expect(await isPoweredByAllowedForPlan(fakeSb({ remove_powered_by: true }), 'ws')).toBe(false);
  });

  it('legacy only: remove_powered_by=false shows the footer', async () => {
    expect(await isPoweredByAllowedForPlan(fakeSb({ remove_powered_by: false }), 'ws')).toBe(true);
  });

  it('canonical false always wins over legacy', async () => {
    expect(await isPoweredByAllowedForPlan(fakeSb({ widget_powered_by: false, remove_powered_by: false }), 'ws')).toBe(false);
    expect(await isPoweredByAllowedForPlan(fakeSb({ widget_powered_by: false, remove_powered_by: true }), 'ws')).toBe(false);
  });

  it('canonical true always wins over legacy', async () => {
    expect(await isPoweredByAllowedForPlan(fakeSb({ widget_powered_by: true, remove_powered_by: true }), 'ws')).toBe(true);
  });

  it('defaults to visible when no plan / no entitlements exist', async () => {
    expect(await isPoweredByAllowedForPlan(fakeSb(null), 'ws')).toBe(true);
    expect(await isPoweredByAllowedForPlan(fakeSb({}), 'ws')).toBe(true);
  });
});
