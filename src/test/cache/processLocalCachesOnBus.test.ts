/**
 * The caches that used to clear only in the process that saved (the calls
 * and RTC settings, the realtime provider and failover state, the MaxMind
 * readers, the plan stops) are on the cache bus: a save in one backend
 * process — another replica, the old container during a deploy, another
 * cluster worker (docs/operations/BACKEND_PROCESSES.md) — clears them in
 * every other one.
 *
 * Behaviour: each loader reads the database once, serves its cache, and
 * reads again after the bus's handlers ran for its scope (what a NOTIFY from
 * another process does). Text: each writer publishes the scope instead of
 * clearing only its own copy.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const reads = new Map<string, number>();

function readsOf(name: string): number {
  return reads.get(name) ?? 0;
}

/** A query chain that answers every read with no row and counts it by table (and app_runtime_config key). */
function chain(table: string) {
  let key = table;
  const result = { data: null, error: null };
  const q: Record<string, unknown> = {};
  for (const m of ['select', 'or', 'order', 'limit', 'in', 'neq', 'is', 'not']) q[m] = () => q;
  q.eq = (col: string, value: unknown) => {
    if (table === 'app_runtime_config' && col === 'key') key = `${table}:${String(value)}`;
    return q;
  };
  const settle = () => {
    reads.set(key, readsOf(key) + 1);
    return Promise.resolve(result);
  };
  q.maybeSingle = settle;
  q.single = settle;
  q.then = (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => settle().then(ok, bad);
  return q;
}

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({ from: (table: string) => chain(table), rpc: () => Promise.resolve({ data: null, error: null }) }),
}));

const config = {} as never;
const { invalidateLocal } = await import('../../../server/lib/cacheBus.js');
const rtc = await import('../../../server/services/calls/rtcResolver.js');
const livekit = await import('../../../server/services/calls/livekitConfig.js');
const agora = await import('../../../server/services/calls/agoraConfig.js');
const permissions = await import('../../../server/services/calls/permissions.js');
const departments = await import('../../../server/services/calls/departments.js');
const realtimeStore = await import('../../../server/services/realtime/store.js');
const controlPlane = await import('../../../server/services/realtime/controlPlane.js');
const failoverState = await import('../../../server/services/realtime/failoverState.js');

async function primeCalls(): Promise<void> {
  await rtc.getRtcBaseUrl(config);
  await livekit.loadLiveKitConfig(config);
  await agora.loadAgoraConfig(config);
  await permissions.resolveRolePermissions(config, 'ws-a', 'agent');
  await permissions.resolveRolePermissions(config, 'ws-b', 'agent');
  await departments.resolveDepartments(config, 'ws-a');
  await departments.resolveDepartments(config, 'ws-b');
}

beforeEach(() => {
  invalidateLocal(['all']);
  reads.clear();
});

describe("the 'calls' scope", () => {
  it('clears the RTC, LiveKit and Agora caches and every workspace\'s permissions and departments', async () => {
    await primeCalls();
    await primeCalls();
    const after = new Map(reads);
    // Served from the caches the second time.
    expect(readsOf('app_runtime_config:call_rtc_endpoints')).toBe(1);
    expect(readsOf('role_permissions')).toBe(2);
    expect(readsOf('workspace_departments')).toBe(2);

    invalidateLocal(['calls']);
    await primeCalls();
    for (const [name, count] of after) expect(readsOf(name), name).toBe(count * 2);
  });

  it("'calls:<ws>' clears only that workspace's permissions and departments", async () => {
    await primeCalls();
    const rtcReads = readsOf('app_runtime_config:call_rtc_endpoints');
    invalidateLocal(['calls:ws-a']);
    await primeCalls();
    expect(readsOf('app_runtime_config:call_rtc_endpoints')).toBe(rtcReads);
    expect(readsOf('role_permissions')).toBe(3);
    expect(readsOf('workspace_departments')).toBe(3);
  });
});

describe("the 'realtime' scope", () => {
  it('clears the provider config, the control plane and the failover state', async () => {
    const prime = async () => {
      await realtimeStore.loadRealtimeConfig(config);
      await controlPlane.loadControlPlane(config);
      await failoverState.loadFailoverState(config);
    };
    await prime();
    await prime();
    const once = new Map(reads);
    expect([...once.values()].every((n) => n === 1)).toBe(true);
    invalidateLocal(['realtime']);
    await prime();
    for (const [name, count] of once) expect(readsOf(name), name).toBe(count + 1);
  });
});

const root = path.resolve(__dirname, '../../..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');

