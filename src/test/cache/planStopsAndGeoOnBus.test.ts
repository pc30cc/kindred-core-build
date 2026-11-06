// @vitest-environment node
/**
 * Two more caches that used to clear only in the process that saved, now on
 * the cache bus (docs/operations/BACKEND_PROCESSES.md, "Caches and metrics
 * across the workers"):
 *
 *   - the plan stops (billing/planStops.ts) follow 'entitlements:<ws>' and
 *     'all', which plan changes already publish;
 *   - a MaxMind reader (geo/maxmindLocal.ts) follows `geo:<key of its file>`
 *     (geo/maxmindScope.ts), which the updater publishes after its swap, so
 *     the other processes on the same disk reopen that file at once, also
 *     with auto_reload off; an 'all' (a plan or settings save), a bare 'geo'
 *     and the bus's own resync leave the readers alone (nothing about the
 *     file changed), and concurrent lookups share one check of the file.
 *
 * Each case: a loader answers from its cache, then reads again after the
 * bus's handlers ran for its scope, as a NOTIFY from another process does.
 */
import { promises as fs } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const access = vi.fn(async () => ({ allowed: false, reason: 'plan_excludes' }));

vi.mock('../../../server/middleware/featureGating.js', () => ({
  checkChannelAccess: (...args: unknown[]) => access(...(args as [])),
  checkModuleAccess: (...args: unknown[]) => access(...(args as [])),
  requireLimit: () => undefined,
}));
vi.mock('../../../server/services/billing/locks/state.js', () => ({ locksEnabled: async () => true }));

const { invalidateLocal } = await import('../../../server/lib/cacheBus.js');
const { isPlanStopped, clearPlanStopCache } = await import('../../../server/services/billing/planStops.js');
const { lookupMaxmindLocal, invalidateMaxmindReader } = await import('../../../server/services/geo/maxmindLocal.js');
const { maxmindReaderScope } = await import('../../../server/services/geo/maxmindScope.js');

const config = {} as never;
const target = { kind: 'channel' as const, key: 'telegram' };

describe("the plan stops on 'entitlements'", () => {
  beforeEach(() => {
    clearPlanStopCache();
    access.mockClear();
  });

  it("'entitlements:<ws>' forgets that workspace's answers only", async () => {
    await isPlanStopped(config, 'ws-a', target);
    await isPlanStopped(config, 'ws-b', target);
    await isPlanStopped(config, 'ws-a', target);
    expect(access).toHaveBeenCalledTimes(2);
    invalidateLocal(['entitlements:ws-a']);
    expect(await isPlanStopped(config, 'ws-a', target)).toBe(true);
    await isPlanStopped(config, 'ws-b', target);
    expect(access).toHaveBeenCalledTimes(3);
  });

  it("'all' forgets every workspace's answers", async () => {
    await isPlanStopped(config, 'ws-a', target);
    await isPlanStopped(config, 'ws-b', target);
    invalidateLocal(['all']);
    await isPlanStopped(config, 'ws-a', target);
    await isPlanStopped(config, 'ws-b', target);
    expect(access).toHaveBeenCalledTimes(4);
  });
});

describe("the MaxMind readers on 'geo'", () => {
  const path = '/nonexistent/kcb-cache-bus-test/GeoLite2-City.mmdb';
  let stat: ReturnType<typeof vi.spyOn>;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    invalidateMaxmindReader();
    stat = vi.spyOn(fs, 'stat');
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    stat.mockRestore();
    warn.mockRestore();
  });

  it("the file's 'geo:<key>' makes the next lookup check it again; 'all', a bare 'geo', another file and the resync do not", async () => {
    expect(await lookupMaxmindLocal(path, '203.0.113.1')).toBeNull();
    await lookupMaxmindLocal(path, '203.0.113.1');
    // Within RECHECK_MS the cached answer serves: one look at the disk.
    expect(stat).toHaveBeenCalledTimes(1);
    invalidateLocal([maxmindReaderScope(path)]);
    await lookupMaxmindLocal(path, '203.0.113.1');
    expect(stat).toHaveBeenCalledTimes(2);
    for (const scopes of [['all'], ['geo'], [maxmindReaderScope('/other/GeoLite2-City.mmdb')]]) {
      invalidateLocal(scopes);
      await lookupMaxmindLocal(path, '203.0.113.1');
    }
    invalidateLocal(['all'], { resync: true });
    await lookupMaxmindLocal(path, '203.0.113.1');
    expect(stat).toHaveBeenCalledTimes(2);
  });

  it('any path fits its scope (a hash), spaces and long paths included', () => {
    const long = `/data/${'d'.repeat(400)}/Geo Lite2 City.mmdb`;
    expect(maxmindReaderScope(long)).toMatch(/^geo:[0-9a-f]{32}$/);
    expect(maxmindReaderScope(long)).not.toBe(maxmindReaderScope(path));
  });

  it('concurrent lookups that find no fresh reader share one check of the file', async () => {
    await Promise.all(Array.from({ length: 20 }, () => lookupMaxmindLocal(path, '203.0.113.1')));
    expect(stat).toHaveBeenCalledTimes(1);
    invalidateLocal([maxmindReaderScope(path)]);
    await Promise.all(Array.from({ length: 20 }, () => lookupMaxmindLocal(path, '203.0.113.1')));
    expect(stat).toHaveBeenCalledTimes(2);
  });
});
