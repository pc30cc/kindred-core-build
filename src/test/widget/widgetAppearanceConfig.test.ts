// @vitest-environment node
/**
 * GET /config's appearance texts and colour follow one rule with the panel
 * (W-07, W-10, W-13):
 *
 *   - the welcome: the workspace's own, else the Super Admin's platform
 *     default in every language (it used to apply only to English widgets),
 *     else the built-in one in the widget's language; an English seed left in
 *     a row is no welcome of the owner's (shared/widgetTextDefaults.ts);
 *   - the colour: the widget's own #RRGGBB, else the workspace branding's,
 *     else the seeded #3B82F6 that every widget file reads as "the brand's"
 *     (shared/widgetColor.ts), so a stored seed or a value that is no colour
 *     never reaches the widget as one;
 *   - the launcher image is served only while the plan includes the launcher
 *     style (widget_launcher_icon), like the icon.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import { createFakeDb, allowAllRpc, widgetScenarioTables, WS, type FakeDb } from './widgetConfigFakeDb';

const holder = vi.hoisted(() => ({ db: null as unknown as FakeDb, deny: new Set<string>() }));
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: (t: string) => holder.db.client.from(t),
    rpc: (f: string, a?: Record<string, unknown>) => holder.db.client.rpc(f, a),
  }),
}));

process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key-appearance';
const config = { supabaseUrl: 'https://x.supabase.co', supabaseServiceRoleKey: 'SERVICE_KEY' } as never;
const snapshotMod = await import('../../../server/services/widget/configSnapshot.js');
const req = { query: {}, headers: {}, protocol: 'https', get: () => 'api.test', socket: { remoteAddress: '127.0.0.1' } } as unknown as Request;
type Row = Record<string, unknown>;

/** Entitlements: everything, but the features named in `holder.deny`. */
function rpc(fn: string, args: Record<string, unknown> | undefined) {
  if (fn === 'check_workspace_entitlement' && holder.deny.has(String(args?._feature || ''))) {
    return { data: { allowed: false, plan: 'free' }, error: null };
  }
  return allowAllRpc(fn, args);
}

async function body(edition: 'iran' | 'international', widget: Row, extra: { branding?: Row; platform?: Row } = {}) {
  const tables = widgetScenarioTables({ edition, ai: false, smart: false }) as Record<string, Row[]>;
  Object.assign(tables.widget_settings[0], widget);
  if (extra.branding) Object.assign(tables.workspace_branding[0], extra.branding);
  if (extra.platform) Object.assign(tables.widget_platform_settings[0], extra.platform);
  holder.db = createFakeDb(tables, { rpc });
  snapshotMod.__resetWidgetConfigCachesForTests();
  (await import('../../../server/middleware/featureGating.js')).clearEntitlementCache();
  (await import('../../../server/services/platformRegion.js')).invalidatePlatformRegionCache();
  (await import('../../../server/services/ai-agent/platformSettings.js')).__resetPlatformAiAgentSettingsCache();
  const out = await snapshotMod.resolveWidgetConfigBody(config, req, WS, { edition, quotaFull: null });
  expect(out.status).toBe(200);
  return out.body as Row & { fab: Row };
}

beforeEach(() => { holder.deny = new Set(); });

describe('the welcome visitors read', () => {
  it('the workspace\'s own text, in any language', async () => {
    expect((await body('iran', { welcome_message: 'خوش آمدید به فروشگاه' })).welcomeMessage).toBe('خوش آمدید به فروشگاه');
  });

  it('none of its own (empty, null, the English seed): the Super Admin\'s default, in a Persian widget too', async () => {
    for (const own of [null, '', '  ', 'Hello! How can we help you?']) {
      const b = await body('iran', { welcome_message: own }, { platform: { default_welcome_message: 'به فروشگاه ما خوش آمدید' } });
      expect(b.welcomeMessage, String(own)).toBe('به فروشگاه ما خوش آمدید');
    }
  });

  it('neither: the built-in one in the widget\'s language (the platform\'s seeded default is no text of its own)', async () => {
    const fa = await body('iran', { welcome_message: null }, { platform: { default_welcome_message: 'Hello! How can we help you?' } });
    expect(fa.welcomeMessage).toBe('سلام! چطور می‌توانیم کمکتان کنیم؟');
    const tr = await body('international', { welcome_message: null, locale: 'tr', widget_language: 'tr' }, { platform: { default_welcome_message: '' } });
    expect(tr.welcomeMessage).toBe('Merhaba! Size nasıl yardımcı olabiliriz?');
  });
});

describe('the colour on the wire', () => {
  it('the widget\'s own colour, upper-case', async () => {
    expect((await body('iran', { primary_color: '#0ea5e9' })).primaryColor).toBe('#0EA5E9');
  });

  it('none of its own: the workspace branding\'s colour, else the seeded #3B82F6 (the brand\'s, for the widget)', async () => {
    expect((await body('iran', { primary_color: null }, { branding: { primary_color: '#445566' } })).primaryColor).toBe('#445566');
    expect((await body('iran', { primary_color: null }, { branding: { primary_color: '#3B82F6' } })).primaryColor).toBe('#3B82F6');
    expect((await body('iran', { primary_color: null }, { branding: { primary_color: null } })).primaryColor).toBe('#3B82F6');
  });

  it('a stored value that is no colour is never sent as one', async () => {
    for (const bad of ['red', '#12', 'red;background:url(x)']) {
      expect((await body('iran', { primary_color: bad }, { branding: { primary_color: null } })).primaryColor, bad).toBe('#3B82F6');
    }
  });
});

describe('the launcher image follows the launcher style\'s capability', () => {
  it('served with widget_launcher_icon, not without it', async () => {
    const allowed = await body('iran', {});
    expect(allowed.fab.imageUrl).toBeTruthy();
    holder.deny = new Set(['widget_launcher_icon']);
    const denied = await body('iran', {});
    expect(denied.fab.imageUrl ?? null).toBeNull();
    expect(denied.fab.icon).toBe('chat');
  });
});
