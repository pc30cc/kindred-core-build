/**
 * CUTOVER READINESS GATING, and the two runtime guards it depends on.
 *
 * The contract being pinned is narrow and important: readiness REPORTS, it
 * never GRANTS. `s3OnlyUnlocked` is false whatever the checks say, and the
 * admin route refuses `s3_only` and `readMode: 's3'` independently of it.
 * A green checklist that quietly enabled a cutover would be the single worst
 * outcome of building this card at all.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  resetFakeAnalyticsPool, seedGeneralPool, seedAnalyticsPool, seedTable, runtimeConfig,
} from './fakeAnalyticsPool';

vi.mock('../../../server/supabase.js', async () => {
  const { makeFakeSupabaseClient } = await import('./fakeAnalyticsPool');
  const client = makeFakeSupabaseClient();
  return { getServiceClient: () => client };
});
vi.mock('../../../server/services/observability/metrics.js', () => ({
  emitMetric: () => undefined,
  emitLog: () => undefined,
}));

const { cutoverReadiness } = await import('../../../server/services/analytics/readiness.js');
const { parquetRuntimeSupport, writeParquet } = await import('../../../server/services/analytics/parquet.js');
const { duckDbAvailability } = await import('../../../server/services/analytics/duckdb.js');
const { analyticsDurabilityReadiness } = await import('../../../server/services/analytics/writer.js');
const { __resetSpoolForTests } = await import('../../../server/services/analytics/spool.js');

const serverConfig = {} as never;
const WS = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

let primaryDir: string;
let spoolDir: string;

function stateOf(checks: { key: string; state: string }[], key: string): string {
  return checks.find((c) => c.key === key)?.state ?? 'missing';
}

function configure(opts?: { enabled?: boolean; primary?: string | null; lastError?: string | null }) {
  seedGeneralPool({
    primary: 'bunny_storage',
    providers: {
      bunny_storage: { config: { username: 'z', password: 'p', hostname: 'storage.bunnycdn.com', cdn_url: 'https://g.b-cdn.net' } },
      local: { config: { local_path: primaryDir, public_url: 'http://localhost:9999/files' } },
    },
  });
  seedAnalyticsPool({
    enabled: opts?.enabled ?? true,
    primary: opts?.primary === undefined ? 'local' : opts.primary,
    replicas: [], replicationEnabled: false,
    prefix: 'analytics/web/', knownPrefixes: ['analytics/web/'],
    batchRows: 10_000, batchBytes: 33_554_432, flushIntervalMs: 15_000,
    format: 'parquet', compression: 'zstd', writeMode: 'dual_write', readMode: 'postgres',
    replicaState: {},
    lastWriteAt: '2026-09-16T20:00:00.000Z',
    lastError: opts?.lastError ?? null,
  });
}

beforeEach(() => {
  resetFakeAnalyticsPool();
  primaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'analytics-readiness-'));
  spoolDir = fs.mkdtempSync(path.join(os.tmpdir(), 'analytics-readiness-spool-'));
  __resetSpoolForTests(spoolDir);
  configure();
  seedTable('analytics_day_seals', []);
  seedTable('workspace_deletion_jobs', []);
});

afterEach(() => {
  __resetSpoolForTests(spoolDir);
  delete process.env.ANALYTICS_SPOOL_DIR;
  delete process.env.ANALYTICS_SPOOL_ENABLED;
  for (const d of [primaryDir, spoolDir]) fs.rmSync(d, { recursive: true, force: true });
});

describe('the lock is not the checklist', () => {
  it('never reports s3_only as unlocked, whatever the checks say', async () => {
    const readiness = await cutoverReadiness(serverConfig);
    expect(readiness.s3OnlyUnlocked).toBe(false);
  });

  it('reports every one of the eleven checks', async () => {
    const readiness = await cutoverReadiness(serverConfig);
    const keys = readiness.checks.map((c) => c.key);
    for (const key of [
      'primaryConfigured', 'primaryHealth', 'replicaHealth', 'duckdbAvailable',
      'historicalBackfill', 'productionParity', 'workspaceDeletion',
      'durableIngestion', 'nodeRuntime',
      // Phase 3A additions.
      'multiInstanceDurability', 'erasureApplied',
    ]) {
      expect(keys, `${key} is missing from the readiness card`).toContain(key);
    }
    expect(readiness.checks).toHaveLength(11);
  });

  it('is ineligible while ANY check is blocked', async () => {
    const readiness = await cutoverReadiness(serverConfig);
    if (readiness.blockedCount > 0) expect(readiness.s3OnlyEligible).toBe(false);
    else expect(readiness.s3OnlyEligible).toBe(true);
  });

  it('counts warnings separately — a warning must not block', async () => {
    const readiness = await cutoverReadiness(serverConfig);
    const warnings = readiness.checks.filter((c) => c.state === 'warning').length;
    expect(readiness.warningCount).toBe(warnings);
  });
});

describe('individual gates', () => {
  it('BLOCKS when no analytics primary is configured', async () => {
    configure({ primary: null });
    const { checks } = await cutoverReadiness(serverConfig);
    expect(stateOf(checks, 'primaryConfigured')).toBe('blocked');
  });

  it('BLOCKS when the primary last reported an error', async () => {
    configure({ lastError: 'upload failed' });
    const { checks } = await cutoverReadiness(serverConfig);
    expect(stateOf(checks, 'primaryHealth')).toBe('blocked');
  });

  it('BLOCKS when nothing has ever been sealed', async () => {
    seedTable('analytics_day_seals', []);
    const { checks } = await cutoverReadiness(serverConfig);
    expect(stateOf(checks, 'historicalBackfill')).toBe('blocked');
  });

  it('BLOCKS on a seal whose row count did not match the source', async () => {
    seedTable('analytics_day_seals', [
      { workspace_id: WS, day: '2026-08-10', sealed_at: '2026-08-11T02:00:00.000Z', verified: false },
    ]);
    const { checks } = await cutoverReadiness(serverConfig);
    expect(stateOf(checks, 'historicalBackfill')).toBe('blocked');
  });

  it('WARNS — does not block — on a day that is merely not sealed yet', async () => {
    seedTable('analytics_day_seals', [
      { workspace_id: WS, day: '2026-08-10', sealed_at: '2026-08-11T02:00:00.000Z', verified: true },
      { workspace_id: WS, day: '2026-08-11', sealed_at: null, verified: false },
    ]);
    const { checks } = await cutoverReadiness(serverConfig);
    expect(stateOf(checks, 'historicalBackfill')).toBe('warning');
  });

  it('is READY when every seal is verified', async () => {
    seedTable('analytics_day_seals', [
      { workspace_id: WS, day: '2026-08-10', sealed_at: '2026-08-11T02:00:00.000Z', verified: true },
    ]);
    const { checks } = await cutoverReadiness(serverConfig);
    expect(stateOf(checks, 'historicalBackfill')).toBe('ready');
  });

  it('BLOCKS when no parity run has ever been recorded', async () => {
    const { checks } = await cutoverReadiness(serverConfig);
    expect(stateOf(checks, 'productionParity')).toBe('blocked');
  });

  it('BLOCKS on a parity run that found regressions', async () => {
    runtimeConfig.set('analytics_parity_state', {
      at: new Date().toISOString(), workspaceId: WS,
      range: { startDate: '2026-08-01', endDate: '2026-08-10' },
      regressions: 3, expectedDifferences: 0, unavailable: null, reports: [],
    });
    const { checks } = await cutoverReadiness(serverConfig);
    expect(stateOf(checks, 'productionParity')).toBe('blocked');
  });

  it('WARNS on a clean parity run that is too old to mean anything', async () => {
    runtimeConfig.set('analytics_parity_state', {
      at: '2020-01-01T00:00:00.000Z', workspaceId: WS,
      range: { startDate: '2020-01-01', endDate: '2020-01-02' },
      regressions: 0, expectedDifferences: 0, unavailable: null, reports: [],
    });
    const { checks } = await cutoverReadiness(serverConfig);
    expect(stateOf(checks, 'productionParity')).toBe('warning');
  });

  it('is READY on a recent clean parity run', async () => {
    runtimeConfig.set('analytics_parity_state', {
      at: new Date().toISOString(), workspaceId: WS,
      range: { startDate: '2026-08-01', endDate: '2026-08-10' },
      regressions: 0, expectedDifferences: 0, unavailable: null, reports: [],
    });
    const { checks } = await cutoverReadiness(serverConfig);
    expect(stateOf(checks, 'productionParity')).toBe('ready');
  });
});

describe('durable ingestion gate', () => {
  it('is READY and ACTIVE when the spool is writable and enabled', async () => {
    process.env.ANALYTICS_SPOOL_ENABLED = '1';
    const { checks } = await cutoverReadiness(serverConfig);
    expect(stateOf(checks, 'durableIngestion')).toBe('ready');
  });

  it('WARNS when the spool works but is not switched on', async () => {
    delete process.env.ANALYTICS_SPOOL_ENABLED;
    const { checks } = await cutoverReadiness(serverConfig);
    expect(stateOf(checks, 'durableIngestion')).toBe('warning');
  });

  it('BLOCKS when the spool directory cannot be written', async () => {
    // A volume that was never mounted, modelled with a file as the parent.
    const blocker = path.join(primaryDir, 'not-a-dir');
    fs.writeFileSync(blocker, 'x');
    __resetSpoolForTests(path.join(blocker, 'spool'));

    const { checks } = await cutoverReadiness(serverConfig);
    expect(stateOf(checks, 'durableIngestion')).toBe('blocked');
    expect(analyticsDurabilityReadiness().ready).toBe(false);
  });
});

describe('runtime guards', () => {
  it('reports the Node runtime as supported on a runtime with ZSTD', () => {
    const support = parquetRuntimeSupport();
    expect(support.supported).toBe(true);
    expect(support.nodeVersion).toBe(process.version);
  });

  it('gates the nodeRuntime check on that same signal', async () => {
    const { checks } = await cutoverReadiness(serverConfig);
    expect(stateOf(checks, 'nodeRuntime')).toBe(parquetRuntimeSupport().supported ? 'ready' : 'blocked');
  });

  it('does NOT throw at import time — an old runtime must still boot', () => {
    // The module is already imported above. If it threw on load, this file
    // would not run at all; asserting the encoder is callable pins that the
    // check moved to the encode path rather than disappearing.
    expect(typeof writeParquet).toBe('function');
  });

  it('gates duckdbAvailable on the engine actually loading', async () => {
    const engine = await duckDbAvailability();
    const { checks } = await cutoverReadiness(serverConfig);
    expect(stateOf(checks, 'duckdbAvailable')).toBe(engine.available ? 'ready' : 'blocked');
  });

  it('reports a MISSING engine as a reason, never as a throw', async () => {
    const engine = await duckDbAvailability();
    if (engine.available === false) expect(engine.reason).toBeTruthy();
    else expect(engine.available).toBe(true);
  });
});

describe('disabled analytics storage', () => {
  it('blocks the checks that cannot mean anything while it is off', async () => {
    configure({ enabled: false });
    const { checks } = await cutoverReadiness(serverConfig);
    expect(stateOf(checks, 'historicalBackfill')).toBe('blocked');
    expect(stateOf(checks, 'workspaceDeletion')).toBe('blocked');
  });
});
