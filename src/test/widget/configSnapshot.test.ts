// @vitest-environment node
/**
 * The widget config snapshot cache (server/services/widget/configSnapshot.ts)
 * against an in-memory database that counts every from() / rpc():
 * single flight, zero reads on a hit, stale-while-revalidate with one
 * background rebuild, the generation guard, `user:` invalidation, negative,
 * degraded and missing-row lifetimes, the LRU bound, the TTL=0 kill switch,
 * and stale serving while rebuilds fail (≤10 min).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createFakeDb, allowAllRpc, widgetScenarioTables, WS, USER_A, type FakeDb } from './widgetConfigFakeDb';

const holder = vi.hoisted(() => ({ db: null as unknown as FakeDb }));
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: (t: string) => holder.db.client.from(t),
    rpc: (f: string, a?: Record<string, unknown>) => holder.db.client.rpc(f, a),
  }),
}));

process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key-snapshot';
const config = { supabaseUrl: 'https://x.supabase.co', supabaseServiceRoleKey: 'SERVICE_KEY' } as never;

const WS2 = '22222222-2222-4222-8222-222222222222';
const WS3 = '33333333-3333-4333-8333-333333333333';
const WS4 = '44444444-4444-4444-8444-444444444444';

const snapshotMod = await import('../../../server/services/widget/configSnapshot.js');
const { invalidateLocal } = await import('../../../server/lib/cacheBus.js');
const { getWorkspaceWidgetSnapshot, __resetWidgetConfigCachesForTests, __peekWidgetSnapshotForTests } = snapshotMod;

function freshDb(extra: (t: ReturnType<typeof widgetScenarioTables>) => void = () => undefined, failing?: Set<string>) {
  const tables = widgetScenarioTables({ edition: 'international', ai: true, smart: true });
  // Three more workspaces; WS2 has USER_A as a member too, WS3 does not.
  tables.workspaces.push({ id: WS2, name: 'Second' }, { id: WS3, name: 'Third' }, { id: WS4, name: 'Fourth' });
  for (const id of [WS2, WS3, WS4]) tables.widget_settings.push({ ...tables.widget_settings[0], workspace_id: id });
  tables.workspace_members.push({ workspace_id: WS2, user_id: USER_A });
  extra(tables);
  holder.db = createFakeDb(tables, { rpc: allowAllRpc, failingTables: failing });
  return holder.db;
}

const reads = () => holder.db.calls.from + holder.db.calls.rpc;
const workspaceReads = () => holder.db.calls.log.filter((l) => l === 'from:workspaces').length;

async function resetAll() {
  __resetWidgetConfigCachesForTests();
  (await import('../../../server/middleware/featureGating.js')).clearEntitlementCache();
  (await import('../../../server/services/ai-agent/platformSettings.js')).__resetPlatformAiAgentSettingsCache();
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-14T10:00:00Z') });
  delete process.env.WIDGET_CONFIG_CACHE_TTL_MS;
  delete process.env.WIDGET_CONFIG_CACHE_MAX;
  delete process.env.WIDGET_CONFIG_REBUILDS_PER_SEC;
  freshDb();
  await resetAll();
});

afterEach(() => {
  vi.useRealTimers();
});

const at = (ms: number) => vi.setSystemTime(new Date('2026-10-14T10:00:00Z').getTime() + ms);

describe('workspace snapshot cache', () => {
  it('20 concurrent cold calls build once; the next call reads nothing', async () => {
    const snaps = await Promise.all(Array.from({ length: 20 }, () => getWorkspaceWidgetSnapshot(config, WS)));
    expect(new Set(snaps).size).toBe(1);
    expect(workspaceReads()).toBe(1);
    expect(snaps[0].workspace?.name).toBe('Acme Store');
    expect(snaps[0].degraded).toBe(false);
    holder.db.resetCalls();
    const again = await getWorkspaceWidgetSnapshot(config, WS);
    expect(again).toBe(snaps[0]);
    expect(reads()).toBe(0);
  });

  it('a cold build reads in waves, not one query after another', async () => {
    await getWorkspaceWidgetSnapshot(config, WS);
    // Everything one /config + /bootstrap pair used to read per request.
    const log = holder.db.calls.log;
    for (const t of ['workspaces', 'widget_settings', 'workspace_branding', 'feature_flags', 'workspace_members',
      'ai_agent_settings', 'user_availability_prefs', 'profiles', 'widget_smart_rules']) {
      expect(log).toContain(`from:${t}`);
    }
  });

  it('keys are case-blind and per workspace (no cross-workspace leakage)', async () => {
    const a = await getWorkspaceWidgetSnapshot(config, WS);
    holder.db.resetCalls();
    expect(await getWorkspaceWidgetSnapshot(config, WS.toUpperCase())).toBe(a);
    expect(reads()).toBe(0);
    const b = await getWorkspaceWidgetSnapshot(config, WS2);
    expect(b).not.toBe(a);
    expect(b.workspace?.name).toBe('Second');
    expect(a.workspace?.name).toBe('Acme Store');
  });

  it('past the TTL (60 s) it serves the stale entry and rebuilds once in the background', async () => {
    const first = await getWorkspaceWidgetSnapshot(config, WS);
    holder.db.tables.workspaces[0].name = 'Renamed';
    at(59_000);
    expect(await getWorkspaceWidgetSnapshot(config, WS)).toBe(first);
    holder.db.resetCalls();
    at(61_000);
    const stale = await Promise.all([getWorkspaceWidgetSnapshot(config, WS), getWorkspaceWidgetSnapshot(config, WS)]);
    expect(stale[0]).toBe(first);
    expect(stale[1]).toBe(first);
    await vi.waitFor(() => expect(__peekWidgetSnapshotForTests(WS)?.workspace?.name).toBe('Renamed'));
    expect(workspaceReads()).toBe(1);
  });

  it('a build running when its workspace is invalidated is not stored', async () => {
    const running = getWorkspaceWidgetSnapshot(config, WS);
    invalidateLocal([`widget:${WS}`]);
    const snap = await running;
    expect(snap.workspace?.name).toBe('Acme Store');
    expect(__peekWidgetSnapshotForTests(WS)).toBeUndefined();
    holder.db.resetCalls();
    await getWorkspaceWidgetSnapshot(config, WS);
    expect(workspaceReads()).toBe(1);
  });

  it("widget:<ws> drops that workspace only; 'user:<id>' drops the snapshots whose team has that user", async () => {
    await Promise.all([WS, WS2, WS3].map((id) => getWorkspaceWidgetSnapshot(config, id)));
    invalidateLocal([`widget:${WS3}`]);
    expect(__peekWidgetSnapshotForTests(WS3)).toBeUndefined();
    expect(__peekWidgetSnapshotForTests(WS)).toBeDefined();
    await getWorkspaceWidgetSnapshot(config, WS3);
    invalidateLocal([`user:${USER_A.toUpperCase()}`]);
    expect(__peekWidgetSnapshotForTests(WS)).toBeUndefined();
    expect(__peekWidgetSnapshotForTests(WS2)).toBeUndefined();
    expect(__peekWidgetSnapshotForTests(WS3)).toBeDefined();
  });

  it('clearEntitlementCache / clearLockStateCache drop the local snapshot too', async () => {
    await getWorkspaceWidgetSnapshot(config, WS);
    (await import('../../../server/middleware/featureGating.js')).clearEntitlementCache(WS);
    expect(__peekWidgetSnapshotForTests(WS)).toBeUndefined();
    await getWorkspaceWidgetSnapshot(config, WS);
    (await import('../../../server/services/billing/locks/state.js')).clearLockStateCache();
    expect(__peekWidgetSnapshotForTests(WS)).toBeUndefined();
  });

  it('a workspace that does not exist is remembered 15 s (one query each time)', async () => {
    const missing = '99999999-9999-4999-8999-999999999999';
    const snap = await getWorkspaceWidgetSnapshot(config, missing);
    expect(snap.workspace).toBeNull();
    expect(reads()).toBe(1);
    holder.db.resetCalls();
    at(14_000);
    await getWorkspaceWidgetSnapshot(config, missing);
    expect(reads()).toBe(0);
    at(16_000);
    await getWorkspaceWidgetSnapshot(config, missing);
    await vi.waitFor(() => expect(reads()).toBe(1));
  });

  it('a workspace without a widget_settings row lives 15 s, not the full TTL', async () => {
    freshDb((t) => { t.widget_settings = []; });
    await resetAll();
    const snap = await getWorkspaceWidgetSnapshot(config, WS);
    expect(snap.workspace).not.toBeNull();
    expect(snap.widgetRow).toBeNull();
    holder.db.tables.widget_settings.push({ workspace_id: WS, enabled: true });
    at(16_000);
    await getWorkspaceWidgetSnapshot(config, WS);
    await vi.waitFor(() => expect(__peekWidgetSnapshotForTests(WS)?.widgetRow).not.toBeNull());
  });

  it('a degraded build (a read failed) is kept 5 s only', async () => {
    freshDb(undefined, new Set(['workspace_branding']));
    await resetAll();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const snap = await getWorkspaceWidgetSnapshot(config, WS);
    expect(snap.degraded).toBe(true);
    holder.db.resetCalls();
    at(4_000);
    await getWorkspaceWidgetSnapshot(config, WS);
    expect(reads()).toBe(0);
    holder.db.options.failingTables = new Set();
    at(6_000);
    await getWorkspaceWidgetSnapshot(config, WS);
    await vi.waitFor(() => expect(__peekWidgetSnapshotForTests(WS)?.degraded).toBe(false));
    warn.mockRestore();
  });

  it('an unreadable entitlement makes the build degraded', async () => {
    holder.db = createFakeDb(holder.db.tables, {
      rpc: (fn, args) => (fn === 'check_workspace_entitlement' && args?._feature === 'widget_emoji'
        ? { data: null, error: { message: 'rpc down' } }
        : allowAllRpc(fn, args)),
    });
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const snap = await getWorkspaceWidgetSnapshot(config, WS);
    expect(snap.degraded).toBe(true);
    expect(snap.entitlements?.degraded).toBe(true);
    err.mockRestore();
  });

  it('a degraded or failing rebuild keeps serving the good entry, for at most 10 min', async () => {
    const good = await getWorkspaceWidgetSnapshot(config, WS);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    holder.db.options.failingTables = new Set(['widget_settings']);
    at(61_000);
    expect(await getWorkspaceWidgetSnapshot(config, WS)).toBe(good);
    await vi.waitFor(() => expect(holder.db.calls.log).toContain('from:widget_settings'));
    // Degraded result not stored over the good one.
    expect(__peekWidgetSnapshotForTests(WS)).toBe(good);
    // A thrown build too.
    const realFrom = holder.db.client.from;
    holder.db.client.from = () => { throw new Error('connection refused'); };
    at(9 * 60_000);
    expect(await getWorkspaceWidgetSnapshot(config, WS)).toBe(good);
    // Past 10 minutes the rebuild is awaited and its failure surfaces.
    at(60_000 + 10 * 60_000 + 1);
    await expect(getWorkspaceWidgetSnapshot(config, WS)).rejects.toThrow('connection refused');
    holder.db.client.from = realFrom;
    warn.mockRestore();
  });

  it('WIDGET_CONFIG_CACHE_MAX bounds the cache (least recently used goes first)', async () => {
    process.env.WIDGET_CONFIG_CACHE_MAX = '3';
    for (const id of [WS, WS2, WS3]) await getWorkspaceWidgetSnapshot(config, id);
    await getWorkspaceWidgetSnapshot(config, WS); // WS2 is now the oldest
    await getWorkspaceWidgetSnapshot(config, WS4);
    expect(__peekWidgetSnapshotForTests(WS2)).toBeUndefined();
    for (const id of [WS, WS3, WS4]) expect(__peekWidgetSnapshotForTests(id)).toBeDefined();
  });

  it('WIDGET_CONFIG_CACHE_TTL_MS=0 turns the cache off (every call reads)', async () => {
    process.env.WIDGET_CONFIG_CACHE_TTL_MS = '0';
    await getWorkspaceWidgetSnapshot(config, WS);
    holder.db.resetCalls();
    await getWorkspaceWidgetSnapshot(config, WS);
    expect(workspaceReads()).toBe(1);
    expect(__peekWidgetSnapshotForTests(WS)).toBeUndefined();
  });

  it('WIDGET_CONFIG_CACHE_TTL_MS sets the fresh lifetime', async () => {
    process.env.WIDGET_CONFIG_CACHE_TTL_MS = '300000';
    await getWorkspaceWidgetSnapshot(config, WS);
    holder.db.resetCalls();
    at(299_000);
    await getWorkspaceWidgetSnapshot(config, WS);
    expect(reads()).toBe(0);
  });

  it('rebuilds are budgeted per process; the existence read is not', async () => {
    process.env.WIDGET_CONFIG_REBUILDS_PER_SEC = '1'; // burst 2
    __resetWidgetConfigCachesForTests();
    await getWorkspaceWidgetSnapshot(config, WS);
    await getWorkspaceWidgetSnapshot(config, WS2);
    // Made-up ids cost one read each and never wait for the budget.
    for (let i = 0; i < 5; i++) {
      const snap = await getWorkspaceWidgetSnapshot(config, `00000000-0000-4000-8000-00000000000${i}`);
      expect(snap.workspace).toBeNull();
    }
    // A third real cold workspace waits for the next token.
    let done = false;
    const third = getWorkspaceWidgetSnapshot(config, WS3).then((s) => { done = true; return s; });
    await new Promise((r) => setTimeout(r, 50));
    expect(done).toBe(false);
    at(1_100); // the bucket refills by the clock
    expect((await third).workspace?.name).toBe('Third');
  });
});

describe('platform snapshot and quota', () => {
  it('the platform snapshot holds every localized platform name and is cached', async () => {
    const p = await snapshotMod.getWidgetPlatformSnapshot(config);
    expect(p.names.get('en')).toBe('WebYar');
    expect(p.names.get('tr')).toBe('WebYar TR');
    expect((p.preChatPolicy as { email: string }).email).toBe('force_on');
    holder.db.resetCalls();
    await snapshotMod.getWidgetPlatformSnapshot(config);
    expect(reads()).toBe(0);
    invalidateLocal(['platform']);
    await snapshotMod.getWidgetPlatformSnapshot(config);
    expect(reads()).toBeGreaterThan(0);
  });

  it('quota_full is cached 60 s and follows a lock-state clear at once', async () => {
    holder.db = createFakeDb(holder.db.tables, {
      rpc: (fn, args) => (fn === 'billing_locks_enabled' ? { data: true, error: null } : allowAllRpc(fn, args)),
    });
    (await import('../../../server/services/billing/locks/state.js')).clearLockStateCache();
    expect(await snapshotMod.getQuotaFull(config, WS)).toBe(false); // unlimited plan
    holder.db.resetCalls();
    expect(await snapshotMod.getQuotaFull(config, WS)).toBe(false);
    expect(reads()).toBe(0);
    holder.db = createFakeDb(holder.db.tables, { rpc: (fn, args) => (fn === 'billing_locks_enabled' ? { data: false, error: null } : allowAllRpc(fn, args)) });
    (await import('../../../server/services/billing/locks/state.js')).clearLockStateCache();
    expect(await snapshotMod.getQuotaFull(config, WS)).toBeNull();
  });
});

describe('degraded and not-found snapshots are never served stale', () => {
  it('a degraded "not found" is rebuilt once its 5 s passed: the request after recovery gets the workspace', async () => {
    freshDb(undefined, new Set(['workspaces']));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const s1 = await getWorkspaceWidgetSnapshot(config, WS);
    expect(s1.workspace).toBeNull();
    expect(s1.degraded).toBe(true);
    holder.db.options.failingTables = new Set();
    at(6_000);
    const s2 = await getWorkspaceWidgetSnapshot(config, WS);
    expect(s2.workspace?.id).toBe(WS);
    expect(s2.degraded).toBe(false);
    warn.mockRestore();
  });

  it('a bus resync keeps good snapshots servable (one background rebuild), unlike an explicit flush', async () => {
    await getWorkspaceWidgetSnapshot(config, WS);
    holder.db.resetCalls();
    invalidateLocal(['all'], { resync: true });
    const s = await getWorkspaceWidgetSnapshot(config, WS);
    expect(s.workspace?.id).toBe(WS);
    // Answered from the old copy: the request itself read nothing new
    // before it got its answer, and ONE rebuild followed in the background.
    await vi.waitFor(() => expect(workspaceReads()).toBe(1));
    await getWorkspaceWidgetSnapshot(config, WS);
    expect(workspaceReads()).toBe(1);
    invalidateLocal(['all']);
    expect(__peekWidgetSnapshotForTests(WS)).toBeUndefined();
  });
});
