/**
 * V-34: the widget language "auto" follows the visitor's browser
 * (Accept-Language, by its q-values) among the platform's languages, else the
 * workspace's language; a chosen language stays chosen, and a one-language
 * platform speaks only that one. Every server-side text of the /config body
 * (the availability labels here) follows the same language.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Request } from 'express';
import { createFakeDb, allowAllRpc, widgetScenarioTables, WS, type FakeDb } from './widgetConfigFakeDb';

const holder = vi.hoisted(() => ({ db: null as unknown as FakeDb }));
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: (t: string) => holder.db.client.from(t),
    rpc: (f: string, a?: Record<string, unknown>) => holder.db.client.rpc(f, a),
  }),
}));

process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key-language';
const config = { supabaseUrl: 'https://x.supabase.co', supabaseServiceRoleKey: 'SERVICE_KEY' } as never;

const snapshotMod = await import('../../../server/services/widget/configSnapshot.js');
const { preferredPlatformLocale } = snapshotMod;

const request = (acceptLanguage?: string) => ({
  query: {},
  headers: acceptLanguage ? { 'accept-language': acceptLanguage } : {},
  protocol: 'https',
  get: () => 'api.test',
  socket: { remoteAddress: '127.0.0.1' },
}) as unknown as Request;

async function fresh(edition: 'iran' | 'international', widgetLanguage: string, locale: string) {
  const tables = widgetScenarioTables({ edition, ai: false, smart: false, locale });
  Object.assign(tables.widget_settings[0], {
    widget_language: widgetLanguage,
    availability_labels: { en: { online: 'Here', offline: 'Away' }, tr: { online: 'Buradayız', offline: 'Uzaktayız' } },
  });
  holder.db = createFakeDb(tables, { rpc: allowAllRpc });
  snapshotMod.__resetWidgetConfigCachesForTests();
  (await import('../../../server/middleware/featureGating.js')).clearEntitlementCache();
  (await import('../../../server/services/platformRegion.js')).invalidatePlatformRegionCache();
  (await import('../../../server/services/ai-agent/platformSettings.js')).__resetPlatformAiAgentSettingsCache();
}
async function body(edition: 'iran' | 'international', acceptLanguage?: string) {
  const out = await snapshotMod.resolveWidgetConfigBody(config, request(acceptLanguage), WS, { edition, quotaFull: null });
  expect(out.status).toBe(200);
  return out.body as Record<string, unknown> & { availability: { labels: { online: string } } };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-17T10:00:00Z') });
});
afterEach(() => { vi.useRealTimers(); });

describe('preferredPlatformLocale', () => {
  it('the most wanted language the platform offers, by q then order; none: \'\'', () => {
    const all = ['en', 'tr', 'fa'];
    expect(preferredPlatformLocale('tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7', all)).toBe('tr');
    expect(preferredPlatformLocale('de-DE,de;q=0.9,en;q=0.5', all)).toBe('en');
    expect(preferredPlatformLocale('en;q=0.4, fa;q=0.8', all)).toBe('fa');
    expect(preferredPlatformLocale('de, *;q=0.1', all)).toBe('');
    expect(preferredPlatformLocale('fa;q=0', ['fa'])).toBe('');
    expect(preferredPlatformLocale(undefined, all)).toBe('');
    expect(preferredPlatformLocale('tr', ['fa'])).toBe('');
  });
});

describe('the /config body\'s language', () => {
  it('auto: a Turkish browser on an English workspace speaks Turkish, labels included; a language the platform lacks keeps the workspace\'s', async () => {
    await fresh('international', 'auto', 'en');
    const tr = await body('international', 'tr-TR,tr;q=0.9,en;q=0.8');
    expect(tr.locale).toBe('tr');
    expect(tr.widgetLanguage).toBe('auto');
    expect(tr.availability.labels.online).toBe('Buradayız');
    const de = await body('international', 'de-DE,de;q=0.9');
    expect(de.locale).toBe('en');
    expect(de.availability.labels.online).toBe('Here');
    expect((await body('international')).locale).toBe('en');
  });

  it('a chosen language stays chosen whatever the browser says', async () => {
    await fresh('international', 'en', 'tr');
    expect((await body('international', 'tr-TR,tr')).locale).toBe('en');
  });

  it('a one-language platform (the Iranian edition) speaks only Persian', async () => {
    await fresh('iran', 'auto', 'fa');
    expect((await body('iran', 'en-US,en;q=0.9')).locale).toBe('fa');
  });
});
