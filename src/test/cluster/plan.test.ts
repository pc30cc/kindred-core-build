// @vitest-environment node
/**
 * BACKEND_PROCESSES is read strictly, refused where cluster mode cannot
 * work, and DATABASE_POOL_MAX stays the container's total: the shares of the
 * workers' pools plus one cache-bus LISTEN each never pass P + 1
 * (server/cluster/plan.ts, docs/operations/BACKEND_PROCESSES.md).
 */
import { describe, expect, it } from 'vitest';
import { LEAD_MIN_POOL, maxProcessesFor, planCluster, poolShares } from '../../../server/cluster/plan.js';

const PG = { DATABASE_URL: 'postgres://u:p@db:5432/x', DATABASE_POOL_MAX: '15' };
const env = (extra: Record<string, string | undefined>) => ({ ...PG, ...extra }) as NodeJS.ProcessEnv;

describe('BACKEND_PROCESSES', () => {
  it.each([undefined, '', '   ', '1', ' 1 '])('%j runs one process and logs nothing', (value) => {
    const plan = planCluster(env({ BACKEND_PROCESSES: value }), 32);
    expect(plan.n).toBe(1);
    expect(plan.lines).toEqual([]);
    expect(plan.shares).toEqual([]);
  });

  it.each(['0', '-2', '2.5', 'abc', '17', '4x', 'auto', '1e1'])('%j runs one process and says why', (value) => {
    const plan = planCluster(env({ BACKEND_PROCESSES: value }), 32);
    expect(plan.n).toBe(1);
    expect(plan.lines).toEqual([
      `[cluster] BACKEND_PROCESSES=${value} is not a whole number from 1 to 16; running one process`,
    ]);
  });

  it('2 with DATABASE_POOL_MAX=15: pools 7+7, 16 connections at most, as one process', () => {
    const plan = planCluster(env({ BACKEND_PROCESSES: '2' }), 32);
    expect(plan).toMatchObject({ n: 2, roles: ['lead', 'follower'], shares: [7, 7], poolTotal: 15, ceiling: 16 });
    expect(plan.lines).toEqual([
      '[cluster] BACKEND_PROCESSES=2: w0 lead (HTTP + background loops), w1 HTTP. DATABASE_POOL_MAX=15 is the ' +
        "container's total: pools 7+7 + 2 cache-bus LISTEN = 16 connections at most (one process: 16)",
    ]);
  });

  it.each([
    ['3', [5, 4, 4]],
    ['4', [3, 3, 3, 3]],
    ['5', [3, 2, 2, 2, 2]],
    // The even split would leave the lead 2: it keeps 3, the followers split the rest.
    ['6', [3, 2, 2, 1, 1, 1]],
    ['7', [3, 1, 1, 1, 1, 1, 1]],
  ])('%s shares the pool %j, the remainder to the lead first', (value, shares) => {
    const plan = planCluster(env({ BACKEND_PROCESSES: value }), 32);
    expect(plan.shares).toEqual(shares);
    expect(plan.roles[0]).toBe('lead');
    expect(plan.roles.slice(1).every((r) => r === 'follower')).toBe(true);
  });

  it.each(['8', '9', '16'])('%s is lowered to 7, so the lead (HTTP and every loop) keeps a pool of 3 and the others 1', (value) => {
    const plan = planCluster(env({ BACKEND_PROCESSES: value }), 32);
    expect(plan.n).toBe(7);
    expect(plan.shares).toEqual([3, 1, 1, 1, 1, 1, 1]);
    expect(plan.lines[0]).toMatch(/lowered to 7/);
    expect(plan.ceiling).toBe(16);
  });

  it('shares always sum to P+1-N, the lead at least 3 and each other at least 1, so the container stays at P+1', () => {
    expect(maxProcessesFor(4)).toBe(1);
    expect(maxProcessesFor(5)).toBe(2);
    expect(maxProcessesFor(15)).toBe(7);
    for (let p = 5; p <= 40; p++) {
      for (let n = 2; n <= maxProcessesFor(p); n++) {
        const shares = poolShares(p, n);
        expect(shares.length).toBe(n);
        expect(shares.reduce((a, b) => a + b, 0)).toBe(p + 1 - n);
        expect(shares[0]).toBeGreaterThanOrEqual(LEAD_MIN_POOL);
        expect(Math.min(...shares)).toBeGreaterThanOrEqual(1);
        expect(shares[0]).toBe(Math.max(...shares));
        // Pools plus one LISTEN each.
        expect(shares.reduce((a, b) => a + b, 0) + n).toBe(p + 1);
      }
    }
  });

  it('the default pool (DATABASE_POOL_MAX unset, 10) is the total too', () => {
    const plan = planCluster({ DATABASE_URL: PG.DATABASE_URL, BACKEND_PROCESSES: '2' } as NodeJS.ProcessEnv, 32);
    expect(plan).toMatchObject({ n: 2, shares: [5, 4], ceiling: 11 });
  });

  it.each(['2', '4'])('DATABASE_POOL_MAX=%s, too small for a lead of 3 and a second process, is refused', (pool) => {
    const plan = planCluster(env({ BACKEND_PROCESSES: '2', DATABASE_POOL_MAX: pool }), 32);
    expect(plan.n).toBe(1);
    expect(plan.lines[0]).toMatch(/refused: .*it needs at least 5: the lead keeps 3/);
    expect(planCluster(env({ BACKEND_PROCESSES: '2', DATABASE_POOL_MAX: '5' }), 32).shares).toEqual([3, 1]);
  });

  it('supabase-rest is refused: the cache bus does not reach other processes there', () => {
    const plan = planCluster({ BACKEND_PROCESSES: '2' } as NodeJS.ProcessEnv, 32);
    expect(plan.n).toBe(1);
    expect(plan.lines[0]).toMatch(/refused: the database mode is supabase-rest/);
  });

  it.each([
    'AI_SOURCE_SYNC_WORKER_INPROC',
    'AI_KB_WORKER_INPROC',
    'AI_KB_INTELLIGENCE_WORKER_INPROC',
    'AI_AGENT_REGRESSION_WORKER_INPROC',
  ])('%s=1 is refused', (flag) => {
    const plan = planCluster(env({ BACKEND_PROCESSES: '2', [flag]: '1' }), 32);
    expect(plan.n).toBe(1);
    expect(plan.lines[0]).toContain(`${flag}=1`);
  });

  it('an invalid DATABASE_POOL_MAX or DATABASE_MODE is left to index.ts (one process)', () => {
    expect(planCluster(env({ BACKEND_PROCESSES: '2', DATABASE_POOL_MAX: 'ten' }), 32)).toMatchObject({ n: 1, poolTotal: null });
    expect(planCluster(env({ BACKEND_PROCESSES: '2', DATABASE_MODE: 'nope' }), 32).n).toBe(1);
  });

  it('more processes than CPUs still start, with a warning naming both numbers', () => {
    const plan = planCluster(env({ BACKEND_PROCESSES: '4' }), 2);
    expect(plan.n).toBe(4);
    expect(plan.lines[0]).toBe('[cluster] warning: 4 processes on 2 CPU(s) Node sees; they will share cores');
  });
});
