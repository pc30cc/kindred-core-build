/**
 * Jobs a worker leaves behind and jobs it runs at once:
 *
 *  - ai_kb_jobs has no lease, so a worker killed mid-job (every redeploy of
 *    the Intelligence Worker) left the job `crawling`/`generating` forever.
 *    The worker now fails its in-flight jobs on SIGTERM, and fails any active
 *    job whose row went quiet past AI_KB_WORKER_STALE_MS.
 *  - A regression batch that threw on the scheduled path was never closed.
 *  - The interval-driven workers had no ceiling on concurrent jobs.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { InFlightJobs, settleWithin } from '../../../server/services/jobs/inFlight';
import { DbJobQueueProvider, AI_KB_ACTIVE_STATUSES } from '../../../server/services/ai-kb/queue';

type Call = { method: string; args: unknown[] };

function recordingClient(result: { data: unknown; error: unknown } = { data: [], error: null }) {
  const calls: Call[] = [];
  const b: Record<string, unknown> = {};
  for (const m of ['from', 'update', 'in', 'lt', 'eq', 'select']) {
    b[m] = (...args: unknown[]) => { calls.push({ method: m, args }); return b; };
  }
  b.then = (resolve: (r: unknown) => unknown) => resolve(result);
  return { client: b as never, calls };
}

describe('InFlightJobs', () => {
  it('fills at max, counting claims still in flight', () => {
    const slots = new InFlightJobs(2);
    const release = slots.reserve();
    slots.add('a');
    expect(slots.full).toBe(true);
    release();
    release(); // twice is harmless
    expect(slots.full).toBe(false);
    slots.add('b');
    expect(slots.full).toBe(true);
    expect(slots.ids()).toEqual(['a', 'b']);
    slots.delete('a');
    expect(slots.full).toBe(false);
    expect(slots.ids()).toEqual(['b']);
  });

  it('rejects a ceiling below one', () => {
    expect(() => new InFlightJobs(0)).toThrow();
  });

  it('settleWithin never hangs a shutdown on a dead database', async () => {
    vi.useFakeTimers();
    let done = false;
    const p = settleWithin(new Promise(() => {}), 5000).then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(4999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(done).toBe(true);
    vi.useRealTimers();
    await settleWithin(Promise.reject(new Error('db down')), 10);
  });
});

describe('AI KB Builder: abandoned jobs', () => {
  it('fails only active jobs whose row went quiet before the cutoff', async () => {
    const { client, calls } = recordingClient({ data: [{ id: 'j1' }, { id: 'j2' }], error: null });
    const q = new DbJobQueueProvider(client);
    const cutoff = new Date('2026-11-04T10:00:00Z');
    const ids = await q.failStaleJobs(cutoff, 'worker_lost');
    expect(ids).toEqual(['j1', 'j2']);
    const update = calls.find((c) => c.method === 'update')?.args[0] as Record<string, unknown>;
    expect(update.status).toBe('failed');
    expect(update.error_message).toBe('worker_lost');
    expect(calls).toContainEqual({ method: 'in', args: ['status', AI_KB_ACTIVE_STATUSES] });
    expect(calls).toContainEqual({ method: 'lt', args: ['updated_at', cutoff.toISOString()] });
    expect(AI_KB_ACTIVE_STATUSES).toEqual(['running', 'crawling', 'extracting', 'generating']);
  });

  it('a failed sweep reports the error instead of an empty success', async () => {
    const { client } = recordingClient({ data: null, error: { message: 'boom' } });
    await expect(new DbJobQueueProvider(client).failStaleJobs(new Date(), 'x')).rejects.toThrow('boom');
  });

  it('a shutdown fails its own in-flight jobs, and only while they are still active', async () => {
    const { client, calls } = recordingClient();
    await new DbJobQueueProvider(client).failActiveJobs(['j1'], 'worker_shutdown');
    expect(calls).toContainEqual({ method: 'in', args: ['id', ['j1']] });
    expect(calls).toContainEqual({ method: 'in', args: ['status', AI_KB_ACTIVE_STATUSES] });
    const none = recordingClient();
    await new DbJobQueueProvider(none.client).failActiveJobs([], 'worker_shutdown');
    expect(none.calls).toEqual([]);
  });

  it('the worker sweeps for abandoned jobs, caps its jobs and fails them on SIGTERM', () => {
    const src = readFileSync('worker/intelligence/index.ts', 'utf8');
    expect(src).toMatch(/staleSweep\.due\(\)\) await failAbandonedJobs\(queue\)/);
    expect(src).toMatch(/if \(inFlight\.full\) return true;/);
    expect(src).toMatch(/queue\.failActiveJobs\(abandoned,/);
  });
});

describe('regression worker', () => {
  it('closes a claimed batch that threw, whichever path claimed it, and never a cancelled one', () => {
    const src = readFileSync('worker/regression-runner/index.ts', 'utf8');
    expect(src).toMatch(/\.eq\('id', batchId\)\.eq\('status', 'running'\)/);
    expect(src).toMatch(/runClaimedBatch\(sb, config, batch\.id, 'scheduled', release\)/);
    expect(src).toMatch(/runClaimedBatch\(sb, config, id, 'queued', release\)/);
    expect(src).toMatch(/failClaimedBatch\(sb, id, `worker_shutdown/);
  });

  it('the SEO worker caps its concurrent jobs and takes the slot before claiming', () => {
    const src = readFileSync('worker/seo-crawler/index.ts', 'utf8');
    const tick = src.slice(src.indexOf('async function tick('));
    expect(tick.indexOf('inFlight >= MAX_CONCURRENT_JOBS')).toBeGreaterThan(-1);
    expect(tick.indexOf('inFlight++')).toBeLessThan(tick.indexOf('await claimNextJob('));
  });
});