describe('registrations and writers', () => {
  it('every cache registers on its scope', () => {
    const registered: Array<[string, RegExp]> = [
      ['server/services/calls/rtcResolver.ts', /onInvalidate\('calls'/],
      ['server/services/calls/livekitConfig.ts', /onInvalidate\('calls'/],
      ['server/services/calls/agoraConfig.ts', /onInvalidate\('calls'/],
      ['server/services/calls/providers/livekitProvider.ts', /onInvalidate\('calls'[^\n]*invalidateLiveKitReadinessCache/],
      ['server/services/calls/permissions.ts', /onInvalidate\('calls'/],
      ['server/services/calls/departments.ts', /onInvalidate\('calls'/],
      ['server/services/realtime/store.ts', /onInvalidate\('realtime'/],
      ['server/services/realtime/controlPlane.ts', /onInvalidate\('realtime'/],
      ['server/services/realtime/failoverState.ts', /onInvalidate\('realtime'/],
      ['server/services/realtime/resolvePublisher.ts', /onInvalidate\('realtime'[^\n]*invalidatePublisherCache/],
      ['server/services/geo/maxmindLocal.ts', /onInvalidate\('geo'/],
      ['server/services/billing/planStops.ts', /onInvalidate\('entitlements'[^\n]*clearPlanStopCache/],
    ];
    for (const [file, re] of registered) expect(read(file), file).toMatch(re);
  });

  it('every writer publishes the scope instead of clearing only its own copy', () => {
    // [file, the publish, how many, a statement that clears only this process's copy]
    const writers: Array<[string, string, number, RegExp]> = [
      ['server/services/calls/rtcResolver.ts', "publishCacheInvalidation(['calls'])", 1, /^\s*invalidateRtcCache\(\);$/m],
      ['server/services/calls/livekitConfig.ts', "publishCacheInvalidation(['calls'])", 1, /^\s*invalidateLiveKitConfigCache\(\);$/m],
      ['server/services/calls/agoraConfig.ts', "publishCacheInvalidation(['calls'])", 1, /^\s*invalidateAgoraConfigCache\(\);$/m],
      ['server/routes/adminCalls.ts', "publishCacheInvalidation(['calls'])", 3, /^\s*invalidate(Rtc|LiveKitReadiness|Permission)Cache\(/m],
      ['server/routes/workspaceCalls.ts', 'publishCacheInvalidation([`calls:${workspaceId}`])', 1, /^\s*invalidatePermissionCache\(/m],
      ['server/routes/workspaceMembers.ts', 'publishCacheInvalidation([`calls:${workspaceId}`])', 2, /^\s*invalidateDepartmentCache\(/m],
      ['server/routes/workspaceMembers.ts', 'publishCacheInvalidation([`calls:${workspaceId}`, `entitlements:${workspaceId}`])', 1, /^\s*invalidateDepartmentCache\(/m],
      ['server/routes/workspaceDepartments.ts', 'publishCacheInvalidation([`calls:${workspaceId}`])', 4, /^\s*invalidateDepartmentCache\(/m],
      ['server/services/realtime/store.ts', "publishCacheInvalidation(['realtime'])", 1, /^\s*invalidateRealtimeCache\(\);$/m],
      ['server/services/realtime/controlPlane.ts', "publishCacheInvalidation(['realtime'])", 1, /^\s*invalidateControlPlaneCache\(\);$/m],
      ['server/services/realtime/failoverTicker.ts', "publishCacheInvalidation(['realtime'])", 1, /^\s*invalidate(Publisher|FailoverState)Cache\(/m],
      ['server/routes/realtime.ts', "publishCacheInvalidation(['realtime'])", 1, /^\s*invalidateRealtimeCache\(/m],
      ['server/services/geo/maxmindUpdater.ts', 'publishCacheInvalidation([maxmindReaderScope(dbPath)])', 1, /^\s*invalidateMaxmindReader\(/m],
    ];
    for (const [file, publish, count, localOnly] of writers) {
      const src = read(file);
      expect(src.split(publish).length - 1, `${file}: ${publish}`).toBe(count);
      expect(localOnly.test(src), `${file} still clears only its own copy (${localOnly})`).toBe(false);
    }
  });

  it('every change that frees or shifts a lock slot publishes the lock state on entitlements:<ws>', () => {
    // [file, the publish]: a seat change, a deleted contact or article, the
    // retention's deletes. Each also clears its own copy at once (tests that
    // mock the cache bus still see it), but never only its own copy.
    const writers: Array<[string, string]> = [
      ['server/routes/workspaceMembers.ts', 'publishCacheInvalidation([`calls:${workspaceId}`, `entitlements:${workspaceId}`])'],
      ['server/services/contactChatLocks.ts', 'publishCacheInvalidation([`entitlements:${workspaceId}`])'],
      ['server/services/knowledge-base/locks.ts', 'publishCacheInvalidation([`entitlements:${workspaceId}`])'],
      ['server/services/billing/locks/retention.ts', 'publishCacheInvalidation([`entitlements:${clock.workspace_id}`])'],
    ];
    for (const [file, publish] of writers) {
      const src = read(file);
      expect(src, file).toContain(publish);
      // Every local clear of one workspace's lock state sits right before its publish.
      const clears = src.match(/^\s*clearLockStateCache\([^)]+\);$/gm) ?? [];
      const published = src.match(/^\s*clearLockStateCache\([^)]+\);\n(?:\s*\/\/[^\n]*\n)*\s*publishCacheInvalidation\(\[[^\]]*entitlements:/gm) ?? [];
      expect(published.length, `${file}: a clearLockStateCache without its publish`).toBe(clears.length);
    }
  });

  it('the plan stops follow a scope their writers already publish', () => {
    expect(read('server/services/billing/entitlementChange.ts')).toMatch(/publishCacheInvalidation\(\[[^\]]*entitlements/);
  });
});
