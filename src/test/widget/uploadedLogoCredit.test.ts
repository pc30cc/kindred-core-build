/**
 * The widgets' "powered by" credit follows the logo the Super Admin uploaded
 * (Super Admin → Branding; server/services/platformBrandAssets.ts), in both
 * editions:
 *
 *   - the chat widget (GET /config, configSnapshot.ts): `poweredBy.logo` is
 *     the upload's light file, absolute on the storage provider, in every
 *     template and logo direction; without an upload it is the kit's exactly
 *     as before; an edition that cannot be read keeps the words;
 *   - the call widget (runtime.js + presentation-default-panel.js): a
 *     bootstrap that says the logo is the upload (`powered_by_logo_custom`,
 *     `powered_by.custom`) is drawn as an image, over the kit's own art,
 *     which stays the default.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Request } from 'express';
import { createFakeDb, allowAllRpc, widgetScenarioTables, WS, type FakeDb } from './widgetConfigFakeDb';
import { mountCallWidget } from '../callWidget/mountCallWidget';

const holder = vi.hoisted(() => ({ db: null as unknown as FakeDb }));
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: (t: string) => holder.db.client.from(t),
    rpc: (f: string, a?: Record<string, unknown>) => holder.db.client.rpc(f, a),
  }),
}));

process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key-uploaded-logo';
const config = { supabaseUrl: 'https://x.supabase.co', supabaseServiceRoleKey: 'SERVICE_KEY', corsOrigins: ['*'] } as never;
const snapshotMod = await import('../../../server/services/widget/configSnapshot.js');
const publicConfig = await import('../../../server/services/platformPublicConfig.js');

const req = { query: {}, headers: {}, protocol: 'https', get: () => 'api.test', socket: { remoteAddress: '127.0.0.1' } } as unknown as Request;
type Tables = ReturnType<typeof widgetScenarioTables>;
type Body = Record<string, unknown> & { poweredBy?: { logo?: string } | null };

const UPLOADED_KEY = 'platform/brand/0b7d6c00-0000-4000-8000-000000000001-logo-light.svg';
const UPLOADED_URL = `https://cdn.test/${UPLOADED_KEY}`;

const uploaded = (t: Tables) => {
  (t as Record<string, unknown[]>).platform_branding = [{ id: 'b1', logo_light_storage_key: UPLOADED_KEY }];
};

async function body(edit?: (t: Tables) => void, edition: 'iran' | 'international' = 'iran'): Promise<Body> {
  const tables = widgetScenarioTables({ edition, ai: false, smart: false });
  edit?.(tables);
  holder.db = createFakeDb(tables, { rpc: allowAllRpc });
  snapshotMod.__resetWidgetConfigCachesForTests();
  publicConfig.__resetPlatformPublicConfigForTests();
  (await import('../../../server/middleware/featureGating.js')).clearEntitlementCache();
  (await import('../../../server/services/platformRegion.js')).invalidatePlatformRegionCache();
  (await import('../../../server/services/ai-agent/platformSettings.js')).__resetPlatformAiAgentSettingsCache();
  const out = await snapshotMod.resolveWidgetConfigBody(config, req, WS, { edition, quotaFull: null });
  expect(out.status).toBe(200);
  return out.body as Body;
}
const logo = (b: Body) => String(b.poweredBy?.logo);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-30T10:00:00Z') });
});
afterEach(() => { vi.useRealTimers(); });

describe('GET /config: the chat widget\'s credit', () => {
  it('Iran: the uploaded logo over WebYar\'s logotype; without one, the logotype as before', async () => {
    expect(logo(await body())).toBe('https://app.test/brand/webyar/webyar-logo-fa-color.svg');
    expect(logo(await body(uploaded))).toBe(UPLOADED_URL);
  });

  it('International: the uploaded logo in every template and logo direction', async () => {
    const wearing = (id: string, options: Record<string, unknown>) => (t: Tables) => {
      uploaded(t);
      (t as Record<string, unknown[]>).widget_edition_settings = [{
        edition: 'international',
        chat_templates: { default: 'intl', items: { 't1-intl': { enabled: true }, 't2-intl': { enabled: true } } },
      }];
      Object.assign(t.widget_settings[0], { widget_template_id: id, widget_template_options: options });
    };
    expect(logo(await body(undefined, 'international'))).toBe('https://app.test/brand/intl/respok-thread-horizontal-color.svg');
    expect(logo(await body(uploaded, 'international'))).toBe(UPLOADED_URL);
    expect(logo(await body(wearing('t1-intl', { logoDirection: 'open' }), 'international'))).toBe(UPLOADED_URL);
    expect(logo(await body(wearing('t2-intl', {}), 'international'))).toBe(UPLOADED_URL);
  });

  it('no credit, no logo: a plan or the platform switch that hides it still hides it', async () => {
    const b = await body((t) => {
      uploaded(t);
      Object.assign(t.widget_platform_settings[0], { powered_by_enabled: false });
    });
    expect(b.poweredBy ?? null).toBeNull();
  });
});

describe('the call widget\'s panel credit', () => {
  function credit(extra: Record<string, unknown>, edition: 'iran' | 'international', locale: 'fa' | 'en' = 'en') {
    const m = mountCallWidget({ locale, edition, bootstrap: extra });
    m.open();
    return m.q('[data-screen="home"] .ccw-powered') as HTMLElement;
  }

  it('Iran: the upload is an image in the brand\'s place; the kit\'s mark stays the default', () => {
    const kit = credit({ powered_by_logo: '/brand/webyar/webyar-logo-fa-color.svg' }, 'iran');
    expect(kit.querySelector('svg.wm')).not.toBeNull();
    expect(kit.querySelector('img')).toBeNull();
    const own = credit({ powered_by_logo: UPLOADED_URL, powered_by_logo_custom: true }, 'iran');
    expect(own.querySelector('svg')).toBeNull();
    const img = own.querySelector('img.ccw-powered-logo') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe(UPLOADED_URL);
    expect(img.getAttribute('alt')).toBe('Web Yar');
    // The words and the image are flex items (the gap spaces them).
    expect(own.querySelector('.ccw-powered-label')!.textContent).toBe('Powered by');
  });

  it('International: the upload is an image over RESPOK\'s lockups', () => {
    const poweredBy = { brand: 'RESPOK', brands: {}, url: null, logo: '/brand/intl/respok-thread-horizontal-color.svg' };
    const kit = credit({ powered_by: poweredBy, platform_brand: { names: { en: 'RESPOK' } } }, 'international');
    expect(kit.querySelectorAll('svg.lk')).toHaveLength(2);
    const own = credit({ powered_by: { ...poweredBy, logo: UPLOADED_URL, custom: true }, platform_brand: { names: { en: 'RESPOK' } } }, 'international');
    expect(own.querySelector('svg')).toBeNull();
    expect((own.querySelector('img.ccw-powered-logo') as HTMLImageElement).getAttribute('src')).toBe(UPLOADED_URL);
  });

  it('a broken upload falls back to the platform\'s name', () => {
    const own = credit({ powered_by_logo: UPLOADED_URL, powered_by_logo_custom: true }, 'iran');
    own.querySelector('img')!.dispatchEvent(new Event('error'));
    expect(own.querySelector('img')).toBeNull();
    expect([...own.childNodes].map((n) => n.textContent)).toEqual(['Powered by', 'Web Yar']);
  });
});
