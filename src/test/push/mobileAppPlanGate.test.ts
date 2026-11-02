// @vitest-environment node
/**
 * The server's read of the plan's mobile app (server/services/mobileApp/
 * planGate.ts, docs/operations/MOBILE_APP_PLAN.md "Server"): resolved as the
 * snapshot the apps read resolves it (the plan in force, plan ?? registry
 * default), cached a minute per workspace, dropped at once when the
 * workspace's entitlements change, and failing OPEN: only an explicit false
 * keeps a push from a phone, never an error.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createFakeDb, type FakeDb, type Row } from '../calls/teamCallTestDb';

const h = vi.hoisted(() => ({
  db: null as unknown as FakeDb,
  reads: [] as string[],
  noClient: false,
}));

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => {
    if (h.noClient) throw new Error('DATABASE_URL is not set');
    return {
      ...h.db,
      from: (table: string) => {
        h.reads.push(table);
        return h.db.from(table);
      },
    };
  },
}));

const { mobileAppAllowed, mobileAppRingMayBeLive, clearMobileAppGateCache, __resetMobileAppGateForTests } =
  await import('../../../server/services/mobileApp/planGate.js');
const { invalidateLocal } = await import('../../../server/lib/cacheBus.js');

const config = { supabaseUrl: 'http://db.test', supabaseServiceRoleKey: 'k' } as never;
const WS = 'ws-1';
const OTHER_WS = 'ws-2';

/** The workspace is on its own active plan with these entitlements. */
function onPlan(entitlements: Record<string, unknown>, workspaceId = WS, status = 'active'): Row {
  const planRow: Row = { id: `plan-${workspaceId}`, slug: `pro-${workspaceId}`, name: 'Pro', is_active: true, entitlements, limits: {} };
  h.db.tables.billing_plans = h.db.tables.billing_plans.filter((p) => p.id !== planRow.id).concat(planRow);
  h.db.tables.workspace_subscriptions = h.db.tables.workspace_subscriptions
    .filter((s) => s.workspace_id !== workspaceId)
    .concat({ workspace_id: workspaceId, plan_id: planRow.id, status });
  return planRow;
}

const subscriptionReads = () => h.reads.filter((t) => t === 'workspace_subscriptions').length;

