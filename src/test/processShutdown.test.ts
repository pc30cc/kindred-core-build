/**
 * The process's one answer to SIGTERM (server/services/jobs/processShutdown.ts).
 *
 * The invitation worker's own SIGTERM listener drained and returned, which
 * replaced Node's exit: the backend never exited on SIGTERM, and every
 * container replacement waited for the SIGKILL. Now every in-process loop
 * registers a drain, they run together within one bound, and the process
 * exits. Signals are never sent here: the drains are run directly, and the
 * listeners are only counted.
 */
import { describe, expect, it } from 'vitest';
import { onProcessShutdown, runShutdownDrains } from '../../server/services/jobs/processShutdown';

describe('process shutdown', () => {
  it('installs one SIGTERM and one SIGINT listener, however many drains register', () => {
    const term = process.listenerCount('SIGTERM');
    const int = process.listenerCount('SIGINT');
    onProcessShutdown('a', async () => undefined);
    onProcessShutdown('b', async () => undefined);
    onProcessShutdown('a', async () => undefined);
    expect(process.listenerCount('SIGTERM')).toBeLessThanOrEqual(term + 1);
    expect(process.listenerCount('SIGINT')).toBeLessThanOrEqual(int + 1);
  });

  it('runs every drain at once, and a failing one does not stop the others', async () => {
    const order: string[] = [];
    onProcessShutdown('slow', () => new Promise<void>((resolve) => setTimeout(() => { order.push('slow'); resolve(); }, 30)));
    onProcessShutdown('fast', async () => { order.push('fast'); });
    onProcessShutdown('broken', async () => { throw new Error('drain failed'); });
    expect(await runShutdownDrains(1_000)).toEqual({ timedOut: false });
    expect(order).toEqual(['fast', 'slow']);
  });

  it('the last drain (the HTTP server) starts only once the others have settled', async () => {
    const order: string[] = [];
    onProcessShutdown('http-test', async () => { order.push('http'); }, { last: true });
    onProcessShutdown('mail', () => new Promise<void>((resolve) => setTimeout(() => { order.push('mail'); resolve(); }, 30)));
    onProcessShutdown('ticker', async () => { order.push('ticker'); });
    expect(await runShutdownDrains(1_000)).toEqual({ timedOut: false });
    expect(order.indexOf('http')).toBe(order.length - 1);
    expect(order).toEqual(expect.arrayContaining(['mail', 'ticker', 'http']));
  });

  it('is bounded: a drain that never ends does not hold the exit', async () => {
    let closed = false;
    onProcessShutdown('http-test', async () => { closed = true; }, { last: true });
    onProcessShutdown('stuck', () => new Promise(() => undefined));
    const started = Date.now();
    expect(await runShutdownDrains(50)).toEqual({ timedOut: true });
    expect(Date.now() - started).toBeLessThan(1_000);
    // The listener is still closed before the exit.
    expect(closed).toBe(true);
  });
});
