// @vitest-environment node
/**
 * Availability wears the plan (W-04): a workspace whose plan has no
 * `widget_business_hours` (the panel's Availability tab: business hours and
 * the offline behaviour) is not held to the hours, offline mode and copy it
 * stored before a downgrade.
 *
 *   - resolveAvailability with the plan's answer: false resets the hours
 *     (no schedule: the operators decide) and the offline mode (the form),
 *     the copy stays; true and null (the plan could not be read) keep the
 *     stored settings;
 *   - without an answer it looks the plan up, only when the row uses
 *     something the plan gates;
 *   - GET /config and the bootstrap (the visitor's path, through the real
 *     snapshot and the real entitlement resolution) do the same;
 *   - businessHoursAllowedOf: a degraded entitlement read is "unknown", not
 *     "denied".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Request } from 'express';
import { createFakeDb, allowAllRpc, widgetScenarioTables, WS, USER_A, type FakeDb } from './widgetConfigFakeDb';

const holder = vi.hoisted(() => ({ db: null as unknown as FakeDb, lookups: 0, answer: false as boolean | null }));
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: (t: string) => holder.db.client.from(t),
    rpc: (f: string, a?: Record<string, unknown>) => holder.db.client.rpc(f, a),
  }),
}));
vi.mock('../../../server/services/widget/entitlements.js', async (orig) => ({
  ...(await orig<object>()),
  widgetBusinessHoursAllowed: async () => { holder.lookups += 1; return holder.answer; },
}));

process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key-availability-plan';
const config = { supabaseUrl: 'https://x.supabase.co', supabaseServiceRoleKey: 'SERVICE_KEY' } as never;
const { resolveAvailability, businessHoursAllowedOf } = await import('../../../server/services/widget/availability.js');
const snapshotMod = await import('../../../server/services/widget/configSnapshot.js');

// Monday 2026-10-19 12:00 in Tehran: the scenario's schedule has no Monday.
const MONDAY_NOON_TEHRAN = new Date('2026-10-19T08:30:00Z');

const stored = {
  business_hours: {
    enabled: true,
    timezone: 'Asia/Tehran',
    weekly: { sat: [{ from: '09:00', to: '17:00' }] },
    overrides: [],
  },
  offline_mode: 'hide_widget',
  availability_labels: { fa: { online: 'اینجاییم', offline: 'رفته‌ایم' } },
  offline_message: 'Legacy away text',
  offline_message_localized: { fa: 'فردا برمی‌گردیم' },
  live_chat_enabled: true,
};
const onePrefs = {
  memberIds: [USER_A],
  prefsByUser: new Map([[USER_A, { user_id: USER_A, force_offline: false, available_when_using_app: true, schedule_enabled: false, timezone: 'UTC', weekly_schedule: null }]]),
};

beforeEach(() => {
  holder.lookups = 0;
  holder.answer = false;
});

describe('resolveAvailability and the plan', () => {
  it('with the plan: the stored schedule and offline behaviour apply', async () => {
    const snap = await resolveAvailability(config, {
      workspaceId: WS, locale: 'fa', now: MONDAY_NOON_TEHRAN, settingsRow: stored, availabilityPrefs: onePrefs, businessHoursAllowed: true,
    });
    expect(snap).toMatchObject({ state: 'offline', reason: 'outside_hours', offline_mode: 'hide_widget', offline_message: 'فردا برمی‌گردیم' });
    expect(snap.labels).toEqual({ online: 'اینجاییم', offline: 'رفته‌ایم' });
    expect(snap.next_open_at).not.toBeNull();
  });

  it('without it: no schedule (an available operator makes it online), the form; the copy stays', async () => {
    const snap = await resolveAvailability(config, {
      workspaceId: WS, locale: 'fa', now: MONDAY_NOON_TEHRAN, settingsRow: stored, availabilityPrefs: onePrefs, businessHoursAllowed: false, includeSchedule: true,
    });
    expect(snap).toMatchObject({ state: 'online', reason: 'disabled', offline_mode: 'capture_message', offline_message: 'فردا برمی‌گردیم', next_open_at: null });
    expect(snap.labels).toEqual({ online: 'اینجاییم', offline: 'رفته‌ایم' });
    // The AI states no business hours either.
    expect(snap.schedule).toBeNull();
    // Nobody available: offline, in the default behaviour.
    const nobody = await resolveAvailability(config, {
      workspaceId: WS, locale: 'fa', now: MONDAY_NOON_TEHRAN, settingsRow: stored, businessHoursAllowed: false,
      availabilityPrefs: { memberIds: [USER_A], prefsByUser: new Map([[USER_A, { ...onePrefs.prefsByUser.get(USER_A)!, force_offline: true }]]) },
    });
    expect(nobody).toMatchObject({ state: 'offline', reason: 'no_operators_online', offline_mode: 'capture_message' });
  });

  it('an unreadable plan (null) keeps the stored settings rather than flipping a live widget', async () => {
    const snap = await resolveAvailability(config, {
      workspaceId: WS, locale: 'fa', now: MONDAY_NOON_TEHRAN, settingsRow: stored, availabilityPrefs: onePrefs, businessHoursAllowed: null,
    });
    expect(snap).toMatchObject({ state: 'offline', reason: 'outside_hours', offline_mode: 'hide_widget' });
  });

  it('no answer given: looked up, and applied; never looked up for a row the plan cannot change', async () => {
    const snap = await resolveAvailability(config, {
      workspaceId: WS, locale: 'fa', now: MONDAY_NOON_TEHRAN, settingsRow: stored, availabilityPrefs: onePrefs,
    });
    expect(holder.lookups).toBe(1);
    expect(snap).toMatchObject({ state: 'online', reason: 'disabled', offline_mode: 'capture_message' });

    holder.lookups = 0;
    const plain = await resolveAvailability(config, {
      workspaceId: WS, locale: 'fa', now: MONDAY_NOON_TEHRAN, availabilityPrefs: onePrefs,
      settingsRow: { business_hours: { enabled: false, timezone: 'UTC' }, offline_mode: 'capture_message', availability_labels: { fa: { online: 'اینجاییم' } }, offline_message_localized: { fa: 'فردا' } },
    });
    expect(holder.lookups).toBe(0);
    expect(plain).toMatchObject({ state: 'online', reason: 'disabled' });
  });

  it('businessHoursAllowedOf: denied only on a readable answer', () => {
    expect(businessHoursAllowedOf({ features: { widget_business_hours: false } })).toBe(false);
    expect(businessHoursAllowedOf({ features: { widget_business_hours: true } })).toBe(true);
    expect(businessHoursAllowedOf({ features: { widget_business_hours: false }, degraded: true })).toBeNull();
    expect(businessHoursAllowedOf(null)).toBeNull();
  });
});

const req = { query: {}, headers: {}, protocol: 'https', get: () => 'api.test', socket: { remoteAddress: '127.0.0.1' } } as unknown as Request;

async function visitorAvailability(deny: string[]): Promise<Record<string, unknown>> {
  const tables = widgetScenarioTables({ edition: 'iran', ai: false, smart: false });
  Object.assign(tables.widget_settings[0], { offline_mode: 'hide_widget' });
  const denied = new Set(deny);
  holder.db = createFakeDb(tables, {
    rpc: (fn, args) => (fn === 'check_workspace_entitlement' && denied.has(String(args?._feature))
      ? { data: { allowed: false, plan: 'free', reason: 'feature_disabled' }, error: null }
      : allowAllRpc(fn, args)),
  });
  snapshotMod.__resetWidgetConfigCachesForTests();
  (await import('../../../server/middleware/featureGating.js')).clearEntitlementCache();
  (await import('../../../server/services/platformRegion.js')).invalidatePlatformRegionCache();
  (await import('../../../server/services/ai-agent/platformSettings.js')).__resetPlatformAiAgentSettingsCache();
  const out = await snapshotMod.resolveWidgetConfigBody(config, req, WS, { edition: 'iran', quotaFull: null });
  expect(out.status).toBe(200);
  const fromConfig = (out.body as { availability: Record<string, unknown> }).availability;
  const snap = await snapshotMod.getWorkspaceWidgetSnapshot(config, WS);
  const fromBootstrap = await snapshotMod.bootstrapAvailability(config, WS, snap, 'fa', new Date(), null);
  expect(fromBootstrap).toEqual(fromConfig);
  return fromConfig;
}

describe('the visitor\'s path (GET /config, the bootstrap)', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'], now: MONDAY_NOON_TEHRAN }); });
  afterEach(() => { vi.useRealTimers(); });

  it('a plan with business hours: outside them, offline in the stored behaviour', async () => {
    const a = await visitorAvailability([]);
    expect(a).toMatchObject({ state: 'offline', reason: 'outside_hours', offline_mode: 'hide_widget' });
  });

  it('after a downgrade: no schedule (Sara is available, so online), the leave-a-message form', async () => {
    const a = await visitorAvailability(['widget_business_hours']);
    expect(a).toMatchObject({ state: 'online', reason: 'disabled', offline_mode: 'capture_message' });
    expect(holder.lookups).toBe(0);
  });
});