beforeEach(() => {
  h.db = createFakeDb();
  h.db.tables.billing_plans = [{ id: 'plan-free', slug: 'free', name: 'Free', is_active: true, entitlements: {}, limits: {} }];
  h.db.tables.workspace_subscriptions = [];
  h.db.tables.workspace_limit_overrides = [];
  h.reads.length = 0;
  h.noClient = false;
  __resetMobileAppGateForTests();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('what the plan says', () => {
  it('a plan that never mentions the key keeps the apps (the default, on)', async () => {
    onPlan({ team_calls: true });
    expect(await mobileAppAllowed(config, WS)).toBe(true);
  });

  it('a plan with it off locks the workspace: an explicit false', async () => {
    onPlan({ mobile_app: false });
    expect(await mobileAppAllowed(config, WS)).toBe(false);
  });

  it('read as Postgres and the snapshot read it: the string "false" is false', async () => {
    onPlan({ mobile_app: 'false' });
    expect(await mobileAppAllowed(config, WS)).toBe(false);
    clearMobileAppGateCache();
    onPlan({ mobile_app: true });
    expect(await mobileAppAllowed(config, WS)).toBe(true);
  });

  it('a workspace without a plan, or whose plan no longer applies, follows Free', async () => {
    h.db.tables.billing_plans[0].entitlements = { mobile_app: false };
    expect(await mobileAppAllowed(config, WS)).toBe(false);
    onPlan({ mobile_app: true }, OTHER_WS, 'canceled');
    expect(await mobileAppAllowed(config, OTHER_WS)).toBe(false);
  });

  it('each workspace by its own plan', async () => {
    onPlan({ mobile_app: false }, WS);
    onPlan({}, OTHER_WS);
    expect(await mobileAppAllowed(config, WS)).toBe(false);
    expect(await mobileAppAllowed(config, OTHER_WS)).toBe(true);
  });

  it('a self-host install without billing is never locked, and reads nothing', async () => {
    onPlan({ mobile_app: false });
    expect(await mobileAppAllowed({ ...(config as object), selfHostBillingUnlimited: true } as never, WS)).toBe(true);
    expect(h.reads).toEqual([]);
  });

  it('no workspace: nothing to lock', async () => {
    expect(await mobileAppAllowed(config, '')).toBe(true);
    expect(await mobileAppAllowed(config, null)).toBe(true);
    expect(h.reads).toEqual([]);
  });
});

describe('the cache', () => {
  it('one read a minute per workspace', async () => {
    onPlan({ mobile_app: false });
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    expect(await mobileAppAllowed(config, WS)).toBe(false);
    onPlan({});
    expect(await mobileAppAllowed(config, WS)).toBe(false);
    clock.mockReturnValue(now + 59_000);
    expect(await mobileAppAllowed(config, WS)).toBe(false);
    expect(subscriptionReads()).toBe(1);
    clock.mockReturnValue(now + 61_000);
    expect(await mobileAppAllowed(config, WS)).toBe(true);
    expect(subscriptionReads()).toBe(2);
  });

  it('asks that arrive together share one read', async () => {
    onPlan({ mobile_app: false });
    const answers = await Promise.all(Array.from({ length: 5 }, () => mobileAppAllowed(config, WS)));
    expect(answers).toEqual([false, false, false, false, false]);
    expect(subscriptionReads()).toBe(1);
  });

  it('a change to the workspace\'s entitlements, in this process or another, is seen at once', async () => {
    onPlan({});
    expect(await mobileAppAllowed(config, WS)).toBe(true);
    onPlan({ mobile_app: false });
    // A plan assigned or an override (entitlementChange.ts publishes this scope).
    invalidateLocal([`entitlements:${WS}`]);
    expect(await mobileAppAllowed(config, WS)).toBe(false);
    // A plan definition edited: everything.
    onPlan({});
    invalidateLocal(['all']);
    expect(await mobileAppAllowed(config, WS)).toBe(true);
  });

  it('another workspace\'s change keeps this one\'s answer', async () => {
    onPlan({ mobile_app: false });
    expect(await mobileAppAllowed(config, WS)).toBe(false);
    invalidateLocal([`entitlements:${OTHER_WS}`]);
    expect(await mobileAppAllowed(config, WS)).toBe(false);
    expect(subscriptionReads()).toBe(1);
  });

  it('a read that an invalidation overtook does not keep its answer', async () => {
    onPlan({});
    const first = mobileAppAllowed(config, WS);
    clearMobileAppGateCache(WS);
    await first;
    onPlan({ mobile_app: false });
    expect(await mobileAppAllowed(config, WS)).toBe(false);
    expect(subscriptionReads()).toBe(2);
  });
});

describe('fails open', () => {
  it('an unreadable subscription: allowed, and asked again next time', async () => {
    onPlan({ mobile_app: false });
    h.db.failNext('workspace_subscriptions');
    expect(await mobileAppAllowed(config, WS)).toBe(true);
    expect(await mobileAppAllowed(config, WS)).toBe(false);
    expect(subscriptionReads()).toBe(2);
  });

  it('an unreadable plan row: allowed', async () => {
    onPlan({ mobile_app: false });
    h.db.failNext('billing_plans');
    expect(await mobileAppAllowed(config, WS)).toBe(true);
  });

  it('no Free plan to fall back on: allowed', async () => {
    h.db.tables.billing_plans = [];
    expect(await mobileAppAllowed(config, WS)).toBe(true);
  });

  it('no database at all: allowed, never a throw', async () => {
    h.noClient = true;
    await expect(mobileAppAllowed(config, WS)).resolves.toBe(true);
  });
});

describe('a stop for a ring', () => {
  it('goes while the plan has the app', async () => {
    onPlan({});
    expect(await mobileAppRingMayBeLive(config, WS, 45)).toBe(true);
  });

  it('a workspace locked all along has nothing ringing: no stop', async () => {
    onPlan({ mobile_app: false });
    expect(await mobileAppRingMayBeLive(config, WS, 45)).toBe(false);
  });

  it('goes for as long as a ring let through just before the lock can ring, the change of plan notwithstanding', async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    onPlan({});
    expect(await mobileAppAllowed(config, WS)).toBe(true);
    onPlan({ mobile_app: false });
    invalidateLocal([`entitlements:${WS}`]);
    invalidateLocal(['all']);
    clock.mockReturnValue(now + 30_000);
    expect(await mobileAppAllowed(config, WS)).toBe(false);
    expect(await mobileAppRingMayBeLive(config, WS, 45)).toBe(true);
    clock.mockReturnValue(now + 60_000);
    expect(await mobileAppRingMayBeLive(config, WS, 45)).toBe(true);
    clock.mockReturnValue(now + 60_001);
    expect(await mobileAppRingMayBeLive(config, WS, 45)).toBe(false);
    // Another workspace's ring says nothing about this one.
    onPlan({}, OTHER_WS);
    expect(await mobileAppAllowed(config, OTHER_WS)).toBe(true);
    expect(await mobileAppRingMayBeLive(config, WS, 45)).toBe(false);
  });

  it('a plan that cannot be read: the stop goes', async () => {
    onPlan({ mobile_app: false });
    h.db.failNext('workspace_subscriptions');
    expect(await mobileAppRingMayBeLive(config, WS, 45)).toBe(true);
  });
});
